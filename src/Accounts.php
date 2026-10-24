<?php
declare(strict_types=1);

/**
 * Accounts by email: invitations, password links, and the settings an
 * administrator keeps for them.
 *
 * A link carries a random token (32 bytes); the server stores only its
 * SHA-256, with the address sealed, an expiry, and a "used" mark that one
 * UPDATE sets (useEmailLink), so a link works once even if two requests race.
 * The token travels in the address's fragment (#invite=, #reset=), which the
 * browser never sends to the server or in a Referer; the page posts it.
 *
 * The site's address in the links comes from the settings (saved by an
 * administrator), never from the request: a forged Host header must not be
 * able to send someone a reset link that points elsewhere.
 */
final class Accounts
{
    public const INVITE_TTL = 7 * 86400;
    public const RESET_TTL = 3600;          // asked for on the sign-in page
    public const ADMIN_RESET_TTL = 86400;   // sent by an administrator

    /** Settings and their defaults. */
    public const DEFAULTS = [
        'allow_forgot' => '1',       // "Forgot your password?" on the sign-in page
        'allow_admin_reset' => '1',  // an administrator may email a user a password link
        'app_url' => '',             // the site's address, for the links
    ];

    public function __construct(private StorageInterface $store) {}

    /** @return array{allowForgot:bool,allowAdminReset:bool,appUrl:string} */
    public function settings(): array
    {
        $s = $this->store->settings() + self::DEFAULTS;
        return [
            'allowForgot' => $s['allow_forgot'] === '1',
            'allowAdminReset' => $s['allow_admin_reset'] === '1',
            'appUrl' => (string)$s['app_url'],
        ];
    }

    public function saveSettings(bool $allowForgot, bool $allowAdminReset, string $appUrl): array
    {
        $this->store->saveSetting('allow_forgot', $allowForgot ? '1' : '0');
        $this->store->saveSetting('allow_admin_reset', $allowAdminReset ? '1' : '0');
        $url = self::cleanAppUrl($appUrl);
        if ($url !== null) {
            $this->store->saveSetting('app_url', $url);
        }
        return $this->settings();
    }

    /**
     * The site's address as an administrator's browser saw it (http(s), host,
     * path to the app's folder), or null when it is not one.
     */
    public static function cleanAppUrl(string $url): ?string
    {
        $url = trim($url);
        $p = parse_url($url);
        if (!$p || !in_array(strtolower($p['scheme'] ?? ''), ['http', 'https'], true) || empty($p['host'])
            || isset($p['user']) || isset($p['pass']) || isset($p['query']) || isset($p['fragment'])) {
            return null;
        }
        $path = (string)($p['path'] ?? '/');
        $path = preg_replace('#/[^/]*\.(html|php)$#i', '/', $path) ?? '/';
        if (!str_ends_with($path, '/')) {
            $path .= '/';
        }
        return strtolower($p['scheme']) . '://' . strtolower($p['host']) . (isset($p['port']) ? ':' . (int)$p['port'] : '') . $path;
    }

    /** An admin's action that sends a link: remember the site's address if none is saved yet. */
    public function learnAppUrl(string $fromAdminBrowser): void
    {
        if ($this->settings()['appUrl'] === '' && ($u = self::cleanAppUrl($fromAdminBrowser)) !== null) {
            $this->store->saveSetting('app_url', $u);
        }
    }

    public function mailer(): Mailer
    {
        return Mailer::fromConfig((string)(parse_url($this->settings()['appUrl'], PHP_URL_HOST) ?? ''));
    }

    /** Whether "Forgot your password?" can be offered: allowed, an address to link to, mail that can go out. */
    public function canForgot(): bool
    {
        if (!$this->store->hasAccounts()) {
            return false;
        }
        $s = $this->settings();
        return $s['allowForgot'] && $s['appUrl'] !== '' && $this->mailer()->configured();
    }

    private function link(string $kind, string $token): string
    {
        $base = $this->settings()['appUrl'];
        if ($base === '') {
            throw new RuntimeException('The site address is not known yet: open the admin settings once and save them.', 503);
        }
        return $base . '#' . $kind . '=' . $token;
    }

    // ---- invitations ---------------------------------------------------

    /** Invite someone by email to make an account. */
    public function invite(array $admin, string $email, string $name, string $role): void
    {
        $email = trim($email);
        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false || strlen($email) > 254) {
            throw new RuntimeException('That is not an email address.', 400);
        }
        if ($this->store->findUserByEmail($email) !== null) {
            throw new RuntimeException('Someone already has an account with that address.', 409);
        }
        $token = Calendar::newToken();
        $hash = Calendar::hash($token);
        $this->store->saveEmailLink($hash, 'invite', null, $email, trim($name), $role === 'admin' ? 'admin' : 'user',
            (string)$admin['id'], time() + self::INVITE_TTL);
        $who = (string)($admin['displayName'] ?? $admin['username']);
        try {
            $this->mailer()->send($email, 'You are invited to Royal Tasks',
                "Hello" . (trim($name) !== '' ? ' ' . trim($name) : '') . ",\n\n"
                . "$who has invited you to Royal Tasks, a place for boards, cards and checklists.\n\n"
                . "Make your account here (the link works once, for 7 days):\n\n"
                . $this->link('invite', $token) . "\n\n"
                . "If you did not expect this, you can ignore it.\n");
        } catch (RuntimeException $e) {
            // An invitation nobody received is no use: take it back.
            $this->store->deleteEmailLink($hash);
            throw new RuntimeException('The invitation could not be sent: ' . $e->getMessage(), 502);
        }
    }

    /** Make the account an invitation is for, and return it (the caller signs it in). */
    public function acceptInvite(string $token, string $username, string $displayName, string $password): array
    {
        $link = $this->validLink($token, 'invite');
        $username = strtolower(trim($username));
        if (!preg_match('/^[a-z0-9_\-]{2,40}$/', $username)) {
            throw new RuntimeException('A username is 2–40 characters: a–z, 0–9, _ and -.', 400);
        }
        AuthService::assertPasswordPolicy($password, $username);
        if ($this->store->findUserByUsername($username) !== null) {
            throw new RuntimeException('That username is taken. Choose another.', 409);
        }
        if ($this->store->findUserByEmail($link['email']) !== null) {
            throw new RuntimeException('Someone already has an account with this address.', 409);
        }
        // Spent before the account exists: of two racing requests, one wins.
        if (!$this->store->useEmailLink($link['tokenHash'])) {
            throw new RuntimeException('This link has been used or has expired.', 410);
        }
        $displayName = trim($displayName) !== '' ? trim($displayName) : ($link['name'] !== '' ? $link['name'] : $username);
        return $this->store->save('users', [
            'id' => Helpers::newId('u_'),
            'username' => $username,
            'displayName' => mb_substr($displayName, 0, 80),
            'role' => $link['role'] === 'admin' ? 'admin' : 'user',
            'passwordHash' => password_hash($password, PASSWORD_DEFAULT),
            'mustChangePassword' => false,
            'passwordChangedAt' => Helpers::now(),
            'email' => $link['email'],
            'createdAt' => Helpers::now(),
        ]);
    }

    /** @return array<int,array{id:string,email:string,name:string,role:string,createdAt:string,expiresAt:string}> */
    public function pendingInvites(): array
    {
        return array_map(fn($i) => [
            'id' => $i['tokenHash'],
            'email' => $i['email'],
            'name' => $i['name'],
            'role' => $i['role'],
            'createdAt' => $i['createdAt'],
            'expiresAt' => gmdate('c', $i['expiresAt']),
        ], $this->store->pendingInvites());
    }

    public function revokeInvite(string $id): void
    {
        $link = $this->store->findEmailLink($id);
        if ($link && $link['kind'] === 'invite') {
            $this->store->deleteEmailLink($id);
        }
    }

    // ---- password links ------------------------------------------------

    /**
     * "Forgot your password?": a link to the account's email, if it has one.
     * Silent either way (the caller answers the same whatever happened), so
     * the page cannot be used to learn which names or addresses exist.
     */
    public function forgot(string $login): void
    {
        if (!$this->canForgot()) {
            return;
        }
        $login = trim($login);
        $user = str_contains($login, '@') ? $this->store->findUserByEmail($login) : $this->store->findUserByUsername($login);
        if (!$user || trim((string)($user['email'] ?? '')) === '') {
            return;
        }
        // At most three links an hour for one account, whoever asks.
        if ($this->store->throttle('reset_user', (string)$user['id'], 3, 3600) > 0) {
            return;
        }
        $this->sendReset($user, self::RESET_TTL,
            "Someone, hopefully you, asked to reset the password for your Royal Tasks account \"{$user['username']}\".\n\n"
            . "Sign in and choose a new password here (the link works once, for an hour):\n\n%s\n\n"
            . "If it was not you, ignore this email: your password stays as it is.\n", false, true);
    }

    /**
     * Run `$job` once the response has gone out (PHP-FPM's
     * fastcgi_finish_request), so its time does not show in the answer.
     * Elsewhere it runs at the end of the request, before the response is
     * complete.
     */
    private static function afterResponse(callable $job): void
    {
        register_shutdown_function(static function () use ($job): void {
            if (function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            }
            try {
                $job();
            } catch (Throwable $e) {
                error_log('Royal Tasks: ' . $e->getMessage());
            }
        });
    }

    /** An administrator sends a user a link to set a new password. */
    public function adminReset(array $admin, string $userId): string
    {
        if (!$this->settings()['allowAdminReset']) {
            throw new RuntimeException('Password links from administrators are turned off in the admin settings.', 403);
        }
        $user = $this->store->find('users', $userId);
        if (!$user) {
            throw new RuntimeException('User not found.', 404);
        }
        $email = trim((string)($user['email'] ?? ''));
        if ($email === '') {
            throw new RuntimeException('This user has no email address in their profile.', 400);
        }
        $who = (string)($admin['displayName'] ?? $admin['username']);
        $this->sendReset($user, self::ADMIN_RESET_TTL,
            "$who, an administrator of Royal Tasks, sent you a link to set a new password for your account \"{$user['username']}\".\n\n"
            . "Sign in and choose a new password here (the link works once, for 24 hours):\n\n%s\n\n"
            . "Your current password keeps working until you do.\n", true);
        return $email;
    }

    private function sendReset(array $user, int $ttl, string $body, bool $loud = false, bool $later = false): void
    {
        $token = Calendar::newToken();
        $hash = Calendar::hash($token);
        // One live link per account: a new one replaces any before it.
        $this->store->deleteResetLinksFor((string)$user['id']);
        $this->store->saveEmailLink($hash, 'reset', (string)$user['id'], (string)$user['email'], '', 'user', null, time() + $ttl);
        if ($later) {
            $mailer = $this->mailer();
            $to = (string)$user['email'];
            $text = sprintf($body, $this->link('reset', $token));
            $store = $this->store;
            self::afterResponse(static function () use ($mailer, $to, $text, $store, $hash): void {
                try {
                    $mailer->send($to, 'Royal Tasks: set a new password', $text);
                } catch (RuntimeException $e) {
                    $store->deleteEmailLink($hash);
                    error_log('Royal Tasks: a password link could not be sent: ' . $e->getMessage());
                }
            });
            return;
        }
        try {
            $this->mailer()->send((string)$user['email'], 'Royal Tasks: set a new password', sprintf($body, $this->link('reset', $token)));
        } catch (RuntimeException $e) {
            $this->store->deleteEmailLink($hash);
            if ($loud) {
                throw new RuntimeException('The email could not be sent: ' . $e->getMessage(), 502);
            }
            error_log('Royal Tasks: a password link could not be sent: ' . $e->getMessage());
        }
    }

    /** Set the new password a link was for, and return the user (the caller signs them in). */
    public function completeReset(string $token, string $password): array
    {
        $link = $this->validLink($token, 'reset');
        $user = $link['userId'] !== null ? $this->store->find('users', $link['userId']) : null;
        if (!$user) {
            throw new RuntimeException('This link has been used or has expired.', 410);
        }
        AuthService::assertPasswordPolicy($password, (string)$user['username']);
        if (!$this->store->useEmailLink($link['tokenHash'])) {
            throw new RuntimeException('This link has been used or has expired.', 410);
        }
        $user['passwordHash'] = password_hash($password, PASSWORD_DEFAULT);
        $user['mustChangePassword'] = false;
        $user['passwordChangedAt'] = Helpers::now();
        $this->store->save('users', $user);
        $this->store->deleteResetLinksFor((string)$user['id']);
        return $user;
    }

    /**
     * What a link is for, for the page that opens it: the kind, and for an
     * invitation the address and a suggested username; for a password link
     * the username. Any link that will not work answers the same.
     *
     * @return array{kind:string,email?:string,name?:string,username?:string}
     */
    public function linkInfo(string $token): array
    {
        $link = $this->validLink($token, null);
        if ($link['kind'] === 'invite') {
            $suggest = strtolower(preg_replace('/[^a-z0-9_\-]/i', '', strstr($link['email'], '@', true) ?: '') ?? '');
            return ['kind' => 'invite', 'email' => $link['email'], 'name' => $link['name'], 'username' => substr($suggest, 0, 40)];
        }
        $user = $link['userId'] !== null ? $this->store->find('users', $link['userId']) : null;
        if (!$user) {
            throw new RuntimeException('This link has been used or has expired.', 410);
        }
        return ['kind' => 'reset', 'username' => (string)$user['username']];
    }

    /** The link a token is for, unused and unexpired, of the given kind. */
    private function validLink(string $token, ?string $kind): array
    {
        if (!Calendar::looksLikeToken($token) || !$this->store->hasAccounts()) {
            throw new RuntimeException('This link has been used or has expired.', 410);
        }
        $link = $this->store->findEmailLink(Calendar::hash($token));
        if (!$link || $link['usedAt'] !== null || $link['expiresAt'] < time() || ($kind !== null && $link['kind'] !== $kind)) {
            throw new RuntimeException('This link has been used or has expired.', 410);
        }
        return $link;
    }
}
