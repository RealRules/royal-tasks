<?php
declare(strict_types=1);

/**
 * The calendar subscription: a user's deadlines as an iCalendar feed
 * (RFC 5545) that a calendar app fetches from a secret address.
 *
 * The address carries a random token. The server keeps its SHA-256 for the
 * lookup and the token itself sealed at rest, so the preferences can show the
 * address again. The feed is built on every fetch from the boards the user
 * is still a member of, so leaving a board, or a board being deleted, takes
 * its deadlines out at once; a new address revokes the old one.
 *
 * An event is a card with a finish date (not archived, not marked complete),
 * all day, titled after the card. On an end-to-end board the server cannot
 * read the title: the event takes the name this user set for the card in the
 * calendar ("Calendar name", stored per user), else "Deadline". The board's
 * name, which is never encrypted, is in the description.
 */
final class Calendar
{
    public const SCOPES = ['mine', 'all'];
    public const DEFAULT_TITLE = 'Deadline';
    public const MAX_NAME = 120;

    /** A fresh token for the address: 32 random bytes, URL-safe. */
    public static function newToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public static function hash(string $token): string
    {
        return hash('sha256', $token);
    }

    /** True for something shaped like a token; anything else is not looked up. */
    public static function looksLikeToken(string $token): bool
    {
        return (bool)preg_match('/^[A-Za-z0-9_-]{43}$/', $token);
    }

    /**
     * The feed for a user.
     *
     * @param array{userId:string,scope:string,boardIds:array<int,string>} $feed
     */
    public static function build(StorageInterface $store, array $feed): string
    {
        $userId = $feed['userId'];
        $only = $feed['boardIds'];
        $mine = $feed['scope'] === 'mine';
        $events = [];
        foreach ($store->boardsVisibleTo($userId) as $b) {
            $boardId = (string)$b['id'];
            if ($only && !in_array($boardId, $only, true)) {
                continue;
            }
            $e2e = $store->isBoardEncrypted($boardId);
            $lists = [];
            foreach ($b['lists'] ?? [] as $l) {
                $lists[(string)$l['id']] = (string)($l['title'] ?? '');
            }
            $cards = array_values(array_filter($b['cards'] ?? [], fn($c) =>
                !empty($c['dueDate']) && empty($c['archived']) && empty($c['completed'])
                && (!$mine || self::isMine($c, $userId))));
            if (!$cards) {
                continue;
            }
            $names = $e2e ? $store->calendarNames($userId, array_map(fn($c) => (string)$c['id'], $cards)) : [];
            foreach ($cards as $c) {
                $id = (string)$c['id'];
                $title = $e2e ? ($names[$id] ?? '') : (string)($c['title'] ?? '');
                $title = trim($title) !== '' ? $title : self::DEFAULT_TITLE;
                // The board's name always (it is never encrypted); the list's
                // only where it can be read.
                $desc = 'Board: ' . (string)($b['title'] ?? '');
                if (!$e2e && ($lists[(string)($c['listId'] ?? '')] ?? '') !== '') {
                    $desc .= "\nList: " . $lists[(string)$c['listId']];
                }
                $events[] = [
                    'uid' => $id . '@royal-tasks',
                    'day' => (string)$c['dueDate'],
                    'summary' => $title,
                    'description' => $desc,
                    'modified' => (string)($c['updatedAt'] ?? $c['createdAt'] ?? ''),
                ];
            }
        }
        usort($events, fn($a, $b) => [$a['day'], $a['summary']] <=> [$b['day'], $b['summary']]);

        $now = gmdate('Ymd\THis\Z');
        $out = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Royal Tasks//Deadlines//EN',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',
            'X-WR-CALNAME:' . self::text($mine ? 'Royal Tasks: my deadlines' : 'Royal Tasks: deadlines'),
            'X-PUBLISHED-TTL:PT1H',
            'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
        ];
        foreach ($events as $e) {
            $day = DateTimeImmutable::createFromFormat('!Y-m-d', substr($e['day'], 0, 10), new DateTimeZone('UTC'));
            if ($day === false) {
                continue;
            }
            $stamp = $now;
            if ($e['modified'] !== '') {
                try {
                    $stamp = (new DateTimeImmutable($e['modified']))->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z');
                } catch (Exception) {
                }
            }
            array_push($out,
                'BEGIN:VEVENT',
                'UID:' . self::text($e['uid']),
                'DTSTAMP:' . $stamp,
                // A finish date is a calendar day: an all-day event, no time zone.
                'DTSTART;VALUE=DATE:' . $day->format('Ymd'),
                'DTEND;VALUE=DATE:' . $day->modify('+1 day')->format('Ymd'),
                'SUMMARY:' . self::text($e['summary']),
                'DESCRIPTION:' . self::text($e['description']),
                'TRANSP:TRANSPARENT',
                'END:VEVENT'
            );
        }
        $out[] = 'END:VCALENDAR';
        return implode("\r\n", array_map([self::class, 'fold'], $out)) . "\r\n";
    }

    /** The card, or one of its checklist items, is assigned to this user. */
    public static function isMine(array $card, string $userId): bool
    {
        if (in_array($userId, $card['assignees'] ?? [], true)) {
            return true;
        }
        foreach ($card['checklists'] ?? [] as $k) {
            foreach ($k['items'] ?? [] as $t) {
                if (($t['assignee'] ?? null) === $userId) {
                    return true;
                }
            }
        }
        return false;
    }

    /** A TEXT value (RFC 5545 3.3.11): backslash, semicolon, comma and newline escaped; no control characters. */
    public static function text(string $s): string
    {
        $s = (string)preg_replace('/[\x00-\x09\x0B-\x1F\x7F]/u', '', str_replace("\r\n", "\n", $s));
        return str_replace(['\\', ';', ',', "\n"], ['\\\\', '\\;', '\\,', '\\n'], $s);
    }

    /** Fold a content line at 75 octets, never inside a UTF-8 character. */
    public static function fold(string $line): string
    {
        if (strlen($line) <= 75) {
            return $line;
        }
        $out = '';
        $cur = '';
        $limit = 75;
        foreach (preg_split('//u', $line, -1, PREG_SPLIT_NO_EMPTY) ?: [] as $ch) {
            if (strlen($cur) + strlen($ch) > $limit) {
                $out .= $cur . "\r\n ";
                $cur = '';
                $limit = 74; // the leading space counts
            }
            $cur .= $ch;
        }
        return $out . $cur;
    }

    /** A name for a card in the calendar: one line of plain text, at most MAX_NAME characters. */
    public static function cleanName(string $name): string
    {
        $name = trim((string)preg_replace('/\s+/u', ' ', (string)preg_replace('/[\x00-\x1F\x7F]/u', ' ', $name)));
        return mb_substr($name, 0, self::MAX_NAME);
    }
}
