<?php
declare(strict_types=1);

/**
 * MySQL / MariaDB schema for Royal Tasks.
 *
 * Kept as PHP rather than a .sql file on purpose: in a single-folder install
 * src/ lives inside the document root, where a .sql file would be served
 * verbatim like any other static file. PHP is executed instead. It also lets
 * the table prefix be substituted, so the app can share a database with an
 * existing site — the usual situation on shared hosting, where you get one
 * database and everything lives in it.
 *
 * ---------------------------------------------------------------------------
 * Designed for ~1000 users: at that scale, with clients polling every few
 * seconds, a request must never read the whole dataset. Every access path
 * below is therefore indexed so a query touches only the rows it needs:
 *
 *   - sign in            -> UNIQUE (username), one row, no scan
 *   - a user's boards    -> board_members (user_id), then boards by id
 *   - one board's cards  -> cards (board_id, archived)
 *   - what changed       -> boards (updated_at) per board, not one global counter
 *   - delete a board     -> ON DELETE CASCADE, one statement, not a PHP loop
 *
 * Card and list order is a DECIMAL position rather than a 0..n integer, so
 * moving a card writes one row instead of renumbering the whole list. The
 * gap between neighbours can be subdivided about 30 times before it needs
 * renormalising; see reorder() in the storage class.
 */
final class MysqlSchema
{
    /** Bump when the DDL changes; `rk_meta.schema_version` records what is applied. */
    public const VERSION = 15;

    public const DEFAULT_PREFIX = 'rk_';

    /**
     * Identifiers minted by Helpers::newId() are 18 characters ("b_" plus 16
     * hex); one legacy id is 24. 32 leaves room and stays short enough for
     * fast index comparisons. ASCII with a binary collation: ids are compared
     * for equality only, so there is no reason to pay for Unicode collation.
     */
    private const ID = 'VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin';

    private const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

    /**
     * Timestamps keep milliseconds. Plain DATETIME truncates to the second,
     * which loses precision on imported data and makes the order of two
     * comments written in the same second arbitrary.
     */
    private const TIME = 'DATETIME(3)';

    /** Order key. 10 decimal places allows ~30 subdivisions between neighbours. */
    private const POSITION = 'DECIMAL(20,10) NOT NULL DEFAULT 0';

    /**
     * @return array<int,string> CREATE TABLE statements, in dependency order.
     */
    public static function statements(string $prefix = self::DEFAULT_PREFIX): array
    {
        $p = self::sanitizePrefix($prefix);
        $id = self::ID;
        $t = self::TABLE;
        $pos = self::POSITION;

        return [

            // ---------------------------------------------------------------
            // Accounts
            // ---------------------------------------------------------------
            "CREATE TABLE IF NOT EXISTS {$p}users (
                id                    {$id} NOT NULL,
                username              VARCHAR(40)  NOT NULL,
                display_name          VARCHAR(80)  NOT NULL DEFAULT '',
                role                  ENUM('user','admin') NOT NULL DEFAULT 'user',
                password_hash         VARCHAR(255) NOT NULL,
                must_change_password  TINYINT(1)   NOT NULL DEFAULT 0,
                password_changed_at   DATETIME(3)     NULL,
                /* The profile (v10): an email address, sealed at rest (AAD
                   user:<id>) like board content, and the avatar: a stored file
                   under uploads/avatars, served by api/avatar.php. */
                email                 TEXT            NULL,
                avatar                VARCHAR(255) NOT NULL DEFAULT '',
                created_at            DATETIME(3)     NOT NULL,
                PRIMARY KEY (id),
                /* Sign-in looks a user up by name. Unique both enforces the
                   rule the app checks in PHP today and makes it one row. */
                UNIQUE KEY uq_username (username)
            ) {$t}",

            // ---------------------------------------------------------------
            // Boards and membership
            // ---------------------------------------------------------------
            "CREATE TABLE IF NOT EXISTS {$p}boards (
                id            {$id} NOT NULL,
                title         TEXT NOT NULL,
                color_scheme  VARCHAR(16)  NOT NULL DEFAULT 'palmbeach',
                /* Optional board background image: the stored file under
                   uploads/ and its MIME type. Empty when the board uses its
                   colour scheme alone. */
                background_image  VARCHAR(255) NOT NULL DEFAULT '',
                background_mime   VARCHAR(100) NOT NULL DEFAULT '',
                owner_id      {$id} NULL,
                /* Optimistic locking: a write must state the version it read. */
                version       INT UNSIGNED NOT NULL DEFAULT 1,
                created_at    DATETIME(3) NOT NULL,
                updated_at    DATETIME(3) NOT NULL,
                PRIMARY KEY (id),
                KEY idx_owner (owner_id),
                /* Polling asks 'which of my boards changed since X'. Per-board
                   timestamps replace the single global counter, which would be
                   a contended hot row with a thousand clients. */
                KEY idx_updated (updated_at),
                CONSTRAINT fk_board_owner FOREIGN KEY (owner_id)
                    REFERENCES {$p}users (id) ON DELETE SET NULL
            ) {$t}",

            "CREATE TABLE IF NOT EXISTS {$p}board_members (
                board_id  {$id} NOT NULL,
                user_id   {$id} NOT NULL,
                access    ENUM('view','edit') NOT NULL DEFAULT 'view',
                added_at  DATETIME(3) NOT NULL,
                PRIMARY KEY (board_id, user_id),
                /* The reverse lookup — 'which boards does this user see' — is
                   the hot query on every page load and every poll. */
                KEY idx_member_user (user_id, board_id),
                CONSTRAINT fk_member_board FOREIGN KEY (board_id)
                    REFERENCES {$p}boards (id) ON DELETE CASCADE,
                CONSTRAINT fk_member_user FOREIGN KEY (user_id)
                    REFERENCES {$p}users (id) ON DELETE CASCADE
            ) {$t}",

            // ---------------------------------------------------------------
            // Client-side encryption
            // ---------------------------------------------------------------
            /* One row per encrypted board. The server never sees the password
               or the board key: it stores the KDF parameters needed to derive
               the key-encryption key, the board key wrapped under it, and
               (optionally) the board key wrapped under the owner's recovery
               key. When a row is absent the board is stored as plaintext. */
            "CREATE TABLE IF NOT EXISTS {$p}board_keys (
                board_id              {$id} NOT NULL,
                kdf_alg               VARCHAR(32)  NOT NULL DEFAULT 'argon2id13',
                kdf_salt              VARCHAR(64)  NOT NULL,
                kdf_opslimit          BIGINT UNSIGNED NOT NULL,
                kdf_memlimit          BIGINT UNSIGNED NOT NULL,
                wrapped_key           TEXT NOT NULL,
                recovery_wrapped_key  TEXT NULL,
                created_at            DATETIME(3) NOT NULL,
                updated_at            DATETIME(3) NOT NULL,
                PRIMARY KEY (board_id),
                CONSTRAINT fk_board_key_board FOREIGN KEY (board_id)
                    REFERENCES {$p}boards (id) ON DELETE CASCADE
            ) {$t}",

            // ---------------------------------------------------------------
            // Lists and cards
            // ---------------------------------------------------------------
            "CREATE TABLE IF NOT EXISTS {$p}lists (
                id        {$id} NOT NULL,
                board_id  {$id} NOT NULL,
                title     TEXT NOT NULL,
                position  {$pos},
                PRIMARY KEY (id),
                KEY idx_list_board (board_id, position),
                CONSTRAINT fk_list_board FOREIGN KEY (board_id)
                    REFERENCES {$p}boards (id) ON DELETE CASCADE
            ) {$t}",

            /* A board's labels (at most 10): a name and a colour each. The name
               is content, so it is sealed at rest (TEXT for the ciphertext);
               the colour is a #rrggbb like the colour scheme. Cards refer to
               labels by id in cards.label_ids. v9. */
            "CREATE TABLE IF NOT EXISTS {$p}labels (
                id        {$id} NOT NULL,
                board_id  {$id} NOT NULL,
                name      TEXT NOT NULL,
                color     CHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '#888888',
                position  {$pos},
                PRIMARY KEY (id),
                KEY idx_label_board (board_id, position),
                CONSTRAINT fk_label_board FOREIGN KEY (board_id)
                    REFERENCES {$p}boards (id) ON DELETE CASCADE
            ) {$t}",

            "CREATE TABLE IF NOT EXISTS {$p}cards (
                id           {$id} NOT NULL,
                board_id     {$id} NOT NULL,
                list_id      {$id} NOT NULL,
                /* TEXT, not VARCHAR: on an encrypted board this holds
                   base64(nonce || ciphertext), which is wider than the
                   plaintext the server used to enforce a limit on. */
                title        TEXT NOT NULL,
                /* The app caps descriptions at 20 000 characters. In utf8mb4 a
                   character can be 4 bytes, so the worst case is 80 000 —
                   past TEXT's 65 535 byte limit, where MySQL would silently
                   truncate. MEDIUMTEXT has the headroom. */
                description  MEDIUMTEXT NULL,
                due_date     DATE NULL,
                position     {$pos},
                archived     TINYINT(1) NOT NULL DEFAULT 0,
                completed    TINYINT(1) NOT NULL DEFAULT 0,
                /* The card's labels: ids from this board's labels table,
                   comma-separated, in the order they were added (v9). */
                label_ids    VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
                /* The people the card is assigned to: user ids of this
                   board's owner and members, comma-separated (v11). */
                assignee_ids VARCHAR(400) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
                archived_at  DATETIME(3) NULL,
                created_at   DATETIME(3) NOT NULL,
                updated_at   DATETIME(3) NOT NULL,
                PRIMARY KEY (id),
                /* The board view reads unarchived cards; the archive dialog
                   reads archived ones. Both are this one index. */
                KEY idx_card_board (board_id, archived),
                KEY idx_card_list (list_id, position),
                CONSTRAINT fk_card_board FOREIGN KEY (board_id)
                    REFERENCES {$p}boards (id) ON DELETE CASCADE,
                CONSTRAINT fk_card_list FOREIGN KEY (list_id)
                    REFERENCES {$p}lists (id) ON DELETE CASCADE
            ) {$t}",

            // ---------------------------------------------------------------
            // Card contents
            // ---------------------------------------------------------------
            "CREATE TABLE IF NOT EXISTS {$p}checklists (
                id        {$id} NOT NULL,
                card_id   {$id} NOT NULL,
                title     TEXT NOT NULL,
                position  {$pos},
                PRIMARY KEY (id),
                KEY idx_checklist_card (card_id, position),
                CONSTRAINT fk_checklist_card FOREIGN KEY (card_id)
                    REFERENCES {$p}cards (id) ON DELETE CASCADE
            ) {$t}",

            "CREATE TABLE IF NOT EXISTS {$p}checklist_items (
                id            {$id} NOT NULL,
                checklist_id  {$id} NOT NULL,
                text          TEXT NOT NULL,
                done          TINYINT(1) NOT NULL DEFAULT 0,
                /* Who the item is assigned to: one user of the board (v11). */
                assignee_id   {$id} NULL,
                /* A web-address item's page title and icon, sealed JSON (v15). */
                link_meta     MEDIUMTEXT NULL,
                position      {$pos},
                PRIMARY KEY (id),
                KEY idx_item_checklist (checklist_id, position),
                CONSTRAINT fk_item_checklist FOREIGN KEY (checklist_id)
                    REFERENCES {$p}checklists (id) ON DELETE CASCADE
            ) {$t}",

            "CREATE TABLE IF NOT EXISTS {$p}comments (
                id           {$id} NOT NULL,
                card_id      {$id} NOT NULL,
                /* Nullable with SET NULL, plus the name kept alongside: a
                   deleted account must not erase or falsify the history. */
                user_id      {$id} NULL,
                author_name  VARCHAR(80) NOT NULL,
                body         TEXT NOT NULL,
                created_at   DATETIME(3) NOT NULL,
                PRIMARY KEY (id),
                KEY idx_comment_card (card_id, created_at),
                CONSTRAINT fk_comment_card FOREIGN KEY (card_id)
                    REFERENCES {$p}cards (id) ON DELETE CASCADE,
                CONSTRAINT fk_comment_user FOREIGN KEY (user_id)
                    REFERENCES {$p}users (id) ON DELETE SET NULL
            ) {$t}",

            "CREATE TABLE IF NOT EXISTS {$p}attachments (
                id           {$id} NOT NULL,
                card_id      {$id} NOT NULL,
                name         TEXT NOT NULL,
                /* Relative path under the uploads directory. The bytes stay on
                   disk: 12 MB blobs in a row make every query that touches the
                   table expensive and bloat every backup. */
                stored       VARCHAR(255) NOT NULL,
                mime         VARCHAR(100) NOT NULL,
                size_bytes   BIGINT UNSIGNED NOT NULL DEFAULT 0,
                /* Ciphertext bytes are served as application/octet-stream and
                   decrypted in the browser; name is then ciphertext too. */
                encrypted    TINYINT(1) NOT NULL DEFAULT 0,
                user_id      {$id} NULL,
                author_name  VARCHAR(80) NOT NULL,
                uploaded_at  DATETIME(3) NOT NULL,
                PRIMARY KEY (id),
                KEY idx_attachment_card (card_id),
                /* Finding the row for a served file, and proving no other card
                   still references it before deleting from disk. */
                UNIQUE KEY uq_attachment_stored (stored),
                CONSTRAINT fk_attachment_card FOREIGN KEY (card_id)
                    REFERENCES {$p}cards (id) ON DELETE CASCADE,
                CONSTRAINT fk_attachment_user FOREIGN KEY (user_id)
                    REFERENCES {$p}users (id) ON DELETE SET NULL
            ) {$t}",

            "CREATE TABLE IF NOT EXISTS {$p}activity (
                id           {$id} NOT NULL,
                card_id      {$id} NOT NULL,
                user_id      {$id} NULL,
                author_name  VARCHAR(80) NOT NULL,
                text         VARCHAR(190) NOT NULL,
                created_at   DATETIME(3) NOT NULL,
                PRIMARY KEY (id),
                /* Grows fastest of any table — a row per action. The card
                   dialog shows the newest 20, which this index serves without
                   reading the rest. Prune old rows periodically. */
                KEY idx_activity_card (card_id, created_at),
                CONSTRAINT fk_activity_card FOREIGN KEY (card_id)
                    REFERENCES {$p}cards (id) ON DELETE CASCADE,
                CONSTRAINT fk_activity_user FOREIGN KEY (user_id)
                    REFERENCES {$p}users (id) ON DELETE SET NULL
            ) {$t}",

            // ---------------------------------------------------------------
            // Share-target inbox
            // ---------------------------------------------------------------
            "CREATE TABLE IF NOT EXISTS {$p}inbox (
                id          {$id} NOT NULL,
                user_id     {$id} NOT NULL,
                title       TEXT NOT NULL,
                body        TEXT NULL,
                url         TEXT NULL,
                created_at  DATETIME(3) NOT NULL,
                PRIMARY KEY (id),
                /* Per-user cap and the 7-day prune both scan by these. */
                KEY idx_inbox_user (user_id, created_at),
                /* The age sweep is global, so it needs its own prefix. */
                KEY idx_inbox_created (created_at),
                CONSTRAINT fk_inbox_user FOREIGN KEY (user_id)
                    REFERENCES {$p}users (id) ON DELETE CASCADE
            ) {$t}",

            "CREATE TABLE IF NOT EXISTS {$p}inbox_files (
                id          {$id} NOT NULL,
                inbox_id    {$id} NOT NULL,
                name        TEXT NOT NULL,
                stored      VARCHAR(255) NOT NULL,
                mime        VARCHAR(100) NOT NULL,
                size_bytes  BIGINT UNSIGNED NOT NULL DEFAULT 0,
                PRIMARY KEY (id),
                KEY idx_inbox_file (inbox_id),
                CONSTRAINT fk_inbox_file FOREIGN KEY (inbox_id)
                    REFERENCES {$p}inbox (id) ON DELETE CASCADE
            ) {$t}",

            // ---------------------------------------------------------------
            // Operational
            // ---------------------------------------------------------------
            "CREATE TABLE IF NOT EXISTS {$p}login_attempts (
                bucket        VARCHAR(16) NOT NULL,
                subject_hash  CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                window_start  DATETIME(3) NOT NULL,
                attempts      INT UNSIGNED NOT NULL DEFAULT 0,
                PRIMARY KEY (bucket, subject_hash),
                /* Sweeping expired windows. The file-based limiter this
                   replaces would leave a small file per username per IP. */
                KEY idx_window (window_start)
            ) {$t}",

            /* "Stay signed in": one row per remembered device. The cookie holds
               selector.validator; only a SHA-256 of the validator is kept, so
               a copy of this table cannot sign anyone in. pw_stamp ties the
               row to the password it was issued under: changing the password
               retires every remembered device. v6. */
            "CREATE TABLE IF NOT EXISTS {$p}auth_tokens (
                selector        CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                user_id         {$id} NOT NULL,
                validator_hash  CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                pw_stamp        CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                created_at      DATETIME(3) NOT NULL,
                last_used_at    DATETIME(3) NOT NULL,
                expires_at      DATETIME(3) NOT NULL,
                PRIMARY KEY (selector),
                KEY idx_token_user (user_id, last_used_at),
                KEY idx_token_expires (expires_at),
                CONSTRAINT fk_token_user FOREIGN KEY (user_id)
                    REFERENCES {$p}users (id) ON DELETE CASCADE
            ) {$t}",

            /* v13: a user's calendar subscription. The address's token is
               looked up by its SHA-256 and kept sealed (AAD calendar:<user>)
               so the preferences can show the address again. board_ids is
               a comma list; empty means every board. */
            "CREATE TABLE IF NOT EXISTS {$p}calendar_feeds (
                user_id     {$id} NOT NULL,
                token_hash  CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                token       TEXT NOT NULL,
                scope       VARCHAR(8) NOT NULL DEFAULT 'mine',
                board_ids   TEXT NOT NULL,
                created_at  DATETIME(3) NOT NULL,
                PRIMARY KEY (user_id),
                UNIQUE KEY uq_calendar_token (token_hash),
                CONSTRAINT fk_calfeed_user FOREIGN KEY (user_id)
                    REFERENCES {$p}users (id) ON DELETE CASCADE
            ) {$t}",

            /* v13: what a card on an end-to-end board is called in one user's
               calendar (the server cannot read its title). Sealed at rest
               (AAD calname:<user>), but not end-to-end: the feed needs it. */
            "CREATE TABLE IF NOT EXISTS {$p}calendar_names (
                user_id  {$id} NOT NULL,
                card_id  {$id} NOT NULL,
                name     TEXT NOT NULL,
                PRIMARY KEY (user_id, card_id),
                KEY idx_calname_card (card_id),
                CONSTRAINT fk_calname_user FOREIGN KEY (user_id)
                    REFERENCES {$p}users (id) ON DELETE CASCADE,
                CONSTRAINT fk_calname_card FOREIGN KEY (card_id)
                    REFERENCES {$p}cards (id) ON DELETE CASCADE
            ) {$t}",

            /* v14: site settings an administrator changes in the app. */
            "CREATE TABLE IF NOT EXISTS {$p}settings (
                name   VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                value  TEXT NOT NULL,
                PRIMARY KEY (name)
            ) {$t}",

            /* v14: one-time links sent by email: an invitation to make an
               account, or a link to set a new password. Looked up by the
               SHA-256 of the token in the link; the address is sealed
               (AAD link:<token_hash>). used_at marks it spent. */
            "CREATE TABLE IF NOT EXISTS {$p}email_links (
                token_hash  CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                kind        VARCHAR(8) NOT NULL,
                user_id     {$id} NULL,
                email       TEXT NOT NULL,
                name        VARCHAR(80) NOT NULL DEFAULT '',
                role        VARCHAR(8) NOT NULL DEFAULT 'user',
                created_by  {$id} NULL,
                created_at  DATETIME(3) NOT NULL,
                expires_at  DATETIME(3) NOT NULL,
                used_at     DATETIME(3) NULL,
                PRIMARY KEY (token_hash),
                KEY idx_link_kind (kind, expires_at),
                KEY idx_link_user (user_id),
                CONSTRAINT fk_link_user FOREIGN KEY (user_id)
                    REFERENCES {$p}users (id) ON DELETE CASCADE
            ) {$t}",

            "CREATE TABLE IF NOT EXISTS {$p}meta (
                name   VARCHAR(64) NOT NULL,
                value  BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (name)
            ) {$t}",
        ];
    }

    /**
     * Create anything missing. Safe to run repeatedly: every statement is
     * IF NOT EXISTS, so this doubles as the upgrade path for added tables.
     * Column changes that cannot be expressed that way live in upgrade().
     */
    public static function apply(PDO $pdo, string $prefix = self::DEFAULT_PREFIX): void
    {
        $p = self::sanitizePrefix($prefix);
        foreach (self::statements($p) as $sql) {
            $pdo->exec($sql);
        }

        $row = $pdo->query("SELECT value FROM {$p}meta WHERE name = 'schema_version'")->fetch(PDO::FETCH_ASSOC);
        $applied = $row ? (int)$row['value'] : 0;
        if ($applied < self::VERSION) {
            self::upgrade($pdo, $p, $applied);
            $pdo->prepare(
                "INSERT INTO {$p}meta (name, value) VALUES ('schema_version', :v)
                 ON DUPLICATE KEY UPDATE value = VALUES(value)"
            )->execute([':v' => self::VERSION]);
        }
        // Column and index checks run on every apply(), not only when the
        // version is behind. The version gate alone left a database that was
        // stamped ahead of its actual shape — a column added by a release whose
        // ALTER failed, or a version row written without the DDL — permanently
        // missing that column, because the gate then skipped the only code that
        // adds it. These calls are idempotent, so running them always is free.
        self::ensureColumns($pdo, $p);
        $pdo->exec("INSERT IGNORE INTO {$p}meta (name, value) VALUES ('change_counter', 1)");
    }

    /**
     * Bring every column and index this version needs into existence.
     *
     * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
     * so new columns reach an existing install only through here. Each check is
     * guarded by information_schema, so this is safe to run on every request
     * that applies the schema.
     */
    private static function ensureColumns(PDO $pdo, string $p): void
    {
        self::addColumnIfMissing($pdo, $p, 'attachments', 'encrypted', "TINYINT(1) NOT NULL DEFAULT 0");
        self::addColumnIfMissing($pdo, $p, 'boards', 'background_image', "VARCHAR(255) NOT NULL DEFAULT ''");
        self::addColumnIfMissing($pdo, $p, 'boards', 'background_mime', "VARCHAR(100) NOT NULL DEFAULT ''");
        // v6: the card's "Mark complete" tick.
        self::addColumnIfMissing($pdo, $p, 'cards', 'completed', "TINYINT(1) NOT NULL DEFAULT 0");
        // v8: the card's title image, one of its own attachments.
        self::addColumnIfMissing($pdo, $p, 'cards', 'cover_id', "VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL");
        // v10: the profile's email and avatar.
        self::addColumnIfMissing($pdo, $p, 'users', 'email', "TEXT NULL");
        self::addColumnIfMissing($pdo, $p, 'users', 'avatar', "VARCHAR(255) NOT NULL DEFAULT ''");
        // v11: who a card and a checklist item are assigned to.
        self::addColumnIfMissing($pdo, $p, 'cards', 'assignee_ids', "VARCHAR(400) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT ''");
        self::addColumnIfMissing($pdo, $p, 'checklist_items', 'assignee_id', "VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL");
        // v15: a web-address checklist item's page title and site icon.
        self::addColumnIfMissing($pdo, $p, 'checklist_items', 'link_meta', "MEDIUMTEXT NULL");
        // v12: when a comment was last edited (NULL: never).
        self::addColumnIfMissing($pdo, $p, 'comments', 'edited_at', "DATETIME(3) NULL");
        // v14: a keyed hash of the profile email, to find an account by its
        // address (forgotten password) without the address being readable.
        self::addColumnIfMissing($pdo, $p, 'users', 'email_hash', "CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL");
        self::addIndexIfMissing($pdo, $p, 'users', 'idx_user_email', '(email_hash)');
        // v9: the card's labels (the labels table itself is CREATE IF NOT EXISTS).
        self::addColumnIfMissing($pdo, $p, 'cards', 'label_ids', "VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT ''");
        self::addIndexIfMissing($pdo, $p, 'inbox', 'idx_inbox_created', '(created_at)');
    }

    /**
     * Structural migrations that are not expressible as "add a column if it is
     * missing". VARCHAR columns had to become TEXT for encrypted content, which
     * is wider than the plaintext the length limits used to allow. MODIFY is
     * idempotent, so re-running changes nothing.
     *
     * Column and index additions live in ensureColumns(), which runs on every
     * apply() rather than only when the version is behind.
     */
    private static function upgrade(PDO $pdo, string $p, int $from): void
    {
        if ($from < 7) {
            // v7: board content is encrypted at rest (AtRest); ciphertext is
            // longer than the plaintext these columns were sized for.
            foreach ([
                "ALTER TABLE {$p}boards MODIFY title TEXT NOT NULL",
                "ALTER TABLE {$p}inbox MODIFY title TEXT NOT NULL",
                "ALTER TABLE {$p}inbox MODIFY url TEXT NULL",
                "ALTER TABLE {$p}inbox_files MODIFY name TEXT NOT NULL",
            ] as $sql) {
                $pdo->exec($sql);
            }
        }
        if ($from < 3) {
            $widens = [
                "ALTER TABLE {$p}cards MODIFY title TEXT NOT NULL",
                "ALTER TABLE {$p}lists MODIFY title TEXT NOT NULL",
                "ALTER TABLE {$p}checklists MODIFY title TEXT NOT NULL",
                "ALTER TABLE {$p}checklist_items MODIFY text TEXT NOT NULL",
                "ALTER TABLE {$p}attachments MODIFY name TEXT NOT NULL",
            ];
            foreach ($widens as $sql) {
                $pdo->exec($sql);
            }
        }
    }

    private static function addColumnIfMissing(PDO $pdo, string $p, string $table, string $column, string $definition): void
    {
        $n = (int)$pdo->query(
            "SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = '{$p}{$table}' AND column_name = '{$column}'"
        )->fetchColumn();
        if ($n === 0) {
            $pdo->exec("ALTER TABLE {$p}{$table} ADD COLUMN {$column} {$definition}");
        }
    }

    private static function addIndexIfMissing(PDO $pdo, string $p, string $table, string $index, string $columns): void
    {
        $n = (int)$pdo->query(
            "SELECT COUNT(*) FROM information_schema.statistics
              WHERE table_schema = DATABASE() AND table_name = '{$p}{$table}' AND index_name = '{$index}'"
        )->fetchColumn();
        if ($n === 0) {
            $pdo->exec("ALTER TABLE {$p}{$table} ADD INDEX {$index} {$columns}");
        }
    }

    /**
     * A table prefix is interpolated into DDL, so it can never come from
     * anywhere but a fixed pattern.
     */
    public static function sanitizePrefix(string $prefix): string
    {
        if ($prefix === '') {
            return '';
        }
        if (!preg_match('/^[A-Za-z][A-Za-z0-9_]{0,20}$/', $prefix)) {
            throw new InvalidArgumentException(
                'Table prefix must start with a letter and contain only letters, digits and underscores.'
            );
        }
        return $prefix;
    }
}
