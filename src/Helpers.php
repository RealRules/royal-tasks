<?php
declare(strict_types=1);

if (!function_exists('mb_substr')) {
    /**
     * Fallback when the mbstring extension is unavailable.
     *
     * Counts characters, not bytes. A plain substr() cuts multi-byte
     * characters in half — "æ" at the limit becomes half a character, the
     * result is no longer valid UTF-8, and json_encode then refuses the whole
     * record. Splitting on character boundaries keeps the text well-formed.
     */
    function mb_substr(string $string, int $start, ?int $length = null, ?string $encoding = null): string
    {
        $chars = preg_split('//u', $string, -1, PREG_SPLIT_NO_EMPTY);
        if ($chars === false) {
            // Already not valid UTF-8; salvage what we can.
            $string = (string)preg_replace('/[\x80-\xFF]/', '', $string);
            return $length === null ? substr($string, $start) : substr($string, $start, $length);
        }
        $slice = $length === null ? array_slice($chars, $start) : array_slice($chars, $start, $length);
        return implode('', $slice);
    }
}

if (!function_exists('mb_strlen')) {
    function mb_strlen(string $string, ?string $encoding = null): int
    {
        $chars = preg_split('//u', $string, -1, PREG_SPLIT_NO_EMPTY);
        return $chars === false ? strlen($string) : count($chars);
    }
}

final class Helpers
{
    public static function newId(string $prefix = ''): string
    {
        $bytes = random_bytes(6);
        return $prefix . bin2hex($bytes) . substr(str_replace('.', '', uniqid('', true)), -4);
    }

    /**
     * Now, as ISO 8601 in UTC with milliseconds. The database keeps
     * milliseconds (DATETIME(3)) so that two comments, or two activity
     * entries, written in the same second keep their order; whole seconds
     * here made them tie and come back in either order.
     */
    /** The board colour schemes, in the order the menu shows them; the first is the default. */
    public const COLOR_SCHEMES = ['palmbeach', 'indigo', 'cyan', 'amber', 'rose', 'grey', 'dark', 'synthwave'];

    /** Schemes that were retired for being too like another, and the one that replaced each. */
    private const RETIRED_SCHEMES = [
        'forest' => 'palmbeach', 'emerald' => 'palmbeach', 'teal' => 'cyan',
        'slate' => 'grey', 'violet' => 'indigo', 'sand' => 'amber',
    ];

    /** A stored or requested colour scheme as one that exists: retired ones map on, unknown ones get the default. */
    public static function colorScheme(?string $scheme): string
    {
        $s = (string)$scheme;
        if (in_array($s, self::COLOR_SCHEMES, true)) {
            return $s;
        }
        return self::RETIRED_SCHEMES[$s] ?? self::COLOR_SCHEMES[0];
    }

    public static function now(): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.vP');
    }

    /** @param mixed $data */
    public static function json($data, int $status = 200): void
    {
        $body = json_encode($data, JSON_UNESCAPED_UNICODE);
        if ($body === false) {
            // Never send an empty 200: the client would parse it as a failure
            // with no explanation. Say what happened instead.
            $status = 500;
            $body = json_encode([
                'ok' => false,
                'error' => 'Response could not be encoded (' . json_last_error_msg() . ').',
            ]);
        }
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo $body;
        exit;
    }

    public static function fail(string $message, int $status = 400, array $extra = []): void
    {
        self::json(array_merge(['ok' => false, 'error' => $message], $extra), $status);
    }

    /**
     * Log the real error and return a generic one: exception text can carry
     * absolute paths and other internals that clients have no business seeing.
     *
     * Goes to the server's configured error log — the app writes nothing under
     * the web root, where a log file would be downloadable.
     */
    public static function failInternal(Throwable $e): void
    {
        error_log(sprintf(
            'Royal Tasks: %s: %s in %s:%d',
            get_class($e),
            $e->getMessage(),
            $e->getFile(),
            $e->getLine()
        ));
        self::fail('Server error. Please try again.', 500);
    }

    /**
     * Request parameters.
     *
     * A JSON body wins over query parameters. Query parameters stay readable
     * on POST because multipart uploads carry their ids there; this is safe
     * now that state-changing actions require POST plus a CSRF token.
     *
     * @return array<string,mixed>
     */
    public static function input(): array
    {
        $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        if ($method === 'GET' || $method === 'HEAD') {
            return $_GET;
        }
        $raw = file_get_contents('php://input');
        if ($raw !== false && $raw !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                return array_merge($_GET, $decoded);
            }
        }
        return array_merge($_GET, $_POST);
    }

    public static function str(array $in, string $key, string $default = ''): string
    {
        $v = $in[$key] ?? $default;
        if (is_array($v) || is_object($v)) {
            return $default;
        }
        return is_string($v) ? trim($v) : trim((string)$v);
    }

    /** @return array<int,array<string,mixed>> visible boards for user (Master Gate) */
    public static function visibleBoards(array $user, array $boards): array
    {
        $uid = $user['id'];
        return array_values(array_filter($boards, fn($b) =>
            ($b['ownerId'] ?? null) === $uid ||
            in_array($uid, array_map(fn($m) => $m['userId'] ?? null, $b['members'] ?? []), true)
        ));
    }

    /**
     * The role a user has on a board.
     *
     * A site admin has no special access to boards. Administering users is the
     * admin's job; board content belongs to its members. So an admin is only a
     * member of a board if they own it or were invited to it, exactly like
     * everyone else — the operator cannot enumerate or read other people's
     * boards, encrypted or not.
     */
    public static function boardRole(array $user, array $board): ?string
    {
        if (($board['ownerId'] ?? null) === $user['id']) {
            return 'admin';
        }
        foreach ($board['members'] ?? [] as $m) {
            if (($m['userId'] ?? null) === $user['id']) {
                return ($m['access'] ?? 'view') === 'edit' ? 'edit' : 'view';
            }
        }
        return null;
    }

    public static function canView(array $user, array $board): bool
    {
        return self::boardRole($user, $board) !== null;
    }

    public static function canEdit(array $user, array $board): bool
    {
        return in_array(self::boardRole($user, $board), ['edit', 'admin'], true);
    }

    /** Board owner only: the one role that may change who a board is shared with. */
    public static function canAdminBoard(array $user, array $board): bool
    {
        return self::boardRole($user, $board) === 'admin';
    }

    public static function sanitizeUser(array $u): array
    {
        unset($u['passwordHash']);
        // The avatar's stored name stays on the server: the client only needs
        // to know there is one, and a value that changes with it (so a new
        // picture is not served from the browser's cache).
        $stored = (string)($u['avatar'] ?? '');
        unset($u['avatar']);
        $u['hasAvatar'] = $stored !== '';
        $u['avatarV'] = $stored !== '' ? substr(hash('sha256', $stored), 0, 10) : '';
        return $u;
    }

    /**
     * Server-side rich-text guard. The client sanitizes too, but this is the
     * copy that decides what actually reaches storage.
     */
    public static function sanitizeRichText(string $html): string
    {
        return HtmlSanitizer::clean($html);
    }

    public static function nextOrder(array $items): int
    {
        $max = -1;
        foreach ($items as $it) {
            $o = (int)($it['order'] ?? 0);
            if ($o > $max) {
                $max = $o;
            }
        }
        return $max + 1;
    }

    /** Re-sequence orders 0..n for a set of items, preserving given order. */
    public static function resequence(array $items): array
    {
        usort($items, fn($a, $b) => ((int)($a['order'] ?? 0)) <=> ((int)($b['order'] ?? 0)));
        foreach ($items as $i => &$it) {
            $it['order'] = $i;
        }
        return $items;
    }
}
