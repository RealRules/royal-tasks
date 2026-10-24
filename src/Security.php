<?php
declare(strict_types=1);

/**
 * Request-level security: session hardening, CSRF, response headers and
 * same-origin checks. Every entry point under api/ starts here.
 */
final class Security
{
    public const SESSION_NAME = 'royal_kanban';

    /** Actions that may be reached with GET (they must not change state). */
    private const READ_ONLY_ACTIONS = ['me', 'poll', 'list_boards', 'list_users', 'get_inbox', 'get_board_key', 'preview_delete_user', 'calendar_settings', 'calendar_names', 'admin_settings'];

    /** Actions usable before authentication (no CSRF token available yet). */
    private const PRE_AUTH_ACTIONS = ['me', 'login'];

    private static bool $started = false;

    /**
     * Start a hardened session. Cookie flags are set before the session
     * exists, which is the only point at which PHP will honour them.
     */
    public static function startSession(): void
    {
        if (self::$started || session_status() === PHP_SESSION_ACTIVE) {
            self::$started = true;
            return;
        }
        session_name(self::SESSION_NAME);
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => self::cookiePath(),
            'httponly' => true,   // JS cannot read the session id
            'secure' => self::isHttps(),
            'samesite' => 'Lax',  // blocks cross-site POST; allows PWA share launches
        ]);
        session_start();
        self::$started = true;
    }

    public static function isHttps(): bool
    {
        if (($_SERVER['HTTPS'] ?? '') !== '' && strtolower((string)$_SERVER['HTTPS']) !== 'off') {
            return true;
        }
        if (((int)($_SERVER['SERVER_PORT'] ?? 0)) === 443) {
            return true;
        }
        // Behind a TLS-terminating proxy the request arrives as plain HTTP, so
        // the cookie would silently lose its Secure flag. Only when the
        // deployment has declared a trusted proxy (RK_TRUST_PROXY) is the
        // forwarded header believed.
        if (defined('RK_TRUST_PROXY') && RK_TRUST_PROXY) {
            $proto = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
            if ($proto === 'https') {
                return true;
            }
        }
        return false;
    }

    /**
     * Scope the cookie to the app folder, not the whole host.
     *
     * The entry points sit at two depths: install.php is at the app root
     * ("/kanban/install.php") while the API lives one level in
     * ("/kanban/api/index.php"). The cookie has to cover both, so the path is
     * the app root — the entry point's directory, minus a trailing "api"
     * segment. The old code took two dirnames, which for a subfolder install
     * scoped the cookie to "/" and shared it with every other app on the host.
     */
    public static function cookiePath(): string
    {
        $script = (string)($_SERVER['SCRIPT_NAME'] ?? '/');
        $dir = rtrim(str_replace('\\', '/', dirname($script)), '/');
        // From api/ (or any nested entry point), step up to the app root.
        if (str_ends_with($dir, '/api')) {
            $dir = substr($dir, 0, -4);
        }
        $dir = rtrim($dir, '/');
        return $dir === '' ? '/' : $dir . '/';
    }

    /** Security headers for every response we control. */
    public static function sendHeaders(string $csp): void
    {
        header('X-Frame-Options: DENY');
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: same-origin');
        header('Cross-Origin-Opener-Policy: same-origin');
        header('Cross-Origin-Resource-Policy: same-origin');
        header('Permissions-Policy: geolocation=(), microphone=(), camera=(), interest-cohort=()');
        header('Content-Security-Policy: ' . $csp);
        if (self::isHttps()) {
            header('Strict-Transport-Security: max-age=31536000');
        }
    }

    // ---------------- CSRF ----------------

    public static function csrfToken(): string
    {
        if (empty($_SESSION['csrf'])) {
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
        }
        return (string)$_SESSION['csrf'];
    }

    /** Issue a fresh token; call whenever the session identity changes. */
    public static function rotateCsrfToken(): string
    {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        return (string)$_SESSION['csrf'];
    }

    public static function isReadOnlyAction(string $action): bool
    {
        return in_array($action, self::READ_ONLY_ACTIONS, true);
    }

    /**
     * Enforce the request-method and CSRF policy.
     *
     * State-changing actions must be POST and must carry the session's CSRF
     * token in the X-CSRF-Token header. Because the token lives in the
     * session and never in a cookie, a cross-site page cannot read it.
     */
    public static function enforce(string $action): void
    {
        $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

        if ($method === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
        if (self::isReadOnlyAction($action)) {
            if ($method !== 'GET' && $method !== 'HEAD') {
                Helpers::fail('This action must use GET.', 405);
            }
            return;
        }
        // Everything else changes state.
        if ($method !== 'POST') {
            Helpers::fail('This action must use POST.', 405);
        }
        self::assertSameOrigin();
        if (in_array($action, self::PRE_AUTH_ACTIONS, true)) {
            return;
        }
        $sent = (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
        $known = (string)($_SESSION['csrf'] ?? '');
        if ($sent === '' || $known === '' || !hash_equals($known, $sent)) {
            Helpers::fail('Invalid or missing CSRF token. Reload the page and try again.', 403);
        }
    }

    /**
     * Defence in depth behind the CSRF token: reject requests whose Origin
     * (or Referer) belongs to another site. A missing Origin is allowed so
     * that non-browser clients and PWA share launches keep working.
     */
    public static function assertSameOrigin(): void
    {
        $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
        if ($origin === '' || $origin === 'null') {
            $referer = (string)($_SERVER['HTTP_REFERER'] ?? '');
            if ($referer === '') {
                return;
            }
            $origin = (string)(parse_url($referer, PHP_URL_SCHEME) . '://' . parse_url($referer, PHP_URL_HOST))
                . (parse_url($referer, PHP_URL_PORT) ? ':' . parse_url($referer, PHP_URL_PORT) : '');
        }
        if (!hash_equals(self::selfOrigin(), $origin)) {
            Helpers::fail('Cross-origin request refused.', 403);
        }
    }

    public static function selfOrigin(): string
    {
        $scheme = self::isHttps() ? 'https' : 'http';
        $host = (string)($_SERVER['HTTP_HOST'] ?? 'localhost');
        return $scheme . '://' . $host;
    }

    // ---------------- request identity ----------------

    /**
     * The address to attribute this request to.
     *
     * Behind a trusted proxy every request shares the proxy's address, so the
     * per-IP login limit would count them together — one attacker could lock
     * everyone out. When RK_TRUST_PROXY is set, X-Forwarded-For is consulted.
     *
     * The **rightmost** entry is used, not the leftmost: a proxy appends the
     * address it observed, so everything to the left of that is whatever the
     * client sent. Taking the first entry let an attacker put a fresh fake IP
     * on every request and never trip the per-IP limit. If you run more than
     * one proxy, set RK_TRUSTED_PROXIES to the number of trusted hops and the
     * address that many from the right is taken instead.
     */
    public static function clientIp(): string
    {
        $remote = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
        if (!defined('RK_TRUST_PROXY') || !RK_TRUST_PROXY) {
            return $remote;
        }
        $fwd = (string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
        if ($fwd === '') {
            return $remote;
        }
        $parts = array_values(array_filter(array_map('trim', explode(',', $fwd)), fn($p) => $p !== ''));
        if ($parts === []) {
            return $remote;
        }
        // Number of proxies in front of the app (default 1). The address the
        // nearest trusted proxy observed is that many from the end.
        $hops = defined('RK_TRUSTED_PROXIES') ? max(1, (int)RK_TRUSTED_PROXIES) : 1;
        $candidate = $parts[max(0, count($parts) - $hops)];
        return filter_var($candidate, FILTER_VALIDATE_IP) !== false ? $candidate : $remote;
    }
}
