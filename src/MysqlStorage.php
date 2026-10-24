<?php
declare(strict_types=1);

require_once __DIR__ . '/StorageInterface.php';
require_once __DIR__ . '/MysqlSchema.php';

/**
 * MySQL / MariaDB storage.
 *
 * The storage contract is the board document — a board arrives with its
 * lists, cards, checklists, comments, attachments and activity nested inside
 * it — so BoardService, AuthService and the API are untouched, and all the
 * access control, resource caps and optimistic locking keep working as
 * written. Underneath, that document is spread across normalised tables.
 *
 * Every access path is indexed, so a request touches only what it needs:
 *
 *   - signing in reads one row
 *   - listing boards reads that user's boards
 *   - saving a board writes that board's rows
 *
 * Whole-board writes remain — one board is tens of rows, which is bounded and
 * fine. It is the cross-board scans that the schema is shaped to avoid.
 */
final class MysqlStorage implements StorageInterface
{
    private PDO $db;
    private string $p;
    /** Cached schema_version, so the encryption paths can stay dormant pre-migration. */
    private ?int $schemaVersion = null;

    /** ISO-8601 in the documents, DATETIME in the database. */
    private const DB_TIME = 'Y-m-d H:i:s.v';

    /**
     * @param array<string,mixed> $config host, port, database, username,
     *                                    password, prefix, socket
     */
    public function __construct(array $config)
    {
        $this->p = MysqlSchema::sanitizePrefix((string)($config['prefix'] ?? MysqlSchema::DEFAULT_PREFIX));

        $dsn = 'mysql:';
        if (!empty($config['socket'])) {
            $dsn .= 'unix_socket=' . $config['socket'];
        } else {
            $dsn .= 'host=' . ($config['host'] ?? '127.0.0.1')
                 . ';port=' . (int)($config['port'] ?? 3306);
        }
        $dsn .= ';dbname=' . ($config['database'] ?? 'royal_kanban')
             // utf8mb4 or emoji and some characters are silently mangled;
             // MySQL's "utf8" is only three bytes per character.
             . ';charset=utf8mb4';

        $this->db = new PDO($dsn, (string)($config['username'] ?? ''), (string)($config['password'] ?? ''), [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            // Unbuffered results would break the nested reads used to
            // assemble a board. (PDO::MYSQL_ATTR_* is deprecated in PHP 8.5.)
            \Pdo\Mysql::ATTR_USE_BUFFERED_QUERY => true,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);

        if (!empty($config['auto_migrate'])) {
            MysqlSchema::apply($this->db, $this->p);
        }
    }

    public function pdo(): PDO
    {
        return $this->db;
    }

    public function prefix(): string
    {
        return $this->p;
    }

    // -----------------------------------------------------------------
    // Small helpers
    // -----------------------------------------------------------------

    /** @return array<int,array<string,mixed>> */
    private function rows(string $sql, array $args = []): array
    {
        $st = $this->db->prepare($sql);
        $st->execute($args);
        return $st->fetchAll();
    }

    private function row(string $sql, array $args = []): ?array
    {
        $r = $this->rows($sql, $args);
        return $r[0] ?? null;
    }

    private function run(string $sql, array $args = []): int
    {
        $st = $this->db->prepare($sql);
        $st->execute($args);
        return $st->rowCount();
    }

    /**
     * ISO-8601 (what the documents carry) -> DATETIME(3).
     *
     * Parsed with DateTimeImmutable rather than strtotime(): the latter
     * returns whole seconds, so milliseconds were being discarded here —
     * before the column that keeps them was ever reached.
     */
    private static function toDbTime(?string $iso): ?string
    {
        if ($iso === null || trim($iso) === '') {
            return null;
        }
        try {
            $d = new DateTimeImmutable($iso);
        } catch (Exception) {
            return null;
        }
        return $d->setTimezone(new DateTimeZone('UTC'))->format(self::DB_TIME);
    }

    /** DATETIME -> ISO-8601, matching Helpers::now(). */
    private static function toIso(?string $dbTime): ?string
    {
        if ($dbTime === null || $dbTime === '' || str_starts_with($dbTime, '0000')) {
            return null;
        }
        $d = DateTimeImmutable::createFromFormat('Y-m-d H:i:s.u', $dbTime, new DateTimeZone('UTC'))
            ?: DateTimeImmutable::createFromFormat('Y-m-d H:i:s', $dbTime, new DateTimeZone('UTC'));
        if ($d === false) {
            return null;
        }
        // Match Helpers::now() when there is no sub-second part, so documents
        // the app wrote itself round-trip byte for byte.
        return $d->format('v') === '000' ? $d->format('c') : $d->format('Y-m-d\TH:i:s.vP');
    }

    /**
     * A due date is a calendar day, not an instant.
     *
     * Never route it through a timestamp: strtotime() reads "2026-10-01" in
     * the server's local timezone and gmdate() then prints it in UTC, so the
     * day moves. Worse, the shifted value is read back and converted again on
     * the next save, walking the date backwards one day per write.
     */
    private static function toDbDate(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }
        $v = trim($value);
        if ($v === '') {
            return null;
        }
        // Both the client and the stored documents use YYYY-MM-DD, possibly
        // with a time part after it. Take the day as written.
        if (preg_match('/^(\d{4})-(\d{2})-(\d{2})/', $v, $m)) {
            return "{$m[1]}-{$m[2]}-{$m[3]}";
        }
        // Anything else: interpret in UTC explicitly, never local time.
        try {
            return (new DateTimeImmutable($v, new DateTimeZone('UTC')))->format('Y-m-d');
        } catch (Exception) {
            return null;
        }
    }

    // -----------------------------------------------------------------
    // Generic collection API
    // -----------------------------------------------------------------

    public function all(string $collection): array
    {
        switch ($collection) {
            case 'users':
                return array_map([$this, 'userDoc'], $this->rows(
                    "SELECT * FROM {$this->p}users ORDER BY created_at, id"
                ));
            case 'boards':
                $ids = array_column($this->rows("SELECT id FROM {$this->p}boards ORDER BY updated_at DESC"), 'id');
                return $this->assembleBoards($ids);
            case 'inbox':
                return array_map([$this, 'inboxDoc'], $this->rows(
                    "SELECT * FROM {$this->p}inbox ORDER BY created_at"
                ));
            default:
                return [];
        }
    }

    public function count(string $collection): int
    {
        $table = match ($collection) {
            'users' => "{$this->p}users",
            'boards' => "{$this->p}boards",
            'inbox' => "{$this->p}inbox",
            default => null,
        };
        if ($table === null) {
            return 0;
        }
        return (int)$this->row("SELECT COUNT(*) AS n FROM {$table}")['n'];
    }

    // -----------------------------------------------------------------
    // Encryption at rest (see AtRest)
    // -----------------------------------------------------------------

    /** The board whose rows saveBoard() is writing; child rows seal under it. */
    private string $sealBoard = '';

    /** Seal only once the key exists and the columns are wide enough (v7). */
    private function sealing(): bool
    {
        return AtRest::hasKey() && $this->schemaVersion() >= 7;
    }

    private function sealFor(string $value, string $boardId): string
    {
        return $this->sealing() ? AtRest::seal($value, 'board:' . $boardId) : $value;
    }

    /** Seal a child row of the board being saved. */
    private function seal(string $value): string
    {
        return $this->sealFor($value, $this->sealBoard);
    }

    private function open(?string $value, string $boardId): string
    {
        return AtRest::open((string)$value, 'board:' . $boardId);
    }

    /**
     * Rewrite every board and pending share so all of it is encrypted: the
     * step upgrade.php runs once a master key exists. Each board is loaded
     * (plaintext passes through, sealed values open) and saved again, which
     * seals every field. Idempotent. Returns the number of boards rewritten.
     */
    public function resealAll(): int
    {
        $this->schemaVersion = null; // apply() may just have moved it
        if (!$this->sealing()) {
            return 0;
        }
        $n = 0;
        foreach ($this->rows("SELECT id FROM {$this->p}boards") as $r) {
            $b = $this->find('boards', (string)$r['id']);
            if ($b !== null) {
                $this->saveBoard($b, null);
                $n++;
            }
        }
        // Pending shares: rewritten in place (saving them again would add
        // their file rows a second time).
        foreach ($this->rows("SELECT * FROM {$this->p}inbox") as $r) {
            $scope = 'inbox:' . (string)$r['user_id'];
            $re = fn(?string $v): string => AtRest::seal(AtRest::open((string)$v, $scope), $scope);
            $this->run(
                "UPDATE {$this->p}inbox SET title = ?, body = ?, url = ? WHERE id = ?",
                [$re($r['title']), $re($r['body']), $re($r['url']), $r['id']]
            );
            foreach ($this->rows("SELECT id, name FROM {$this->p}inbox_files WHERE inbox_id = ?", [$r['id']]) as $f) {
                $this->run("UPDATE {$this->p}inbox_files SET name = ? WHERE id = ?", [$re($f['name']), $f['id']]);
            }
        }
        if ($this->hasCalendar()) {
            foreach ($this->rows("SELECT user_id, token FROM {$this->p}calendar_feeds") as $r) {
                $scope = 'calendar:' . (string)$r['user_id'];
                $this->run("UPDATE {$this->p}calendar_feeds SET token = ? WHERE user_id = ?",
                    [AtRest::seal(AtRest::open((string)$r['token'], $scope), $scope), $r['user_id']]);
            }
            foreach ($this->rows("SELECT user_id, card_id, name FROM {$this->p}calendar_names") as $r) {
                $scope = 'calname:' . (string)$r['user_id'];
                $this->run("UPDATE {$this->p}calendar_names SET name = ? WHERE user_id = ? AND card_id = ?",
                    [AtRest::seal(AtRest::open((string)$r['name'], $scope), $scope), $r['user_id'], $r['card_id']]);
            }
        }
        return $n;
    }

    public function describe(): array
    {
        // MariaDB reports itself through the same VERSION() as MySQL; the
        // string says which one it actually is.
        $version = (string)($this->row('SELECT VERSION() AS v')['v'] ?? '');
        $isMaria = stripos($version, 'mariadb') !== false;
        // The database's name is deliberately left out: it reaches the
        // browser (and its console), and it is nobody's business there.
        return [
            'driver' => 'mysql',
            'label' => ($isMaria ? 'MariaDB ' : 'MySQL ') . preg_replace('/-.*$/', '', $version),
        ];
    }

    public function findInboxIdsFor(string $userId): array
    {
        return array_map(
            fn($r) => (string)$r['id'],
            $this->rows("SELECT id FROM {$this->p}inbox WHERE user_id = ?", [$userId])
        );
    }

    public function previewDetachUser(string $userId): array
    {
        $out = [];
        foreach ($this->rows(
            "SELECT id, title FROM {$this->p}boards WHERE owner_id = ?",
            [$userId]
        ) as $b) {
            $edit = (int)$this->row(
                "SELECT COUNT(*) AS n FROM {$this->p}board_members
                  WHERE board_id = ? AND user_id <> ? AND access = 'edit'",
                [$b['id'], $userId]
            )['n'];
            $view = (int)$this->row(
                "SELECT COUNT(*) AS n FROM {$this->p}board_members
                  WHERE board_id = ? AND user_id <> ? AND access <> 'edit'",
                [$b['id'], $userId]
            )['n'];
            $out[] = [
                'boardId' => (string)$b['id'],
                'title' => $this->open($b['title'], (string)$b['id']),
                'editSuccessors' => $edit,
                'viewers' => $view,
            ];
        }
        return $out;
    }

    public function detachUser(string $userId, string $viewerPolicy = 'delete', string $actingAdminId = ''): array
    {
        $deleted = [];
        $this->db->beginTransaction();
        try {
            // Boards this user owns.
            $owned = array_column($this->rows(
                "SELECT id FROM {$this->p}boards WHERE owner_id = ?",
                [$userId]
            ), 'id');

            foreach ($owned as $boardId) {
                // Prefer a member who can already edit the board: they have the
                // power to use ownership, and a viewer inheriting it would
                // silently gain share/delete/key rights they never had. Among
                // editors, the longest-standing wins (added_at is the join time).
                $successor = $this->row(
                    "SELECT user_id FROM {$this->p}board_members
                      WHERE board_id = ? AND user_id <> ? AND access = 'edit'
                      ORDER BY added_at ASC, user_id ASC
                      LIMIT 1",
                    [$boardId, $userId]
                );
                if ($successor === null && $viewerPolicy === 'promote') {
                    // No editors: promote the longest-standing viewer, on the
                    // admin's explicit instruction, using edit rights from then on.
                    $successor = $this->row(
                        "SELECT user_id FROM {$this->p}board_members
                          WHERE board_id = ? AND user_id <> ?
                          ORDER BY added_at ASC, user_id ASC
                          LIMIT 1",
                        [$boardId, $userId]
                    );
                    if ($successor !== null) {
                        $this->run(
                            "UPDATE {$this->p}board_members SET access = 'edit' WHERE board_id = ? AND user_id = ?",
                            [$boardId, (string)$successor['user_id']]
                        );
                    }
                }
                if ($successor === null && $viewerPolicy === 'transfer' && $actingAdminId !== '') {
                    // The safe middle option: the board goes to the acting admin
                    // rather than being promoted to a viewer or deleted.
                    $successor = ['user_id' => $actingAdminId];
                    // The admin is not a member; add them as such so the board is
                    // reachable from their list and administrable.
                    $this->run(
                        "INSERT INTO {$this->p}board_members (board_id,user_id,access,added_at)
                         VALUES (?,?,?,?)
                         ON DUPLICATE KEY UPDATE access = VALUES(access)",
                        [$boardId, $actingAdminId, 'edit', gmdate(self::DB_TIME)]
                    );
                }
                if ($successor !== null) {
                    $this->run(
                        "UPDATE {$this->p}boards SET owner_id = ? WHERE id = ?",
                        [(string)$successor['user_id'], $boardId]
                    );
                } else {
                    // No eligible successor: nobody can administer it, so remove
                    // the board. Its lists, cards, checklists, comments and
                    // attachment rows go with it through ON DELETE CASCADE.
                    $this->run("DELETE FROM {$this->p}boards WHERE id = ?", [$boardId]);
                    $deleted[] = (string)$boardId;
                }
            }

            // Drop the user from every board they were a member of. (The FK
            // would cascade this on account deletion, but doing it here means
            // detachUser is correct on its own, before the row disappears.)
            $this->run("DELETE FROM {$this->p}board_members WHERE user_id = ?", [$userId]);
            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
        return $deleted;
    }

    public function find(string $collection, string $id): ?array
    {
        switch ($collection) {
            case 'users':
                $r = $this->row("SELECT * FROM {$this->p}users WHERE id = ?", [$id]);
                return $r ? $this->userDoc($r) : null;
            case 'boards':
                $boards = $this->assembleBoards([$id]);
                return $boards[0] ?? null;
            case 'inbox':
                $r = $this->row("SELECT * FROM {$this->p}inbox WHERE id = ?", [$id]);
                return $r ? $this->inboxDoc($r) : null;
            default:
                return null;
        }
    }

    public function findUserByUsername(string $username): ?array
    {
        // One indexed row. The file backend had to read every user.
        $r = $this->row(
            "SELECT * FROM {$this->p}users WHERE username = ? LIMIT 1",
            [mb_strtolower(trim($username))]
        );
        return $r ? $this->userDoc($r) : null;
    }

    public function usersShareBoard(string $userA, string $userB): bool
    {
        $r = $this->row(
            "SELECT 1 AS yes FROM {$this->p}boards b
              WHERE (b.owner_id = ? OR EXISTS (SELECT 1 FROM {$this->p}board_members m WHERE m.board_id = b.id AND m.user_id = ?))
                AND (b.owner_id = ? OR EXISTS (SELECT 1 FROM {$this->p}board_members m WHERE m.board_id = b.id AND m.user_id = ?))
              LIMIT 1",
            [$userA, $userA, $userB, $userB]
        );
        return $r !== null;
    }

    public function boardsVisibleTo(string $userId): array
    {
        // Owned or shared, in one indexed pass — never a scan of all boards.
        $ids = array_column($this->rows(
            "SELECT b.id FROM {$this->p}boards b
              WHERE b.owner_id = :u
              UNION
             SELECT b.id FROM {$this->p}boards b
               JOIN {$this->p}board_members m ON m.board_id = b.id
              WHERE m.user_id = :u2",
            [':u' => $userId, ':u2' => $userId]
        ), 'id');
        return $this->assembleBoards($ids);
    }

    public function save(string $collection, array $record): array
    {
        return $this->saveIfVersion($collection, $record, null);
    }

    public function saveIfVersion(string $collection, array $record, ?int $expectedVersion): array
    {
        if (!isset($record['id']) || $record['id'] === '') {
            $record['id'] = Helpers::newId();
        }
        switch ($collection) {
            case 'users':
                $this->saveUser($record);
                return $record;
            case 'boards':
                return $this->saveBoard($record, $expectedVersion);
            case 'inbox':
                $this->saveInbox($record);
                return $record;
            default:
                return $record;
        }
    }

    public function delete(string $collection, string $id): bool
    {
        // Children go with the parent through ON DELETE CASCADE: one
        // statement instead of a loop over lists, cards and their contents.
        $table = match ($collection) {
            'users' => "{$this->p}users",
            'boards' => "{$this->p}boards",
            'inbox' => "{$this->p}inbox",
            default => null,
        };
        return $table !== null && $this->run("DELETE FROM {$table} WHERE id = ?", [$id]) > 0;
    }

    // replaceAll() was removed deliberately. It rewrote a whole collection from
    // an in-memory list, so any insert that landed between the caller's read and
    // its write was silently dropped. The share inbox — its only remaining
    // caller — now uses the targeted findInboxFor()/claimInboxItem()/addInboxItem()
    // operations instead, and nothing should bring it back.

    // -----------------------------------------------------------------
    // Global change counter (drives polling)
    // -----------------------------------------------------------------

    public function getVersion(): int
    {
        $r = $this->row("SELECT value FROM {$this->p}meta WHERE name = 'change_counter'");
        return $r ? (int)$r['value'] : 1;
    }

    public function bumpVersion(): int
    {
        // LAST_INSERT_ID() makes increment-and-read one atomic statement, so
        // concurrent writers cannot both read the same number.
        $this->run(
            "INSERT INTO {$this->p}meta (name, value) VALUES ('change_counter', 2)
             ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)"
        );
        $v = (int)$this->row("SELECT LAST_INSERT_ID() AS v")['v'];
        return $v > 0 ? $v : $this->getVersion();
    }

    // -----------------------------------------------------------------
    // Rate limiting
    // -----------------------------------------------------------------

    /**
     * One row per bucket+subject, updated under a row lock so concurrent
     * requests cannot both read the same count. The subject is hashed: the
     * table then holds no username or IP in the clear.
     */
    // -----------------------------------------------------------------
    // Accounts by email (v14): settings, one-time links, lookup by address
    // -----------------------------------------------------------------

    public function hasAccounts(): bool
    {
        return $this->schemaVersion() >= 14;
    }

    /** The lookup key for an address: case and outer spaces do not count. */
    private static function emailHash(string $email): string
    {
        return AtRest::lookupHash(mb_strtolower(trim($email)), 'email');
    }

    public function findUserByEmail(string $email): ?array
    {
        if (!$this->hasAccounts() || trim($email) === '') {
            return null;
        }
        $r = $this->row("SELECT * FROM {$this->p}users WHERE email_hash = ? LIMIT 1", [self::emailHash($email)]);
        return $r ? $this->userDoc($r) : null;
    }

    public function settings(): array
    {
        if (!$this->hasAccounts()) {
            return [];
        }
        $out = [];
        foreach ($this->rows("SELECT name, value FROM {$this->p}settings") as $r) {
            $out[(string)$r['name']] = (string)$r['value'];
        }
        return $out;
    }

    public function saveSetting(string $name, string $value): void
    {
        if (!$this->hasAccounts()) {
            throw new RuntimeException('Settings need a database update: run upgrade.php.');
        }
        $this->run("INSERT INTO {$this->p}settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [$name, $value]);
    }

    public function saveEmailLink(string $tokenHash, string $kind, ?string $userId, string $email, string $name, string $role, ?string $createdBy, int $expiresAt): void
    {
        if (!$this->hasAccounts()) {
            throw new RuntimeException('Email links need a database update: run upgrade.php.');
        }
        $now = gmdate(self::DB_TIME);
        // Spent and expired links are of no use to anyone: they go here.
        $this->run("DELETE FROM {$this->p}email_links WHERE expires_at < ? OR used_at IS NOT NULL", [$now]);
        $this->run(
            "INSERT INTO {$this->p}email_links (token_hash, kind, user_id, email, name, role, created_by, created_at, expires_at)
             VALUES (?,?,?,?,?,?,?,?,?)",
            [$tokenHash, $kind, $userId, AtRest::hasKey() ? AtRest::seal($email, 'link:' . $tokenHash) : $email,
             mb_substr($name, 0, 80), $role === 'admin' ? 'admin' : 'user', $createdBy, $now, gmdate(self::DB_TIME, $expiresAt)]
        );
    }

    public function findEmailLink(string $tokenHash): ?array
    {
        if (!$this->hasAccounts() || !preg_match('/^[0-9a-f]{64}$/', $tokenHash)) {
            return null;
        }
        $r = $this->row("SELECT * FROM {$this->p}email_links WHERE token_hash = ?", [$tokenHash]);
        return $r ? $this->emailLinkDoc($r) : null;
    }

    private function emailLinkDoc(array $r): array
    {
        return [
            'tokenHash' => (string)$r['token_hash'],
            'kind' => (string)$r['kind'],
            'userId' => $r['user_id'] === null ? null : (string)$r['user_id'],
            'email' => AtRest::open((string)$r['email'], 'link:' . $r['token_hash']),
            'name' => (string)$r['name'],
            'role' => (string)$r['role'],
            'createdAt' => self::toIso((string)$r['created_at']) ?? '',
            'expiresAt' => (int)strtotime((string)$r['expires_at'] . ' UTC'),
            'usedAt' => $r['used_at'] === null ? null : self::toIso((string)$r['used_at']),
        ];
    }

    public function useEmailLink(string $tokenHash): bool
    {
        if (!$this->hasAccounts()) {
            return false;
        }
        $now = gmdate(self::DB_TIME);
        // One statement: of two requests with the same link, one wins.
        $st = $this->db->prepare("UPDATE {$this->p}email_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?");
        $st->execute([$now, $tokenHash, $now]);
        return $st->rowCount() === 1;
    }

    public function deleteEmailLink(string $tokenHash): void
    {
        if ($this->hasAccounts()) {
            $this->run("DELETE FROM {$this->p}email_links WHERE token_hash = ?", [$tokenHash]);
        }
    }

    public function deleteResetLinksFor(string $userId): void
    {
        if ($this->hasAccounts()) {
            $this->run("DELETE FROM {$this->p}email_links WHERE kind = 'reset' AND user_id = ?", [$userId]);
        }
    }

    public function pendingInvites(): array
    {
        if (!$this->hasAccounts()) {
            return [];
        }
        $rows = $this->rows(
            "SELECT * FROM {$this->p}email_links WHERE kind = 'invite' AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
            [gmdate(self::DB_TIME)]
        );
        return array_map(function ($r) {
            $d = $this->emailLinkDoc($r);
            unset($d['userId'], $d['usedAt'], $d['kind']);
            return $d;
        }, $rows);
    }

    public function backfillEmailHashes(): int
    {
        $this->schemaVersion = null;
        if (!$this->hasAccounts()) {
            return 0;
        }
        $n = 0;
        foreach ($this->rows("SELECT id, email FROM {$this->p}users") as $r) {
            $email = $r['email'] !== null && $r['email'] !== '' ? AtRest::open((string)$r['email'], 'user:' . $r['id']) : '';
            $this->run("UPDATE {$this->p}users SET email_hash = ? WHERE id = ?", [$email === '' ? null : self::emailHash($email), $r['id']]);
            $n += $email === '' ? 0 : 1;
        }
        return $n;
    }

    // -----------------------------------------------------------------
    // Calendar subscription (v13)
    // -----------------------------------------------------------------

    public function hasCalendar(): bool
    {
        return $this->schemaVersion() >= 13;
    }

    public function calendarFeed(string $userId): ?array
    {
        if (!$this->hasCalendar()) {
            return null;
        }
        $r = $this->row("SELECT * FROM {$this->p}calendar_feeds WHERE user_id = ?", [$userId]);
        if (!$r) {
            return null;
        }
        return [
            'token' => AtRest::open((string)$r['token'], 'calendar:' . $userId),
            'scope' => (string)$r['scope'],
            'boardIds' => array_values(array_filter(explode(',', (string)$r['board_ids']))),
            'createdAt' => self::toIso((string)$r['created_at']) ?? '',
        ];
    }

    public function calendarFeedByHash(string $tokenHash): ?array
    {
        if (!$this->hasCalendar() || !preg_match('/^[0-9a-f]{64}$/', $tokenHash)) {
            return null;
        }
        $r = $this->row("SELECT user_id, scope, board_ids FROM {$this->p}calendar_feeds WHERE token_hash = ?", [$tokenHash]);
        return $r ? [
            'userId' => (string)$r['user_id'],
            'scope' => (string)$r['scope'],
            'boardIds' => array_values(array_filter(explode(',', (string)$r['board_ids']))),
        ] : null;
    }

    public function saveCalendarFeed(string $userId, string $token, string $scope, array $boardIds): void
    {
        if (!$this->hasCalendar()) {
            throw new RuntimeException('The calendar needs a database update: run upgrade.php.');
        }
        $sealed = AtRest::hasKey() ? AtRest::seal($token, 'calendar:' . $userId) : $token;
        $ids = implode(',', array_filter($boardIds, fn($id) => preg_match('/^[A-Za-z0-9_]{1,32}$/', (string)$id)));
        $this->run(
            "INSERT INTO {$this->p}calendar_feeds (user_id, token_hash, token, scope, board_ids, created_at)
             VALUES (?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), token = VALUES(token),
               scope = VALUES(scope), board_ids = VALUES(board_ids)",
            [$userId, Calendar::hash($token), $sealed, $scope, $ids, gmdate(self::DB_TIME)]
        );
    }

    public function deleteCalendarFeed(string $userId): void
    {
        if ($this->hasCalendar()) {
            $this->run("DELETE FROM {$this->p}calendar_feeds WHERE user_id = ?", [$userId]);
        }
    }

    public function calendarNames(string $userId, array $cardIds): array
    {
        $cardIds = array_values(array_filter($cardIds, fn($id) => preg_match('/^[A-Za-z0-9_]{1,32}$/', (string)$id)));
        if (!$this->hasCalendar() || !$cardIds) {
            return [];
        }
        $in = implode(',', array_fill(0, count($cardIds), '?'));
        $out = [];
        foreach ($this->rows("SELECT card_id, name FROM {$this->p}calendar_names WHERE user_id = ? AND card_id IN ($in)",
            array_merge([$userId], $cardIds)) as $r) {
            $out[(string)$r['card_id']] = AtRest::open((string)$r['name'], 'calname:' . $userId);
        }
        return $out;
    }

    public function setCalendarName(string $userId, string $cardId, string $name): void
    {
        if (!$this->hasCalendar()) {
            throw new RuntimeException('The calendar needs a database update: run upgrade.php.');
        }
        if ($name === '') {
            $this->run("DELETE FROM {$this->p}calendar_names WHERE user_id = ? AND card_id = ?", [$userId, $cardId]);
            return;
        }
        $sealed = AtRest::hasKey() ? AtRest::seal($name, 'calname:' . $userId) : $name;
        $this->run(
            "INSERT INTO {$this->p}calendar_names (user_id, card_id, name) VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE name = VALUES(name)",
            [$userId, $cardId, $sealed]
        );
    }

    // -----------------------------------------------------------------
    // "Stay signed in" tokens
    // -----------------------------------------------------------------

    /** Remembered devices kept per user; the least recently used go first. */
    private const MAX_TOKENS_PER_USER = 20;

    public function findAuthToken(string $selector): ?array
    {
        if ($this->schemaVersion() < 6) {
            return null;
        }
        $r = $this->row(
            "SELECT user_id, validator_hash, pw_stamp, expires_at, last_used_at
               FROM {$this->p}auth_tokens WHERE selector = ?",
            [$selector]
        );
        if (!$r) {
            return null;
        }
        return [
            'userId' => (string)$r['user_id'],
            'validatorHash' => (string)$r['validator_hash'],
            'pwStamp' => (string)$r['pw_stamp'],
            'expiresAt' => (int)strtotime((string)$r['expires_at'] . ' UTC'),
            'lastUsedAt' => (int)strtotime((string)$r['last_used_at'] . ' UTC'),
        ];
    }

    public function saveAuthToken(string $selector, string $userId, string $validatorHash, string $pwStamp, int $expiresAt): void
    {
        if ($this->schemaVersion() < 6) {
            return;
        }
        $now = gmdate(self::DB_TIME);
        $this->run(
            "INSERT INTO {$this->p}auth_tokens
               (selector, user_id, validator_hash, pw_stamp, created_at, last_used_at, expires_at)
             VALUES (?,?,?,?,?,?,?)",
            [$selector, $userId, $validatorHash, $pwStamp, $now, $now, gmdate(self::DB_TIME, $expiresAt)]
        );
        // Housekeeping in the same indexed places: expired rows anywhere, and
        // this user's oldest devices beyond the cap.
        $this->run("DELETE FROM {$this->p}auth_tokens WHERE expires_at < ?", [$now]);
        $keep = $this->rows(
            "SELECT selector FROM {$this->p}auth_tokens WHERE user_id = ?
              ORDER BY last_used_at DESC LIMIT " . self::MAX_TOKENS_PER_USER,
            [$userId]
        );
        if (count($keep) >= self::MAX_TOKENS_PER_USER) {
            $ids = array_map(fn($r) => (string)$r['selector'], $keep);
            $in = implode(',', array_fill(0, count($ids), '?'));
            $this->run(
                "DELETE FROM {$this->p}auth_tokens WHERE user_id = ? AND selector NOT IN ($in)",
                array_merge([$userId], $ids)
            );
        }
    }

    public function touchAuthToken(string $selector, int $expiresAt): void
    {
        if ($this->schemaVersion() < 6) {
            return;
        }
        $this->run(
            "UPDATE {$this->p}auth_tokens SET last_used_at = ?, expires_at = ? WHERE selector = ?",
            [gmdate(self::DB_TIME), gmdate(self::DB_TIME, $expiresAt), $selector]
        );
    }

    public function deleteAuthToken(string $selector): void
    {
        if ($this->schemaVersion() < 6) {
            return;
        }
        $this->run("DELETE FROM {$this->p}auth_tokens WHERE selector = ?", [$selector]);
    }

    public function throttle(string $bucket, string $key, int $limit, int $windowSeconds): int
    {
        $bucket = self::bucketName($bucket);
        if ($bucket === '') {
            return 0;
        }
        $hash = hash('sha256', $key);
        $now = time();

        $this->db->beginTransaction();
        try {
            // The age is computed against UTC_TIMESTAMP() rather than in PHP:
            // window_start is stored in UTC, and UNIX_TIMESTAMP() would read
            // it in the session time zone, making a fresh row look hours old
            // and resetting the window on every call.
            $row = $this->row(
                "SELECT attempts, window_start,
                        TIMESTAMPDIFF(SECOND, window_start, UTC_TIMESTAMP()) AS age
                   FROM {$this->p}login_attempts
                  WHERE bucket = ? AND subject_hash = ?
                  FOR UPDATE",
                [$bucket, $hash]
            );
            $count = (int)($row['attempts'] ?? 0);
            $age = (int)($row['age'] ?? 0);
            if ($row === null || $age >= $windowSeconds) {
                // A new window starts now; the start stays put for its duration.
                $start = gmdate(self::DB_TIME);
                $count = 0;
                $age = 0;
            } else {
                $start = (string)$row['window_start'];
            }
            $count++;
            $this->run(
                "INSERT INTO {$this->p}login_attempts (bucket, subject_hash, window_start, attempts)
                 VALUES (?,?,?,?)
                 ON DUPLICATE KEY UPDATE window_start = VALUES(window_start), attempts = VALUES(attempts)",
                [$bucket, $hash, $start, $count]
            );
            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }

        // Expired windows would otherwise accumulate one row per subject ever
        // seen. Occasional rather than every call, and served by idx_window.
        if (random_int(1, 100) === 1) {
            $this->run(
                "DELETE FROM {$this->p}login_attempts WHERE window_start < ?",
                [gmdate(self::DB_TIME, $now - 86400)]
            );
        }

        return $count > $limit ? max(1, $windowSeconds - $age) : 0;
    }

    public function clearThrottle(string $bucket, string $key): void
    {
        $bucket = self::bucketName($bucket);
        if ($bucket === '') {
            return;
        }
        $this->run(
            "DELETE FROM {$this->p}login_attempts WHERE bucket = ? AND subject_hash = ?",
            [$bucket, hash('sha256', $key)]
        );
    }

    private static function bucketName(string $bucket): string
    {
        return substr(preg_replace('/[^a-z0-9_]/i', '', $bucket) ?? '', 0, 16);
    }

    // -----------------------------------------------------------------
    // Client-side encryption
    // -----------------------------------------------------------------

    public function boardKey(string $boardId): ?array
    {
        if ($this->schemaVersion() < 3) {
            return null; // pre-encryption schema; run `php install.php --migrate`
        }
        return $this->row(
            "SELECT board_id, kdf_alg, kdf_salt, kdf_opslimit, kdf_memlimit,
                    wrapped_key, recovery_wrapped_key
               FROM {$this->p}board_keys WHERE board_id = ?",
            [$boardId]
        ) ?: null;
    }

    public function saveBoardKey(string $boardId, array $data): array
    {
        $now = gmdate(self::DB_TIME);
        $this->run(
            "INSERT INTO {$this->p}board_keys
               (board_id, kdf_alg, kdf_salt, kdf_opslimit, kdf_memlimit,
                wrapped_key, recovery_wrapped_key, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE
               kdf_alg = VALUES(kdf_alg), kdf_salt = VALUES(kdf_salt),
               kdf_opslimit = VALUES(kdf_opslimit), kdf_memlimit = VALUES(kdf_memlimit),
               wrapped_key = VALUES(wrapped_key),
               recovery_wrapped_key = VALUES(recovery_wrapped_key),
               updated_at = VALUES(updated_at)",
            [
                $boardId,
                (string)($data['alg'] ?? 'argon2id13'),
                (string)($data['salt'] ?? ''),
                (int)($data['opslimit'] ?? 0),
                (int)($data['memlimit'] ?? 0),
                (string)($data['wrappedKey'] ?? ''),
                isset($data['recoveryWrappedKey']) && $data['recoveryWrappedKey'] !== ''
                    ? (string)$data['recoveryWrappedKey'] : null,
                $now,
                $now,
            ]
        );
        return $this->boardKey($boardId) ?? [];
    }

    public function isBoardEncrypted(string $boardId): bool
    {
        return $this->boardKey($boardId) !== null;
    }

    public function attachmentExists(string $attachmentId): bool
    {
        return $this->row(
            "SELECT 1 FROM {$this->p}attachments WHERE id = ?",
            [$attachmentId]
        ) !== null;
    }

    public function storedFileInUse(string $stored): bool
    {
        return $this->row(
            "SELECT 1 FROM {$this->p}attachments WHERE stored = ?",
            [$stored]
        ) !== null;
    }

    /**
     * The schema version recorded in meta, read once per request.
     *
     * Used to keep the app working on a database that has not been migrated
     * yet: asking for board_keys on the old schema would be an SQL error on
     * every card edit, so the encryption paths stay dormant until
     * `php install.php --migrate` has run.
     */
    private function schemaVersion(): int
    {
        if ($this->schemaVersion === null) {
            try {
                $row = $this->row("SELECT value FROM {$this->p}meta WHERE name = 'schema_version'");
                $this->schemaVersion = $row ? (int)$row['value'] : 0;
            } catch (Throwable) {
                $this->schemaVersion = 0;
            }
        }
        return $this->schemaVersion;
    }

    // -----------------------------------------------------------------
    // Users
    // -----------------------------------------------------------------

    /** @param array<string,mixed> $r */
    private function userDoc(array $r): array
    {
        $doc = [
            'id' => (string)$r['id'],
            'username' => (string)$r['username'],
            'displayName' => (string)$r['display_name'],
            'role' => (string)$r['role'],
            'passwordHash' => (string)$r['password_hash'],
            'createdAt' => self::toIso($r['created_at']),
        ];
        // Always present, as the documents the app writes have it: a missing
        // key and an explicit false are not the same thing to a strict compare.
        $doc['mustChangePassword'] = (int)$r['must_change_password'] === 1;
        // The profile (v10). The email is sealed at rest under the user's id.
        $doc['email'] = isset($r['email']) && $r['email'] !== null && $r['email'] !== ''
            ? AtRest::open((string)$r['email'], 'user:' . $r['id']) : '';
        $doc['avatar'] = (string)($r['avatar'] ?? '');
        if ($r['password_changed_at'] !== null) {
            $doc['passwordChangedAt'] = self::toIso($r['password_changed_at']);
        }
        return $doc;
    }

    private function saveUser(array $u): void
    {
        if ($this->schemaVersion() >= 10) {
            $email = trim((string)($u['email'] ?? ''));
            $this->run(
                "INSERT INTO {$this->p}users
                   (id, username, display_name, role, password_hash, must_change_password, password_changed_at, email, avatar, created_at)
                 VALUES (:id,:username,:display_name,:role,:hash,:must,:changed,:email,:avatar,:created)
                 ON DUPLICATE KEY UPDATE
                   username = VALUES(username), display_name = VALUES(display_name),
                   role = VALUES(role), password_hash = VALUES(password_hash),
                   must_change_password = VALUES(must_change_password),
                   password_changed_at = VALUES(password_changed_at),
                   email = VALUES(email), avatar = VALUES(avatar)",
                [
                    ':id' => $u['id'],
                    ':username' => mb_strtolower(trim((string)($u['username'] ?? ''))),
                    ':display_name' => (string)($u['displayName'] ?? ''),
                    ':role' => ($u['role'] ?? 'user') === 'admin' ? 'admin' : 'user',
                    ':hash' => (string)($u['passwordHash'] ?? ''),
                    ':must' => !empty($u['mustChangePassword']) ? 1 : 0,
                    ':changed' => self::toDbTime($u['passwordChangedAt'] ?? null),
                    ':email' => $email === '' ? null : (AtRest::hasKey() ? AtRest::seal($email, 'user:' . $u['id']) : $email),
                    ':avatar' => (string)($u['avatar'] ?? ''),
                    ':created' => self::toDbTime($u['createdAt'] ?? null) ?? gmdate(self::DB_TIME),
                ]
            );
            if ($this->hasAccounts()) {
                $this->run("UPDATE {$this->p}users SET email_hash = ? WHERE id = ?",
                    [$email === '' ? null : self::emailHash($email), $u['id']]);
            }
            return;
        }
        $this->run(
            "INSERT INTO {$this->p}users
               (id, username, display_name, role, password_hash, must_change_password, password_changed_at, created_at)
             VALUES (:id,:username,:display_name,:role,:hash,:must,:changed,:created)
             ON DUPLICATE KEY UPDATE
               username = VALUES(username), display_name = VALUES(display_name),
               role = VALUES(role), password_hash = VALUES(password_hash),
               must_change_password = VALUES(must_change_password),
               password_changed_at = VALUES(password_changed_at)",
            [
                ':id' => $u['id'],
                ':username' => mb_strtolower(trim((string)($u['username'] ?? ''))),
                ':display_name' => (string)($u['displayName'] ?? ''),
                ':role' => ($u['role'] ?? 'user') === 'admin' ? 'admin' : 'user',
                ':hash' => (string)($u['passwordHash'] ?? ''),
                ':must' => !empty($u['mustChangePassword']) ? 1 : 0,
                ':changed' => self::toDbTime($u['passwordChangedAt'] ?? null),
                ':created' => self::toDbTime($u['createdAt'] ?? null) ?? gmdate(self::DB_TIME),
            ]
        );
    }

    // -----------------------------------------------------------------
    // Boards
    // -----------------------------------------------------------------

    /**
     * Assemble whole board documents for the given ids.
     *
     * Six queries total regardless of how many boards are asked for, rather
     * than six per board — the difference between fine and unusable when a
     * user belongs to twenty boards.
     *
     * @param array<int,string> $ids
     * @return array<int,array<string,mixed>>
     */
    private function assembleBoards(array $ids): array
    {
        $ids = array_values(array_unique(array_filter($ids, fn($i) => is_string($i) && $i !== '')));
        if ($ids === []) {
            return [];
        }
        $in = implode(',', array_fill(0, count($ids), '?'));

        $boards = [];
        foreach ($this->rows("SELECT * FROM {$this->p}boards WHERE id IN ($in) ORDER BY updated_at DESC", $ids) as $b) {
            $boards[$b['id']] = [
                'id' => (string)$b['id'],
                'title' => $this->open($b['title'], (string)$b['id']),
                // A retired scheme reads as the one that replaced it.
                'colorScheme' => Helpers::colorScheme((string)$b['color_scheme']),
                'backgroundImage' => (string)($b['background_image'] ?? ''),
                'backgroundMime' => (string)($b['background_mime'] ?? ''),
                'ownerId' => $b['owner_id'] === null ? null : (string)$b['owner_id'],
                'members' => [],
                'lists' => [],
                'labels' => [],
                'cards' => [],
                // Flipped below for boards that have a wrapped-key row.
                'encrypted' => false,
                'createdAt' => self::toIso($b['created_at']),
                'updatedAt' => self::toIso($b['updated_at']),
                'version' => (int)$b['version'],
            ];
        }
        if ($boards === []) {
            return [];
        }

        // Which of these boards are client-encrypted, in one query rather than
        // one per board (this runs on every page load and every poll).
        if ($this->schemaVersion() >= 3) {
            foreach ($this->rows("SELECT board_id FROM {$this->p}board_keys WHERE board_id IN ($in)", $ids) as $k) {
                if (isset($boards[$k['board_id']])) {
                    $boards[$k['board_id']]['encrypted'] = true;
                }
            }
        }

        // The people on a board, owner first: who its cards and checklist
        // items can be assigned to, with what is needed to show them (name,
        // whether there is a picture and its version; never the stored file).
        $person = fn(array $u, string $access) => [
            'id' => (string)$u['id'],
            'username' => (string)($u['username'] ?? ''),
            'displayName' => (string)($u['display_name'] ?? '') ?: (string)($u['username'] ?? ''),
            'hasAvatar' => ($u['avatar'] ?? '') !== '',
            'avatarV' => ($u['avatar'] ?? '') !== '' ? substr(hash('sha256', (string)$u['avatar']), 0, 10) : '',
            'access' => $access,
        ];
        $withAvatar = $this->schemaVersion() >= 10 ? ', u.avatar' : '';
        $owners = array_values(array_unique(array_filter(array_map(fn($b) => (string)($b['ownerId'] ?? ''), $boards))));
        $ownerRows = [];
        if ($owners !== []) {
            $oin = implode(',', array_fill(0, count($owners), '?'));
            foreach ($this->rows("SELECT u.id, u.username, u.display_name{$withAvatar} FROM {$this->p}users u WHERE u.id IN ($oin)", $owners) as $u) {
                $ownerRows[(string)$u['id']] = $u;
            }
        }
        foreach ($boards as $bid => $b) {
            $boards[$bid]['people'] = isset($ownerRows[$b['ownerId'] ?? '']) ? [$person($ownerRows[$b['ownerId']], 'owner')] : [];
        }
        foreach ($this->rows(
            "SELECT m.board_id, m.user_id, m.access, u.id, u.username, u.display_name{$withAvatar}
               FROM {$this->p}board_members m
               LEFT JOIN {$this->p}users u ON u.id = m.user_id
              WHERE m.board_id IN ($in)", $ids) as $m) {
            $boards[$m['board_id']]['members'][] = [
                'userId' => (string)$m['user_id'],
                'username' => (string)($m['username'] ?? ''),
                'access' => (string)$m['access'],
            ];
            if ($m['id'] !== null) {
                $boards[$m['board_id']]['people'][] = $person($m, (string)$m['access']);
            }
        }
        $peopleIds = [];
        foreach ($boards as $bid => $b) {
            $peopleIds[$bid] = array_flip(array_column($b['people'], 'id'));
        }

        foreach ($this->rows(
            "SELECT * FROM {$this->p}lists WHERE board_id IN ($in) ORDER BY board_id, position", $ids) as $i => $l) {
            $boards[$l['board_id']]['lists'][] = [
                'id' => (string)$l['id'],
                'title' => $this->open($l['title'], (string)$l['board_id']),
                // The documents carry a 0..n order; position is how the
                // database keeps them sortable without renumbering.
                'order' => count($boards[$l['board_id']]['lists']),
            ];
        }

        // Labels arrive with v9; a card only ever shows labels its board has.
        $labelIds = [];
        if ($this->schemaVersion() >= 9) {
            foreach ($this->rows(
                "SELECT * FROM {$this->p}labels WHERE board_id IN ($in) ORDER BY board_id, position", $ids) as $l) {
                $boards[$l['board_id']]['labels'][] = [
                    'id' => (string)$l['id'],
                    'name' => $this->open($l['name'], (string)$l['board_id']),
                    'color' => (string)$l['color'],
                ];
                $labelIds[$l['board_id']][(string)$l['id']] = true;
            }
        }

        $cards = [];
        foreach ($this->rows(
            "SELECT * FROM {$this->p}cards WHERE board_id IN ($in) ORDER BY board_id, list_id, position", $ids) as $c) {
            $cards[$c['id']] = [
                'id' => (string)$c['id'],
                'boardId' => (string)$c['board_id'],
                'listId' => (string)$c['list_id'],
                'title' => $this->open($c['title'], (string)$c['board_id']),
                'description' => $this->open($c['description'] ?? '', (string)$c['board_id']),
                'dueDate' => $c['due_date'],
                'order' => 0,
                'archived' => (int)$c['archived'] === 1,
                // Absent until the v6 migration has run.
                'completed' => (int)($c['completed'] ?? 0) === 1,
                // The title image: an attachment id of this card (v8).
                'cover' => isset($c['cover_id']) && $c['cover_id'] !== '' ? (string)$c['cover_id'] : null,
                // Assigned to (v11): people of this board only; someone who left
                // the board drops out.
                'assignees' => array_values(array_filter(
                    explode(',', (string)($c['assignee_ids'] ?? '')),
                    fn($id) => isset($peopleIds[$c['board_id']][$id])
                )),
                // Label ids of this board only (v9); a deleted label drops out.
                'labels' => array_values(array_filter(
                    explode(',', (string)($c['label_ids'] ?? '')),
                    fn($id) => isset($labelIds[$c['board_id']][$id])
                )),
                'archivedAt' => self::toIso($c['archived_at']),
                'checklists' => [],
                'comments' => [],
                'attachments' => [],
                'activity' => [],
                'createdAt' => self::toIso($c['created_at']),
                'updatedAt' => self::toIso($c['updated_at']),
            ];
        }

        if ($cards !== []) {
            $cardIds = array_keys($cards);
            $cin = implode(',', array_fill(0, count($cardIds), '?'));

            $checklists = [];
            foreach ($this->rows(
                "SELECT * FROM {$this->p}checklists WHERE card_id IN ($cin) ORDER BY card_id, position", $cardIds) as $k) {
                $checklists[$k['id']] = ['card' => $k['card_id'], 'index' => count($cards[$k['card_id']]['checklists'])];
                $cards[$k['card_id']]['checklists'][] = [
                    'id' => (string)$k['id'],
                    'title' => $this->open($k['title'], $cards[$k['card_id']]['boardId']),
                    'items' => [],
                ];
            }
            if ($checklists !== []) {
                $kIds = array_keys($checklists);
                $kin = implode(',', array_fill(0, count($kIds), '?'));
                foreach ($this->rows(
                    "SELECT * FROM {$this->p}checklist_items WHERE checklist_id IN ($kin) ORDER BY checklist_id, position", $kIds) as $t) {
                    $ref = $checklists[$t['checklist_id']];
                    $cards[$ref['card']]['checklists'][$ref['index']]['items'][] = [
                        'id' => (string)$t['id'],
                        'text' => $this->open($t['text'], $cards[$ref['card']]['boardId']),
                        'done' => (int)$t['done'] === 1,
                        'assignee' => isset($t['assignee_id'], $peopleIds[$cards[$ref['card']]['boardId']][$t['assignee_id']])
                            ? (string)$t['assignee_id'] : null,
                    ];
                    $link = $this->itemLink($t['link_meta'] ?? null, $cards[$ref['card']]['boardId']);
                    if ($link !== null) {
                        $n = count($cards[$ref['card']]['checklists'][$ref['index']]['items']) - 1;
                        $cards[$ref['card']]['checklists'][$ref['index']]['items'][$n]['link'] = $link;
                    }
                }
            }

            foreach ($this->rows(
                "SELECT * FROM {$this->p}comments WHERE card_id IN ($cin) ORDER BY card_id, created_at", $cardIds) as $m) {
                $cards[$m['card_id']]['comments'][] = [
                    'id' => (string)$m['id'],
                    'userId' => $m['user_id'] === null ? null : (string)$m['user_id'],
                    'username' => (string)$m['author_name'],
                    'text' => $this->open($m['body'], $cards[$m['card_id']]['boardId']),
                    'createdAt' => self::toIso($m['created_at']),
                    'editedAt' => isset($m['edited_at']) && $m['edited_at'] !== null ? self::toIso($m['edited_at']) : null,
                ];
            }

            foreach ($this->rows(
                "SELECT * FROM {$this->p}attachments WHERE card_id IN ($cin) ORDER BY card_id, uploaded_at", $cardIds) as $a) {
                $boardId = $cards[$a['card_id']]['boardId'];
                $cards[$a['card_id']]['attachments'][] = [
                    'id' => (string)$a['id'],
                    'name' => $this->open($a['name'], $boardId),
                    'stored' => (string)$a['stored'],
                    'mime' => (string)$a['mime'],
                    'size' => (int)$a['size_bytes'],
                    'encrypted' => (int)($a['encrypted'] ?? 0) === 1,
                    'url' => 'api/file.php?b=' . urlencode($boardId) . '&f=' . urlencode((string)$a['stored']),
                    'userId' => $a['user_id'] === null ? null : (string)$a['user_id'],
                    'username' => (string)$a['author_name'],
                    'uploadedAt' => self::toIso($a['uploaded_at']),
                ];
            }

            foreach ($this->rows(
                "SELECT * FROM {$this->p}activity WHERE card_id IN ($cin) ORDER BY card_id, created_at", $cardIds) as $a) {
                $cards[$a['card_id']]['activity'][] = [
                    'id' => (string)$a['id'],
                    'userId' => $a['user_id'] === null ? null : (string)$a['user_id'],
                    'username' => (string)$a['author_name'],
                    'text' => (string)$a['text'],
                    'createdAt' => self::toIso($a['created_at']),
                ];
            }

            // Cards carry a per-list 0..n order in the document.
            $seen = [];
            foreach ($cards as $id => $card) {
                $key = $card['listId'];
                $seen[$key] = ($seen[$key] ?? -1) + 1;
                $cards[$id]['order'] = $seen[$key];
                $boards[$card['boardId']]['cards'][] = $cards[$id];
            }
        }

        return array_values($boards);
    }

    /**
     * Persist a whole board document.
     *
     * The version check is an UPDATE guarded by the version the caller read,
     * inside a transaction: if another request saved first the guarded UPDATE
     * matches no row, and the whole write rolls back. That is the same
     * guarantee the file backend gets from an exclusive lock, without one.
     */
    private function saveBoard(array $b, ?int $expectedVersion): array
    {
        $id = (string)$b['id'];
        $this->sealBoard = $id;
        $this->db->beginTransaction();
        try {
            $current = $this->row("SELECT version FROM {$this->p}boards WHERE id = ? FOR UPDATE", [$id]);

            if ($current === null) {
                $this->run(
                    "INSERT INTO {$this->p}boards
                       (id,title,color_scheme,background_image,background_mime,owner_id,version,created_at,updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?)",
                    [
                        $id,
                        $this->seal((string)($b['title'] ?? '')),
                        Helpers::colorScheme($b['colorScheme'] ?? null),
                        (string)($b['backgroundImage'] ?? ''),
                        (string)($b['backgroundMime'] ?? ''),
                        ($b['ownerId'] ?? null) ?: null,
                        (int)($b['version'] ?? 1),
                        self::toDbTime($b['createdAt'] ?? null) ?? gmdate(self::DB_TIME),
                        self::toDbTime($b['updatedAt'] ?? null) ?? gmdate(self::DB_TIME),
                    ]
                );
            } else {
                $stored = (int)$current['version'];
                if ($expectedVersion !== null && $stored !== $expectedVersion) {
                    $this->db->rollBack();
                    $live = $this->find('boards', $id) ?? [];
                    throw new VersionConflict($live, $stored, $expectedVersion);
                }
                $this->run(
                    "UPDATE {$this->p}boards
                        SET title = ?, color_scheme = ?, background_image = ?, background_mime = ?,
                            owner_id = ?, version = ?, updated_at = ?
                      WHERE id = ?",
                    [
                        $this->seal((string)($b['title'] ?? '')),
                        Helpers::colorScheme($b['colorScheme'] ?? null),
                        (string)($b['backgroundImage'] ?? ''),
                        (string)($b['backgroundMime'] ?? ''),
                        ($b['ownerId'] ?? null) ?: null,
                        (int)($b['version'] ?? $stored + 1),
                        self::toDbTime($b['updatedAt'] ?? null) ?? gmdate(self::DB_TIME),
                        $id,
                    ]
                );
            }

            $this->syncMembers($id, $b['members'] ?? []);
            $this->syncLists($id, $b['lists'] ?? []);
            if ($this->schemaVersion() >= 9) {
                $this->syncLabels($id, $b['labels'] ?? []);
            }
            $this->syncCards($id, $b['cards'] ?? []);

            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
        return $b;
    }

    /** Replace a board's child rows with the document's, keeping ids stable. */
    private function syncMembers(string $boardId, array $members): void
    {
        $keep = [];
        foreach ($members as $m) {
            $uid = (string)($m['userId'] ?? '');
            if ($uid === '') {
                continue;
            }
            $keep[] = $uid;
            $this->run(
                "INSERT INTO {$this->p}board_members (board_id,user_id,access,added_at)
                 VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE access = VALUES(access)",
                [$boardId, $uid, ($m['access'] ?? 'view') === 'edit' ? 'edit' : 'view', gmdate(self::DB_TIME)]
            );
        }
        $this->deleteMissing("{$this->p}board_members", 'user_id', 'board_id', $boardId, $keep);
    }

    /**
     * Stable sort by each item's 'order'. Positions are written in this
     * sequence, so it must match what the client sees. Items without an order
     * keep their array position relative to each other.
     *
     * @param array<int,array<string,mixed>> $items
     * @return array<int,array<string,mixed>>
     */
    private static function byOrder(array $items): array
    {
        $items = array_values($items);
        $keyed = [];
        foreach ($items as $i => $it) {
            $keyed[] = [isset($it['order']) ? (float)$it['order'] : (float)$i, $i, $it];
        }
        usort($keyed, fn($a, $b) => [$a[0], $a[1]] <=> [$b[0], $b[1]]);
        return array_map(fn($k) => $k[2], $keyed);
    }

    private function syncLists(string $boardId, array $lists): void
    {
        $keep = [];
        $pos = 0;
        // Position follows the document's 'order', not the array order: a move
        // updates 'order' and may leave the array as it was.
        $lists = self::byOrder($lists);
        foreach ($lists as $l) {
            $lid = (string)($l['id'] ?? '');
            if ($lid === '') {
                continue;
            }
            $keep[] = $lid;
            $pos += 65536;   // gaps leave room to insert without renumbering
            // Guarded by board_id, and the board_id column is deliberately not
            // updated: an id collision must never move another board's list
            // here. (Ids are server-minted today; this keeps the database
            // enforcing isolation if a future path ever accepts a client id.)
            $this->run(
                "INSERT INTO {$this->p}lists (id,board_id,title,position) VALUES (?,?,?,?)
                 ON DUPLICATE KEY UPDATE
                   title = IF(board_id = VALUES(board_id), VALUES(title), title),
                   position = IF(board_id = VALUES(board_id), VALUES(position), position)",
                [$lid, $boardId, $this->seal((string)($l['title'] ?? '')), $pos]
            );
        }
        $this->deleteMissing("{$this->p}lists", 'id', 'board_id', $boardId, $keep);
    }

    /** User ids as stored in one column: id-shaped values only, no repeats, capped. */
    private static function idList(mixed $ids, int $max, int $width): string
    {
        $out = [];
        foreach (is_array($ids) ? $ids : [] as $id) {
            $id = (string)$id;
            if (preg_match('/^[A-Za-z0-9_]{1,32}$/', $id) && !in_array($id, $out, true)) {
                $out[] = $id;
            }
        }
        return substr(implode(',', array_slice($out, 0, $max)), 0, $width);
    }

    /** A card's label ids as stored: id-shaped values only, no repeats, capped. */
    private static function labelIdList(mixed $ids): string
    {
        $out = [];
        foreach (is_array($ids) ? $ids : [] as $id) {
            $id = (string)$id;
            if (preg_match('/^[A-Za-z0-9_]{1,32}$/', $id) && !in_array($id, $out, true)) {
                $out[] = $id;
            }
        }
        return substr(implode(',', array_slice($out, 0, BoardService::MAX_LABELS)), 0, 255);
    }

    /** The board's labels, in order. Guarded like lists: board_id is never moved. */
    private function syncLabels(string $boardId, array $labels): void
    {
        $keep = [];
        $pos = 0;
        foreach (array_values($labels) as $l) {
            $lid = (string)($l['id'] ?? '');
            if ($lid === '') {
                continue;
            }
            $keep[] = $lid;
            $pos += 65536;
            $color = (string)($l['color'] ?? '');
            $this->run(
                "INSERT INTO {$this->p}labels (id,board_id,name,color,position) VALUES (?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE
                   name = IF(board_id = VALUES(board_id), VALUES(name), name),
                   color = IF(board_id = VALUES(board_id), VALUES(color), color),
                   position = IF(board_id = VALUES(board_id), VALUES(position), position)",
                [$lid, $boardId, $this->seal((string)($l['name'] ?? '')),
                    preg_match('/^#[0-9a-f]{6}$/', $color) ? $color : '#888888', $pos]
            );
        }
        $this->deleteMissing("{$this->p}labels", 'id', 'board_id', $boardId, $keep);
    }

    private function syncCards(string $boardId, array $cards): void
    {
        // Reject any card id that already belongs to another board, *before*
        // writing anything. The guarded upsert alone is not enough: it would
        // leave the other board's card row alone, but the loop carries on and
        // syncs this document's checklists, comments, attachments and activity
        // under that id — and each of those ends in deleteMissing(), which
        // would wipe the real card's child rows. Failing here rolls the whole
        // save back (the caller runs inside a transaction).
        if (!$this->idsOwnedBy(
            "{$this->p}cards", 'id', 'board_id', $boardId,
            array_column($cards, 'id')
        )) {
            throw new RuntimeException('That card id belongs to another board.');
        }

        // As for lists: moveCard appends the moved card to the array, so the
        // array order says nothing about its place in the list.
        $cards = self::byOrder($cards);
        $keep = [];
        $posByList = [];
        // The completed column arrives with schema v6. Before the migration
        // the flag is simply not stored, rather than failing every card write.
        $withDone = $this->schemaVersion() >= 6;
        // cover_id arrives with v8; before it the title image is not stored.
        $withCover = $this->schemaVersion() >= 8;
        $doneCol = ($withDone ? ',completed' : '') . ($withCover ? ',cover_id' : '');
        $doneVal = ($withDone ? ',?' : '') . ($withCover ? ',?' : '');
        $doneSet = $withDone ? ",
                   completed = IF(board_id = VALUES(board_id), VALUES(completed), completed)" : '';
        if ($withCover) {
            $doneSet .= ",\n                   cover_id = IF(board_id = VALUES(board_id), VALUES(cover_id), cover_id)";
        }
        // label_ids arrives with v9.
        $withLabels = $this->schemaVersion() >= 9;
        if ($withLabels) {
            $doneCol .= ',label_ids';
            $doneVal .= ',?';
            $doneSet .= ",\n                   label_ids = IF(board_id = VALUES(board_id), VALUES(label_ids), label_ids)";
        }
        // assignee_ids arrives with v11.
        $withPeople = $this->schemaVersion() >= 11;
        if ($withPeople) {
            $doneCol .= ',assignee_ids';
            $doneVal .= ',?';
            $doneSet .= ",\n                   assignee_ids = IF(board_id = VALUES(board_id), VALUES(assignee_ids), assignee_ids)";
        }
        foreach ($cards as $c) {
            $cid = (string)($c['id'] ?? '');
            if ($cid === '') {
                continue;
            }
            $keep[] = $cid;
            $listId = (string)($c['listId'] ?? '');
            $posByList[$listId] = ($posByList[$listId] ?? 0) + 65536;

            $this->run(
                "INSERT INTO {$this->p}cards
                   (id,board_id,list_id,title,description,due_date,position,archived,archived_at,created_at,updated_at{$doneCol})
                 VALUES (?,?,?,?,?,?,?,?,?,?,?{$doneVal})
                 ON DUPLICATE KEY UPDATE
                   list_id = IF(board_id = VALUES(board_id), VALUES(list_id), list_id),
                   title = IF(board_id = VALUES(board_id), VALUES(title), title),
                   description = IF(board_id = VALUES(board_id), VALUES(description), description),
                   due_date = IF(board_id = VALUES(board_id), VALUES(due_date), due_date),
                   position = IF(board_id = VALUES(board_id), VALUES(position), position),
                   archived = IF(board_id = VALUES(board_id), VALUES(archived), archived),
                   archived_at = IF(board_id = VALUES(board_id), VALUES(archived_at), archived_at),
                   updated_at = IF(board_id = VALUES(board_id), VALUES(updated_at), updated_at){$doneSet}",
                array_merge([
                    $cid, $boardId, $listId,
                    $this->seal((string)($c['title'] ?? '')),
                    $this->seal((string)($c['description'] ?? '')),
                    self::toDbDate($c['dueDate'] ?? null),
                    $posByList[$listId],
                    !empty($c['archived']) ? 1 : 0,
                    self::toDbTime($c['archivedAt'] ?? null),
                    self::toDbTime($c['createdAt'] ?? null) ?? gmdate(self::DB_TIME),
                    self::toDbTime($c['updatedAt'] ?? null) ?? gmdate(self::DB_TIME),
                ], $withDone ? [!empty($c['completed']) ? 1 : 0] : [], $withCover ? [($c['cover'] ?? null) ?: null] : [],
                   $withLabels ? [self::labelIdList($c['labels'] ?? [])] : [],
                   $withPeople ? [self::idList($c['assignees'] ?? [], 12, 400)] : [])
            );

            // Reject a document that tries to reuse ids owned by another card
            // before writing anything: the guarded upsert would ignore the
            // takeover, but a requested hijack should be a hard error.
            if (!$this->idsOwnedBy(
                "{$this->p}checklists", 'id', 'card_id', $cid,
                self::checklistIds($c['checklists'] ?? [], false)
            )) {
                throw new RuntimeException('That checklist id belongs to another card.');
            }
            $this->syncChecklists($cid, $c['checklists'] ?? []);
            // edited_at arrives with v12.
            $withEdited = $this->schemaVersion() >= 12;
            $this->syncSimple("{$this->p}comments", 'card_id', $cid, $c['comments'] ?? [], function ($m) use ($cid, $withEdited) {
                $args = [
                    (string)$m['id'], $cid, ($m['userId'] ?? null) ?: null,
                    (string)($m['username'] ?? ''), $this->seal((string)($m['text'] ?? '')),
                    self::toDbTime($m['createdAt'] ?? null) ?? gmdate(self::DB_TIME),
                ];
                if ($withEdited) {
                    $args[] = self::toDbTime($m['editedAt'] ?? null);
                    return [
                        'id' => (string)$m['id'],
                        'sql' => "INSERT INTO {$this->p}comments (id,card_id,user_id,author_name,body,created_at,edited_at)
                                  VALUES (?,?,?,?,?,?,?)
                                  ON DUPLICATE KEY UPDATE
                                    body = IF(card_id = VALUES(card_id), VALUES(body), body),
                                    edited_at = IF(card_id = VALUES(card_id), VALUES(edited_at), edited_at)",
                        'args' => $args,
                    ];
                }
                return [
                    'id' => (string)$m['id'],
                    'sql' => "INSERT INTO {$this->p}comments (id,card_id,user_id,author_name,body,created_at)
                              VALUES (?,?,?,?,?,?)
                              ON DUPLICATE KEY UPDATE
                                body = IF(card_id = VALUES(card_id), VALUES(body), body)",
                    'args' => $args,
                ];
            });
            $this->syncSimple("{$this->p}attachments", 'card_id', $cid, $c['attachments'] ?? [], function ($a) use ($cid) {
                return [
                    'id' => (string)$a['id'],
                    'sql' => "INSERT INTO {$this->p}attachments
                                (id,card_id,name,stored,mime,size_bytes,encrypted,user_id,author_name,uploaded_at)
                              VALUES (?,?,?,?,?,?,?,?,?,?)
                              ON DUPLICATE KEY UPDATE
                                name = IF(card_id = VALUES(card_id), VALUES(name), name),
                                mime = IF(card_id = VALUES(card_id), VALUES(mime), mime)",
                    'args' => [
                        (string)$a['id'], $cid, $this->seal((string)($a['name'] ?? '')), (string)($a['stored'] ?? ''),
                        (string)($a['mime'] ?? ''), (int)($a['size'] ?? 0), !empty($a['encrypted']) ? 1 : 0,
                        ($a['userId'] ?? null) ?: null, (string)($a['username'] ?? ''),
                        self::toDbTime($a['uploadedAt'] ?? null) ?? gmdate(self::DB_TIME),
                    ],
                ];
            });
            $this->syncSimple("{$this->p}activity", 'card_id', $cid, $c['activity'] ?? [], function ($a) use ($cid) {
                return [
                    'id' => (string)$a['id'],
                    'sql' => "INSERT INTO {$this->p}activity (id,card_id,user_id,author_name,text,created_at)
                              VALUES (?,?,?,?,?,?)
                              ON DUPLICATE KEY UPDATE
                                text = IF(card_id = VALUES(card_id), VALUES(text), text)",
                    'args' => [
                        (string)$a['id'], $cid, ($a['userId'] ?? null) ?: null,
                        (string)($a['username'] ?? ''), mb_substr((string)($a['text'] ?? ''), 0, 190),
                        self::toDbTime($a['createdAt'] ?? null) ?? gmdate(self::DB_TIME),
                    ],
                ];
            });
        }
        $this->deleteMissing("{$this->p}cards", 'id', 'board_id', $boardId, $keep);
    }

    /**
     * A checklist item's stored link (page title and icon), or null. The icon
     * is passed on only as a data: URI of a raster image type.
     *
     * @return array{url:string,title:?string,icon:?string}|null
     */
    private function itemLink(?string $meta, string $boardId): ?array
    {
        if ($meta === null || $meta === '') {
            return null;
        }
        $d = json_decode($this->open($meta, $boardId), true);
        if (!is_array($d) || !is_string($d['url'] ?? null) || $d['url'] === '') {
            return null;
        }
        $icon = is_string($d['icon'] ?? null) && preg_match('#^data:image/(png|jpeg|gif|webp|x-icon);base64,[A-Za-z0-9+/=]+$#', $d['icon'])
            ? $d['icon'] : null;
        return ['url' => $d['url'], 'title' => is_string($d['title'] ?? null) ? $d['title'] : null, 'icon' => $icon];
    }

    private function syncChecklists(string $cardId, array $checklists): void
    {
        $keep = [];
        $pos = 0;
        foreach ($checklists as $k) {
            $kid = (string)($k['id'] ?? '');
            if ($kid === '') {
                continue;
            }
            $keep[] = $kid;
            $pos += 65536;
            // The UPDATE is guarded by card_id: an id that already belongs to a
            // different card is never rewritten. Ids are global, so without this
            // a viewer could reuse another board's id and overwrite its row.
            $this->run(
                "INSERT INTO {$this->p}checklists (id,card_id,title,position) VALUES (?,?,?,?)
                 ON DUPLICATE KEY UPDATE
                   title = IF(card_id = VALUES(card_id), VALUES(title), title),
                   position = IF(card_id = VALUES(card_id), VALUES(position), position)",
                [$kid, $cardId, $this->seal((string)($k['title'] ?? '')), $pos]
            );
            $itemKeep = [];
            $ipos = 0;
            foreach ($k['items'] ?? [] as $t) {
                $tid = (string)($t['id'] ?? '');
                if ($tid === '') {
                    continue;
                }
                $itemKeep[] = $tid;
                $ipos += 65536;
                $assignee = (string)($t['assignee'] ?? '');
                $assignee = preg_match('/^[A-Za-z0-9_]{1,32}$/', $assignee) ? $assignee : null;
                if ($this->schemaVersion() >= 15) {
                    $link = is_array($t['link'] ?? null) ? $t['link'] : null;
                    $meta = $link === null ? null : $this->seal((string)json_encode([
                        'url' => (string)($link['url'] ?? ''),
                        'title' => isset($link['title']) ? (string)$link['title'] : null,
                        'icon' => isset($link['icon']) ? (string)$link['icon'] : null,
                    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
                    $this->run(
                        "INSERT INTO {$this->p}checklist_items (id,checklist_id,text,done,position,assignee_id,link_meta) VALUES (?,?,?,?,?,?,?)
                         ON DUPLICATE KEY UPDATE
                           text = IF(checklist_id = VALUES(checklist_id), VALUES(text), text),
                           done = IF(checklist_id = VALUES(checklist_id), VALUES(done), done),
                           position = IF(checklist_id = VALUES(checklist_id), VALUES(position), position),
                           assignee_id = IF(checklist_id = VALUES(checklist_id), VALUES(assignee_id), assignee_id),
                           link_meta = IF(checklist_id = VALUES(checklist_id), VALUES(link_meta), link_meta)",
                        [$tid, $kid, $this->seal((string)($t['text'] ?? '')), !empty($t['done']) ? 1 : 0, $ipos, $assignee, $meta]
                    );
                    continue;
                }
                if ($this->schemaVersion() >= 11) {
                    $this->run(
                        "INSERT INTO {$this->p}checklist_items (id,checklist_id,text,done,position,assignee_id) VALUES (?,?,?,?,?,?)
                         ON DUPLICATE KEY UPDATE
                           text = IF(checklist_id = VALUES(checklist_id), VALUES(text), text),
                           done = IF(checklist_id = VALUES(checklist_id), VALUES(done), done),
                           position = IF(checklist_id = VALUES(checklist_id), VALUES(position), position),
                           assignee_id = IF(checklist_id = VALUES(checklist_id), VALUES(assignee_id), assignee_id)",
                        [$tid, $kid, $this->seal((string)($t['text'] ?? '')), !empty($t['done']) ? 1 : 0, $ipos, $assignee]
                    );
                    continue;
                }
                $this->run(
                    "INSERT INTO {$this->p}checklist_items (id,checklist_id,text,done,position) VALUES (?,?,?,?,?)
                     ON DUPLICATE KEY UPDATE
                       text = IF(checklist_id = VALUES(checklist_id), VALUES(text), text),
                       done = IF(checklist_id = VALUES(checklist_id), VALUES(done), done),
                       position = IF(checklist_id = VALUES(checklist_id), VALUES(position), position)",
                    [$tid, $kid, $this->seal((string)($t['text'] ?? '')), !empty($t['done']) ? 1 : 0, $ipos]
                );
            }
            $this->deleteMissing("{$this->p}checklist_items", 'id', 'checklist_id', $kid, $itemKeep);
        }
        $this->deleteMissing("{$this->p}checklists", 'id', 'card_id', $cardId, $keep);
    }

    /**
     * True when every id in $ids is free or already belongs to $parentId.
     *
     * Callers use this to reject a document that tries to take over ids owned
     * by another card/board, instead of relying on the guarded upsert alone.
     *
     * @param array<int,string> $ids
     */
    private function idsOwnedBy(string $table, string $idCol, string $parentCol, string $parentId, array $ids): bool
    {
        $ids = array_values(array_filter($ids, fn($i) => $i !== ''));
        if ($ids === []) {
            return true;
        }
        $in = implode(',', array_fill(0, count($ids), '?'));
        $row = $this->row(
            "SELECT COUNT(*) AS n FROM {$table}
              WHERE {$idCol} IN ($in) AND {$parentCol} <> ?",
            array_merge($ids, [$parentId])
        );
        return ((int)($row['n'] ?? 0)) === 0;
    }

    /**
     * Collect checklist and/or item ids from a card document.
     *
     * @param bool $includeItems false returns only checklist ids
     */
    private static function checklistIds(array $checklists, bool $includeItems = true): array
    {
        $ids = [];
        foreach ($checklists as $k) {
            if (!empty($k['id'])) {
                $ids[] = (string)$k['id'];
            }
            if (!$includeItems) {
                continue;
            }
            foreach ($k['items'] ?? [] as $t) {
                if (!empty($t['id'])) {
                    $ids[] = (string)$t['id'];
                }
            }
        }
        return $ids;
    }

    /** @param callable(array):array{id:string,sql:string,args:array} $build */
    private function syncSimple(string $table, string $parentCol, string $parentId, array $items, callable $build): void
    {
        $keep = [];
        foreach ($items as $item) {
            if (!is_array($item) || ($item['id'] ?? '') === '') {
                continue;
            }
            $spec = $build($item);
            $keep[] = $spec['id'];
            $this->run($spec['sql'], $spec['args']);
        }
        $this->deleteMissing($table, 'id', $parentCol, $parentId, $keep);
    }

    /** Remove rows of a parent that the document no longer contains. */
    private function deleteMissing(string $table, string $idCol, string $parentCol, string $parentId, array $keep): void
    {
        if ($keep === []) {
            $this->run("DELETE FROM {$table} WHERE {$parentCol} = ?", [$parentId]);
            return;
        }
        $in = implode(',', array_fill(0, count($keep), '?'));
        $this->run(
            "DELETE FROM {$table} WHERE {$parentCol} = ? AND {$idCol} NOT IN ($in)",
            array_merge([$parentId], $keep)
        );
    }

    // -----------------------------------------------------------------
    // Share inbox
    // -----------------------------------------------------------------

    /**
     * Insert one inbox item and prune this user's older ones, without ever
     * loading the collection.
     *
     * Two rows matter: the item being added and the ones to drop. Everything is
     * scoped to the acting user except the age sweep, which is indexed on
     * created_at. There is no read-modify-write of a shared list, so concurrent
     * sharers cannot clobber each other.
     *
     * @param array<string,mixed> $item
     * @return array<int,array<string,mixed>> pruned items, so their files can go
     */
    public function addInboxItem(array $item, int $keepPerUser, int $maxAgeSeconds): array
    {
        $userId = (string)($item['userId'] ?? '');
        $cutoff = gmdate(self::DB_TIME, time() - $maxAgeSeconds);

        // Work out what will be pruned first, so the caller can clean files.
        $doomed = $this->rows(
            "SELECT id, user_id, title, body, url, created_at FROM {$this->p}inbox
              WHERE created_at < ?
                 OR (user_id = ? AND id NOT IN (
                       SELECT id FROM (
                         SELECT id FROM {$this->p}inbox
                          WHERE user_id = ?
                          ORDER BY created_at DESC
                          LIMIT {$keepPerUser}
                       ) AS keep_rows
                     ))",
            [$cutoff, $userId, $userId]
        );

        $this->saveInbox($item);

        if ($doomed === []) {
            return [];
        }

        // Read the files and build the documents while the rows still exist:
        // inbox_files cascades away with the DELETE, so inboxDoc() could not
        // find them afterwards and the caller would have nothing to unlink.
        $ids = array_map(fn($r) => (string)$r['id'], $doomed);
        $in = implode(',', array_fill(0, count($ids), '?'));
        $filesByInbox = [];
        foreach ($this->rows(
            "SELECT inbox_id, name, stored, mime, size_bytes FROM {$this->p}inbox_files WHERE inbox_id IN ($in)",
            $ids
        ) as $f) {
            $filesByInbox[(string)$f['inbox_id']][] = $f;
        }
        $docs = array_map(
            fn($r) => $this->inboxDoc($r, $filesByInbox[(string)$r['id']] ?? []),
            $doomed
        );
        $this->run("DELETE FROM {$this->p}inbox WHERE id IN ($in)", $ids);

        return $docs;
    }

    /**
     * One inbox item by id, scoped to its owner. Indexed lookup, no scan.
     *
     * @return array<string,mixed>|null
     */
    public function findInboxFor(string $inboxId, string $userId): ?array
    {
        if ($inboxId === '') {
            return null;
        }
        $r = $this->row(
            "SELECT * FROM {$this->p}inbox WHERE id = ? AND user_id = ?",
            [$inboxId, $userId]
        );
        return $r ? $this->inboxDoc($r) : null;
    }

    /**
     * Delete one inbox item, scoped to its owner. The affected-row count is the
     * whole point: it is what makes two concurrent claims of the same item safe,
     * because only the statement that removed the row returns true.
     */
    public function claimInboxItem(string $inboxId, string $userId): bool
    {
        if ($inboxId === '') {
            return false;
        }
        return $this->run(
            "DELETE FROM {$this->p}inbox WHERE id = ? AND user_id = ?",
            [$inboxId, $userId]
        ) > 0;
    }

    /**
     * @param array<int,array<string,mixed>>|null $fileRows the item's
     *        inbox_files rows when already loaded; null reads them here
     */
    private function inboxDoc(array $r, ?array $fileRows = null): array
    {
        $files = [];
        $scope = 'inbox:' . (string)$r['user_id'];
        $fileRows ??= $this->rows("SELECT * FROM {$this->p}inbox_files WHERE inbox_id = ?", [$r['id']]);
        foreach ($fileRows as $f) {
            $files[] = [
                'name' => AtRest::open((string)$f['name'], $scope),
                'stored' => (string)$f['stored'],
                'mime' => (string)$f['mime'],
                'size' => (int)$f['size_bytes'],
            ];
        }
        return [
            'id' => (string)$r['id'],
            'userId' => (string)$r['user_id'],
            'title' => AtRest::open((string)$r['title'], $scope),
            'text' => AtRest::open((string)($r['body'] ?? ''), $scope),
            'url' => AtRest::open((string)($r['url'] ?? ''), $scope),
            'files' => $files,
            'createdAt' => self::toIso($r['created_at']),
        ];
    }

    private function saveInbox(array $i): void
    {
        $scope = 'inbox:' . (string)($i['userId'] ?? '');
        $seal = fn(string $v): string => $this->sealing() ? AtRest::seal($v, $scope) : $v;
        $this->run(
            "INSERT INTO {$this->p}inbox (id,user_id,title,body,url,created_at) VALUES (?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE title = VALUES(title), body = VALUES(body), url = VALUES(url)",
            [
                (string)$i['id'], (string)($i['userId'] ?? ''), $seal((string)($i['title'] ?? '')),
                $seal((string)($i['text'] ?? '')), $seal((string)($i['url'] ?? '')),
                self::toDbTime($i['createdAt'] ?? null) ?? gmdate(self::DB_TIME),
            ]
        );
        foreach ($i['files'] ?? [] as $f) {
            $this->run(
                "INSERT INTO {$this->p}inbox_files (id,inbox_id,name,stored,mime,size_bytes) VALUES (?,?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE name = VALUES(name)",
                [
                    Helpers::newId('if_'), (string)$i['id'], $seal((string)($f['name'] ?? '')),
                    (string)($f['stored'] ?? ''), (string)($f['mime'] ?? ''), (int)($f['size'] ?? 0),
                ]
            );
        }
    }
}
