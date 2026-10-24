<?php
declare(strict_types=1);

final class AuthService
{
    /** Minimum password length for new and changed passwords. */
    public const MIN_PASSWORD = 12;

    /** Attempts on one account from one address in the window. */
    private const MAX_ATTEMPTS_PER_ACCOUNT = 8;
    /**
     * Attempts on one account from everywhere. Higher, so someone guessing
     * from elsewhere cannot lock the owner out with a handful of tries, while
     * a guesser spread over many addresses is still capped.
     */
    private const MAX_ATTEMPTS_PER_ACCOUNT_ANYWHERE = 40;
    private const MAX_ATTEMPTS_PER_IP = 25;
    private const WINDOW_SECONDS = 900; // 15 minutes

    /**
     * "Stay signed in". A PHP session ends when its file is collected (on
     * Debian a cron job does that after about 24 minutes idle, whatever the
     * app configures), so staying signed in cannot rest on the session. At
     * sign-in the browser also gets this cookie: selector.validator, where the
     * database keeps only a SHA-256 of the validator. A request without a
     * session but with a valid cookie gets a fresh session for that user.
     * 400 days is the longest a browser keeps a cookie; every use renews it.
     */
    public const REMEMBER_COOKIE = 'rk_remember';
    private const REMEMBER_SECONDS = 400 * 86400;
    /** Renew the stored expiry at most this often (not on every poll). */
    private const REMEMBER_TOUCH_SECONDS = 86400;

    public function __construct(private StorageInterface $store) {}

    /** @return array<string,mixed>|null */
    public function currentUser(): ?array
    {
        $uid = $_SESSION['uid'] ?? null;
        if (!$uid) {
            return $this->resumeFromCookie();
        }
        $u = $this->store->find('users', (string)$uid);
        if (!$u) {
            // The account was deleted while the session was alive.
            $this->logout();
            return null;
        }
        // A password change elsewhere invalidates every other session.
        if (($_SESSION['pwstamp'] ?? null) !== self::passwordStamp($u)) {
            $this->logout();
            return null;
        }
        return $u;
    }

    /**
     * Verify credentials and start an authenticated session.
     *
     * @return array<string,mixed>
     */
    public function login(string $username, string $password): array
    {
        $username = strtolower(trim($username));
        $ip = Security::clientIp();

        $waitIp = $this->store->throttle('login_ip', $ip, self::MAX_ATTEMPTS_PER_IP, self::WINDOW_SECONDS);
        $waitUser = $this->store->throttle('login_user_ip', $username . '|' . $ip, self::MAX_ATTEMPTS_PER_ACCOUNT, self::WINDOW_SECONDS);
        $waitAll = $this->store->throttle('login_user', $username, self::MAX_ATTEMPTS_PER_ACCOUNT_ANYWHERE, self::WINDOW_SECONDS);
        $wait = max($waitIp, $waitUser, $waitAll);
        if ($wait > 0) {
            throw new RuntimeException(
                'Too many sign-in attempts. Try again in ' . ceil($wait / 60) . ' minute(s).',
                429
            );
        }

        // One indexed row rather than every account in the system.
        $match = $this->store->findUserByUsername($username);

        // Always spend time on a hash so a missing account and a wrong
        // password take the same path — no timing-based user enumeration.
        $hash = (string)($match['passwordHash'] ?? '$2y$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
        $ok = password_verify($password, $hash);

        if (!$match || !$ok) {
            throw new RuntimeException('Invalid credentials.', 401);
        }

        $this->store->clearThrottle('login_user', $username);
        $this->store->clearThrottle('login_ip', $ip);

        $this->signIn($match);
        return $match;
    }

    /**
     * Start a signed-in session for a user whose identity is already proven:
     * by password (login), or by a one-time email link (a new password, an
     * accepted invitation). A new session id, so a fixated one is worthless,
     * a new CSRF token, and a remembered device.
     */
    public function signIn(array $user): void
    {
        session_regenerate_id(true);
        $_SESSION['uid'] = $user['id'];
        $_SESSION['pwstamp'] = self::passwordStamp($user);
        Security::rotateCsrfToken();
        $this->forgetDevice();
        $this->remember($user);
    }

    public function logout(): void
    {
        $this->forgetDevice();
        $_SESSION = [];
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_regenerate_id(true);
        }
    }

    /** Change your own password; requires the current one. */
    public function changeOwnPassword(array $user, string $current, string $next): array
    {
        if (!password_verify($current, (string)($user['passwordHash'] ?? ''))) {
            throw new RuntimeException('Current password is incorrect.', 403);
        }
        self::assertPasswordPolicy($next, (string)$user['username']);
        if (password_verify($next, (string)($user['passwordHash'] ?? ''))) {
            throw new RuntimeException('The new password must differ from the current one.', 400);
        }
        $user['passwordHash'] = password_hash($next, PASSWORD_DEFAULT);
        $user['mustChangePassword'] = false;
        $user['passwordChangedAt'] = Helpers::now();
        $this->store->save('users', $user);
        // Keep this session valid, drop every other one. The remembered
        // devices were issued under the old password, so they stop working;
        // this device gets a new one.
        $_SESSION['pwstamp'] = self::passwordStamp($user);
        session_regenerate_id(true);
        Security::rotateCsrfToken();
        $this->forgetDevice();
        $this->remember($user);
        return $user;
    }

    /** Issue a "stay signed in" token for this browser. */
    private function remember(array $user): void
    {
        try {
            $selector = bin2hex(random_bytes(12));
            $validator = random_bytes(32);
            $expires = time() + self::REMEMBER_SECONDS;
            $this->store->saveAuthToken($selector, (string)$user['id'], hash('sha256', $validator), self::passwordStamp($user), $expires);
            if ($this->store->findAuthToken($selector) === null) {
                return; // schema not upgraded yet: session-only sign-in
            }
            self::setRememberCookie($selector . '.' . rtrim(strtr(base64_encode($validator), '+/', '-_'), '='), $expires);
        } catch (Throwable $e) {
            // Sign-in still works; only staying signed in is lost.
            error_log('Royal Tasks: could not issue a remember token: ' . $e->getMessage());
        }
    }

    /** Remove this browser's token, server side and cookie. */
    private function forgetDevice(): void
    {
        $parsed = self::parseRememberCookie();
        if ($parsed !== null) {
            try {
                $this->store->deleteAuthToken($parsed[0]);
            } catch (Throwable) {
                // The cookie is cleared regardless.
            }
        }
        if (isset($_COOKIE[self::REMEMBER_COOKIE])) {
            self::setRememberCookie('', 1);
            unset($_COOKIE[self::REMEMBER_COOKIE]);
        }
    }

    /**
     * No session: sign in from the remember cookie if it is valid. Anything
     * wrong (unknown, expired, wrong validator, account gone, password changed
     * since) removes the token and the cookie and leaves the visitor signed out.
     *
     * @return array<string,mixed>|null
     */
    private function resumeFromCookie(): ?array
    {
        $parsed = self::parseRememberCookie();
        if ($parsed === null) {
            if (isset($_COOKIE[self::REMEMBER_COOKIE])) {
                $this->forgetDevice();
            }
            return null;
        }
        [$selector, $validator] = $parsed;
        try {
            $row = $this->store->findAuthToken($selector);
        } catch (Throwable) {
            return null;
        }
        $user = null;
        $valid = $row !== null
            && $row['expiresAt'] > time()
            && hash_equals($row['validatorHash'], hash('sha256', $validator));
        if ($valid) {
            $user = $this->store->find('users', $row['userId']);
            $valid = $user !== null && hash_equals($row['pwStamp'], self::passwordStamp($user));
        }
        if (!$valid) {
            $this->forgetDevice();
            return null;
        }
        // A fresh session under a new id, as at a password sign-in.
        session_regenerate_id(true);
        $_SESSION['uid'] = $user['id'];
        $_SESSION['pwstamp'] = self::passwordStamp($user);
        Security::rotateCsrfToken();
        if (time() - $row['lastUsedAt'] > self::REMEMBER_TOUCH_SECONDS) {
            $expires = time() + self::REMEMBER_SECONDS;
            try {
                $this->store->touchAuthToken($selector, $expires);
                self::setRememberCookie((string)$_COOKIE[self::REMEMBER_COOKIE], $expires);
            } catch (Throwable) {
                // Still signed in for this session; the renewal waits.
            }
        }
        return $user;
    }

    /** @return array{0:string,1:string}|null selector and raw validator */
    private static function parseRememberCookie(): ?array
    {
        $raw = (string)($_COOKIE[self::REMEMBER_COOKIE] ?? '');
        if (!preg_match('/^([a-f0-9]{24}).([A-Za-z0-9_-]{43})$/', $raw, $m)) {
            return null;
        }
        $validator = base64_decode(strtr($m[2], '-_', '+/') . '=', true);
        return ($validator === false || strlen($validator) !== 32) ? null : [$m[1], $validator];
    }

    private static function setRememberCookie(string $value, int $expires): void
    {
        if (headers_sent()) {
            return;
        }
        setcookie(self::REMEMBER_COOKIE, $value, [
            'expires' => $expires,
            'path' => Security::cookiePath(),
            'secure' => Security::isHttps(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }

    /** @return array<string,mixed> */
    public function requireUser(): array
    {
        $u = $this->currentUser();
        if (!$u) {
            Helpers::fail('Not authenticated.', 401);
        }
        return $u;
    }

    /**
     * Authenticated and allowed to do more than change their password.
     * @return array<string,mixed>
     */
    public function requireActiveUser(): array
    {
        $u = $this->requireUser();
        if (!empty($u['mustChangePassword'])) {
            Helpers::fail('Set a new password before continuing.', 403, ['mustChangePassword' => true]);
        }
        return $u;
    }

    /** @return array<string,mixed> */
    public function requireAdmin(): array
    {
        $u = $this->requireActiveUser();
        if (($u['role'] ?? '') !== 'admin') {
            Helpers::fail('Admin only.', 403);
        }
        return $u;
    }

    public static function assertPasswordPolicy(string $password, string $username = ''): void
    {
        if (strlen($password) < self::MIN_PASSWORD) {
            throw new RuntimeException('Password must be at least ' . self::MIN_PASSWORD . ' characters.', 400);
        }
        if (strlen($password) > 4096) {
            throw new RuntimeException('Password is too long.', 400);
        }
        if ($username !== '' && stripos($password, $username) !== false) {
            throw new RuntimeException('Password must not contain the username.', 400);
        }
        $weak = ['password', 'admin123', '123456789012', 'qwertyuiop', 'royalkanban'];
        foreach ($weak as $w) {
            if (stripos($password, $w) !== false) {
                throw new RuntimeException('That password is too easy to guess.', 400);
            }
        }
    }

    /**
     * Create the first administrator.
     *
     * Called only by install.php, which the operator runs deliberately. There
     * is no automatic seeding on first request any more: the master account
     * is part of installation, and nothing sensitive is written to disk — the
     * generated password is shown once and then only its hash exists.
     *
     * @return array{user:array<string,mixed>,password:string}|null null when
     *         an account already exists
     */
    public function createMasterUser(string $username, ?string $password, string $displayName): ?array
    {
        if ($this->store->count('users') > 0) {
            return null;
        }
        $generated = false;
        if ($password === null || $password === '') {
            $password = self::generatePassword();
            $generated = true;
        }
        if (!$generated) {
            self::assertPasswordPolicy($password, $username);
        }
        $user = $this->store->save('users', [
            'id' => Helpers::newId('u_'),
            'username' => mb_strtolower(trim($username)),
            'displayName' => $displayName !== '' ? $displayName : $username,
            'role' => 'admin',
            'passwordHash' => password_hash($password, PASSWORD_DEFAULT),
            // Whoever set it, the first sign-in must replace it.
            'mustChangePassword' => true,
            'createdAt' => Helpers::now(),
        ]);
        return ['user' => $user, 'password' => $password];
    }

    public static function generatePassword(int $length = 24): string
    {
        // Ambiguous characters left out so the password can be retyped.
        $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_';
        $max = strlen($alphabet) - 1;
        $out = '';
        for ($i = 0; $i < $length; $i++) {
            $out .= $alphabet[random_int(0, $max)];
        }
        return $out;
    }

    /** Fingerprint of the stored hash, used to invalidate other sessions. */
    private static function passwordStamp(array $user): string
    {
        return substr(hash('sha256', (string)($user['passwordHash'] ?? '')), 0, 32);
    }
}
