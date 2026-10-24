<?php
declare(strict_types=1);

/**
 * Encryption at rest for board content in the database.
 *
 * Every board's text (its title, list titles, card titles and descriptions,
 * checklists, comments, attachment names) and pending shares are stored as
 * AES-256-GCM ciphertext under the installation's master key. install.php
 * generates the key into config.php ('master_key'); upgrade.php adds one to an
 * older installation and re-encrypts what is already stored. The database
 * alone, a dump or a backup, is therefore unreadable without config.php.
 *
 * This sits underneath the per-board end-to-end encryption, not instead of
 * it: on a board with its own password the browser already sends ciphertext,
 * and the master key wraps that again. The server can read an ordinary board
 * (it has the master key) but never an end-to-end board's content.
 *
 * A stored value is "rk1:" + base64(iv(12) || tag(16) || ciphertext), bound
 * with AAD to its scope ("board:<id>", "inbox:<userId>"), so a value cannot be
 * moved to another board or user. Anything without the prefix is plaintext
 * written before the key existed, and is returned as it is; it is encrypted
 * the next time that board is saved. An empty string stays empty.
 *
 * Files in uploads/ (attachments, board backgrounds, shared files) are sealed
 * the same way when they are written (Uploads) and opened by api/file.php as
 * they are served: FILE_MAGIC + iv || tag || ciphertext, AAD "file:<name>".
 */
final class AtRest
{
    public const PREFIX = 'rk1:';
    private const CIPHER = 'aes-256-gcm';

    private static ?string $key = null;

    /** Install the raw 32-byte key, or null for none. */
    public static function setKey(?string $raw): void
    {
        self::$key = ($raw !== null && strlen($raw) === 32) ? $raw : null;
    }

    public static function hasKey(): bool
    {
        return self::$key !== null;
    }

    /** A new key, as it is written to config.php (base64 of 32 random bytes). */
    public static function generateKey(): string
    {
        return base64_encode(random_bytes(32));
    }

    /** The raw key from its config.php form, or null when it is not valid. */
    public static function decodeKey(string $b64): ?string
    {
        $raw = base64_decode(trim($b64), true);
        return ($raw !== false && strlen($raw) === 32) ? $raw : null;
    }

    /**
     * A keyed hash for looking a value up without storing it readable (a
     * user's email, by address). Keyed with the master key when there is one,
     * so a copy of the database alone cannot test guesses against it.
     */
    public static function lookupHash(string $value, string $label): string
    {
        return hash_hmac('sha256', $label . "\0" . $value, self::$key ?? 'royal-tasks-no-key');
    }

    public static function isSealed(string $value): bool
    {
        return str_starts_with($value, self::PREFIX);
    }

    /**
     * Encrypt one value for its scope. Without a key, or when empty, unchanged.
     * A value that only looks sealed (user text starting "rk1:") is sealed
     * like any other: passing it through would store text that cannot be
     * opened, and every read of its board would fail. Callers re-sealing
     * stored data open it first (resealAll).
     */
    public static function seal(string $plain, string $aad): string
    {
        if ($plain === '' || self::$key === null) {
            return $plain;
        }
        $iv = random_bytes(12);
        $tag = '';
        $ct = openssl_encrypt($plain, self::CIPHER, self::$key, OPENSSL_RAW_DATA, $iv, $tag, $aad, 16);
        if ($ct === false) {
            throw new RuntimeException('Could not encrypt board data.');
        }
        return self::PREFIX . base64_encode($iv . $tag . $ct);
    }

    /**
     * Decrypt one value. Plaintext (no prefix) is returned as it is. A sealed
     * value that will not open is an error, never passed on as ciphertext.
     */
    public static function open(string $value, string $aad): string
    {
        if (!self::isSealed($value)) {
            return $value;
        }
        if (self::$key === null) {
            throw new RuntimeException('Board data is encrypted but config.php has no master_key.');
        }
        $bin = base64_decode(substr($value, strlen(self::PREFIX)), true);
        if ($bin === false || strlen($bin) < 28) {
            throw new RuntimeException('Stored board data is damaged.');
        }
        $plain = openssl_decrypt(substr($bin, 28), self::CIPHER, self::$key, OPENSSL_RAW_DATA, substr($bin, 0, 12), substr($bin, 12, 16), $aad);
        if ($plain === false) {
            throw new RuntimeException('Stored board data could not be decrypted. Is master_key in config.php the right one?');
        }
        return $plain;
    }

    /** Marks a file in uploads/ as sealed: magic, then iv(12) || tag(16) || ciphertext. */
    public const FILE_MAGIC = "RKF1";

    /**
     * Encrypt a file's bytes. The AAD names the file ("file:<stored name>"),
     * so bytes cannot be swapped between two stored files. Without a key the
     * bytes are returned unchanged. Always seals, even bytes that begin with
     * the magic (an uploaded file can); Uploads::sealFile skips files that
     * are already sealed on disk before calling this.
     */
    public static function sealBytes(string $data, string $aad): string
    {
        if (self::$key === null) {
            return $data;
        }
        $iv = random_bytes(12);
        $tag = '';
        $ct = openssl_encrypt($data, self::CIPHER, self::$key, OPENSSL_RAW_DATA, $iv, $tag, $aad, 16);
        if ($ct === false) {
            throw new RuntimeException('Could not encrypt the file.');
        }
        return self::FILE_MAGIC . $iv . $tag . $ct;
    }

    /** Decrypt a file's bytes; a file stored before the key existed passes through. */
    public static function openBytes(string $data, string $aad): string
    {
        if (!str_starts_with($data, self::FILE_MAGIC)) {
            return $data;
        }
        if (self::$key === null) {
            throw new RuntimeException('The file is encrypted but config.php has no master_key.');
        }
        $m = strlen(self::FILE_MAGIC);
        if (strlen($data) < $m + 28) {
            throw new RuntimeException('The stored file is damaged.');
        }
        $plain = openssl_decrypt(substr($data, $m + 28), self::CIPHER, self::$key, OPENSSL_RAW_DATA,
            substr($data, $m, 12), substr($data, $m + 12, 16), $aad);
        if ($plain === false) {
            throw new RuntimeException('The stored file could not be decrypted.');
        }
        return $plain;
    }

    /**
     * Add a master key to config.php, keeping everything else in the file.
     *
     * The key goes in as the first entry of the returned array, so comments
     * and formatting survive. The file is re-read afterwards to prove the key
     * is really there; on any doubt the original is put back.
     *
     * @return string the new key (base64), already active in this process
     */
    public static function addKeyToConfig(string $configFile): string
    {
        if (!is_file($configFile) || !is_writable($configFile)) {
            throw new RuntimeException('config.php is not writable here. Run "php upgrade.php" from a shell as the file\'s owner.');
        }
        $original = (string)file_get_contents($configFile);
        if (!preg_match('/return\s*(\[|array\s*\()/', $original, $m, PREG_OFFSET_CAPTURE)) {
            throw new RuntimeException('config.php does not have the expected "return [ ... ];" shape; add master_key by hand.');
        }
        $key = self::generateKey();
        $at = $m[0][1] + strlen($m[0][0]);
        $line = "\n    // Encrypts every board in the database. Keep it: without it the boards\n"
            . "    // cannot be read. Back it up with the database; never commit it.\n"
            . "    'master_key' => '" . $key . "',\n";
        $updated = substr($original, 0, $at) . $line . substr($original, $at);
        if (file_put_contents($configFile, $updated, LOCK_EX) === false) {
            throw new RuntimeException('Could not write config.php.');
        }
        if (function_exists('opcache_invalidate')) {
            @opcache_invalidate($configFile, true);
        }
        $check = (static fn(string $f) => include $f)($configFile);
        if (!is_array($check) || ($check['master_key'] ?? null) !== $key || !is_array($check['db'] ?? null)) {
            file_put_contents($configFile, $original, LOCK_EX);
            throw new RuntimeException('config.php could not be updated safely; it was left as it was.');
        }
        self::setKey(self::decodeKey($key));
        return $key;
    }
}
