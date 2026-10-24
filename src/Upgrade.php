<?php
declare(strict_types=1);

/**
 * Bring an installation up to date: the one routine behind upgrade.php and the
 * installer's "Apply database updates" / --migrate.
 *
 *  1. Apply the schema (MysqlSchema::apply; idempotent).
 *  2. Make sure there is a master key. An installation from before encryption
 *     at rest has none, so one is generated into config.php (unless the key
 *     comes from the ROYAL_KANBAN_MASTER_KEY environment variable).
 *  3. Encrypt everything already stored under that key. Boards saved from now
 *     on are encrypted anyway; this covers the ones that are not touched.
 *
 * Every step is safe to repeat.
 */
final class Upgrade
{
    /** @return array{from:int,to:int,keyAdded:bool,resealed:int,files:int} */
    public static function run(MysqlStorage $store, string $prefix): array
    {
        $pdo = $store->pdo();
        $from = self::applied($pdo, $prefix);
        MysqlSchema::apply($pdo, $prefix);
        $to = self::applied($pdo, $prefix);

        $keyAdded = false;
        if (!AtRest::hasKey()) {
            AtRest::addKeyToConfig(RK_CONFIG_PATH);
            $keyAdded = true;
        }
        $resealed = $store->resealAll();
        // v14: the keyed hashes that find an account by its email (they
        // depend on the master key, so they are made after it exists).
        $store->backfillEmailHashes();
        $files = Uploads::sealAll();
        return ['from' => $from, 'to' => $to, 'keyAdded' => $keyAdded, 'resealed' => $resealed, 'files' => $files];
    }

    /** The schema version the database is at now (0 if unknown). */
    public static function applied(PDO $pdo, string $prefix): int
    {
        $p = MysqlSchema::sanitizePrefix($prefix);
        try {
            $row = $pdo->query("SELECT value FROM {$p}meta WHERE name = 'schema_version'")->fetch(PDO::FETCH_ASSOC);
            return $row ? (int)$row['value'] : 0;
        } catch (Throwable) {
            return 0;
        }
    }

    /** One line for a person: what happened. */
    public static function describe(array $r): string
    {
        $parts = [];
        $parts[] = $r['from'] === $r['to']
            ? "Schema already at version {$r['to']}."
            : "Schema upgraded from version {$r['from']} to {$r['to']}.";
        if ($r['keyAdded']) {
            $parts[] = 'A master key was generated and added to config.php. Back config.php up with the database: without the key the boards cannot be read.';
        }
        $parts[] = $r['resealed'] === 1 ? '1 board is encrypted in the database.' : "{$r['resealed']} boards are encrypted in the database.";
        if (($r['files'] ?? 0) > 0) {
            $parts[] = $r['files'] === 1 ? '1 stored file was encrypted.' : "{$r['files']} stored files were encrypted.";
        }
        return implode(' ', $parts);
    }
}
