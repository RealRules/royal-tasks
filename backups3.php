<?php
declare(strict_types=1);

/**
 * Royal Tasks: back up the database and the uploaded files to S3.
 *
 *     php backups3.php [backup]         back up everything (the default)
 *     php backups3.php list             the backups in the bucket
 *     php backups3.php restore [NAME]   put a backup back (default: the latest)
 *     php backups3.php delete NAME...   delete database backups from the bucket
 *     php backups3.php delete --all     delete everything under the prefix
 *     php backups3.php help
 *
 *   Options:
 *     --db-only, --uploads-only  only the database, or only the files
 *     --dry-run                  show what would happen, change nothing
 *     --full                     backup: send every file again, not just changes
 *     --yes                      restore/delete: do not ask for confirmation
 *     --to=FILE                  restore: only download the dump to FILE
 *     --config=FILE              read the settings from FILE instead of
 *                                configs3.php next to this script
 *
 *   NAME is what `list` shows (royal-tasks-20260928-031500), the file name,
 *   or "latest".
 *
 * Settings live in configs3.php, next to this script: copy
 * configs3.example.php (every setting is explained there, with examples for
 * Hetzner and AWS) and fill it in. This file holds no settings of its own
 * beyond defaults, so a newer version can replace it without losing them.
 * Keep configs3.php private (chmod 600): it holds the S3 secret key. The keys
 * can also come from the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
 *
 * Meant for the command line (cron, Task Scheduler). The script does not
 * have to live in the app folder: keep it outside the web root and point
 * `app_root` at the installation. It reads the database connection and the
 * upload folder from the app's own configuration, exactly as the app does.
 *
 * Works with AWS S3 and S3-compatible storage (Hetzner, Backblaze B2, Wasabi,
 * Cloudflare R2, MinIO, ...). Needs ext-curl, ext-openssl, ext-simplexml and
 * pdo_mysql; the dump is bzip2 with ext-bz2, otherwise gzip.
 *
 * What lands in the bucket, under `prefix`:
 *
 *     database/royal-tasks-YYYYMMDD-HHMMSS.sql.bz2   one per run, kept keep_days;
 *                                                    the first of each month
 *                                                    is kept for good
 *                                                    (keep_monthly)
 *     uploads/<the uploads folder, file by file>     synced: only new or changed
 *                                                    files are sent
 *     uploads.manifest.json                          what the sync has sent
 *
 * A file deleted in the app is deleted from the bucket keep_days later, so
 * every recent database dump can find the files it refers to. A monthly
 * dump older than that is a backup of the database: the boards, cards and
 * comments are all there, but attachments deleted since may not be.
 *
 * NOT included: config.php. Board content in the dump and every uploaded file
 * are encrypted under its master_key, so this backup can only be restored
 * together with config.php. Keep a copy of it somewhere else, never in this
 * bucket: the key next to the data would undo the encryption.
 *
 * Restore
 *
 *     php backups3.php restore                       the latest backup
 *     php backups3.php restore royal-tasks-20260928-031500
 *
 * replaces the app's tables with the dump and downloads every uploaded file
 * that is missing or different. The current database is saved to temp_dir
 * first, so a restore can itself be undone. Restoring onto a new server: run
 * install.php there (or copy the app and config.php), put the saved
 * config.php back in place (it must be the same master_key), then restore.
 * Without this script: download the dump and run it through `mysql`, and
 * `aws s3 sync s3://BUCKET/PREFIX/uploads/ uploads/`.
 *
 * Starting a backup from the web
 *
 * Where scheduled tasks can only call a URL (some shared hosting), set
 * `web_key` in configs3.php and call the script with it:
 *
 *     https://example.com/path/backups3.php?key=THE-KEY
 *
 * or, better where the tool allows a header (a URL can end up in logs):
 *
 *     curl -H "X-Backup-Key: THE-KEY" https://example.com/path/backups3.php
 *
 * A web request only ever runs `backup`, with the settings in configs3.php:
 * no restore, list or delete, and no options. Without the right key it gets a
 * 404 and nothing runs. The reply is plain text, the same log as on the
 * command line; HTTP 500 when the backup failed.
 */

/*
 * From the web the script does nothing unless `web_key` is set in
 * configs3.php and the request carries it; even then it only backs up.
 * Nothing is printed before that check, and PHP's own error display is off,
 * so a request without the key learns nothing.
 */
define('BS_WEB', PHP_SAPI !== 'cli');
if (BS_WEB) {
    ini_set('display_errors', '0');
    ini_set('html_errors', '0');
}

// ---------------------------------------------------------------------------
// Defaults (the real settings are in configs3.php; see configs3.example.php)
// ---------------------------------------------------------------------------

$settings = [
    'app_root' => '',
    's3' => [
        'endpoint'      => '',
        'region'        => '',
        'bucket'        => '',
        'access_key'    => '',
        'secret_key'    => '',
        'prefix'        => 'royal-tasks/',
        'path_style'    => false,
        'storage_class' => '',
        'retries'       => 6,
    ],
    'keep_days' => 30,
    'keep_min'  => 7,
    'keep_monthly' => true,
    'temp_dir'  => '',
    'notify'    => ['to' => '', 'from' => '', 'on_success' => false],
    'web_key'   => '',
];

/** The settings file next to this script. */
const BS_CONFIG = __DIR__ . DIRECTORY_SEPARATOR . 'configs3.php';

// ---------------------------------------------------------------------------

const BS_USAGE = <<<TXT
php backups3.php [backup]          back up the database and the uploads
php backups3.php list              show the backups in the bucket
php backups3.php restore [NAME]    restore a backup (default: the latest)
php backups3.php delete NAME...    delete database backups
php backups3.php delete --all      delete everything under the prefix

Options: --db-only --uploads-only --dry-run --full --yes --to=FILE --config=FILE

TXT;

/** @return array<string,mixed> */
function bs_args(array $argv): array
{
    $out = ['command' => null, 'names' => [], 'dry-run' => false, 'db-only' => false, 'uploads-only' => false,
        'full' => false, 'yes' => false, 'all' => false, 'config' => null, 'to' => null];
    foreach (array_slice($argv, 1) as $a) {
        if (preg_match('/^--(config|to)=(.+)$/', $a, $m)) {
            $out[$m[1]] = $m[2];
        } elseif (preg_match('/^--(dry-run|db-only|uploads-only|full|yes|all)$/', $a, $m)) {
            $out[$m[1]] = true;
        } elseif ($a === '--help' || $a === '-h' || ($out['command'] === null && $a === 'help')) {
            fwrite(STDOUT, BS_USAGE);
            exit(0);
        } elseif (str_starts_with($a, '-')) {
            fwrite(STDERR, "Unknown option: $a\n\n" . BS_USAGE);
            exit(2);
        } elseif ($out['command'] === null) {
            if (!in_array($a, ['backup', 'list', 'restore', 'delete'], true)) {
                fwrite(STDERR, "Unknown command: $a\n\n" . BS_USAGE);
                exit(2);
            }
            $out['command'] = $a;
        } else {
            $out['names'][] = $a;
        }
    }
    $out['command'] ??= 'backup';
    if ($out['db-only'] && $out['uploads-only']) {
        fwrite(STDERR, "--db-only and --uploads-only together leave nothing to do.\n");
        exit(2);
    }
    return $out;
}

/**
 * Ask before something that cannot be undone. --yes answers for a script;
 * without it, a run with no terminal to ask on refuses.
 */
function bs_confirm(string $question, bool $yes): void
{
    if ($yes) {
        return;
    }
    if (!stream_isatty(STDIN)) {
        throw new BsCancelled('Not confirmed: run it in a terminal, or add --yes.');
    }
    fwrite(STDOUT, wordwrap($question, 78) . "\nType \"yes\" to continue: ");
    if (strtolower(trim((string)fgets(STDIN))) !== 'yes') {
        throw new BsCancelled('Cancelled. Nothing was changed.');
    }
}

/** The user said no (or could not be asked): not a failure worth a mail. */
final class BsCancelled extends RuntimeException
{
}

function bs_log(string $msg): void
{
    fwrite(STDOUT, '[' . date('Y-m-d H:i:s') . '] ' . $msg . "\n");
}

function bs_bytes(float $n): string
{
    foreach (['B', 'KB', 'MB', 'GB'] as $u) {
        if ($n < 1024 || $u === 'GB') {
            return ($u === 'B' ? (string)(int)$n : number_format($n, 1)) . ' ' . $u;
        }
        $n /= 1024;
    }
    return (string)$n;
}

// ---------------------------------------------------------------------------
// S3 (Signature Version 4, no SDK)
// ---------------------------------------------------------------------------

final class S3
{
    private string $scheme;
    private string $host;
    private string $basePath;

    public function __construct(private array $c)
    {
        $u = parse_url(rtrim((string)$c['endpoint'], '/'));
        if (empty($u['host'])) {
            throw new RuntimeException('s3.endpoint is not a URL.');
        }
        $this->scheme = $u['scheme'] ?? 'https';
        $port = isset($u['port']) ? ':' . $u['port'] : '';
        if (!empty($c['path_style'])) {
            $this->host = $u['host'] . $port;
            $this->basePath = '/' . $c['bucket'];
        } else {
            $this->host = $c['bucket'] . '.' . $u['host'] . $port;
            $this->basePath = '';
        }
    }

    /** RFC 3986 encoding of each path segment, '/' kept, as SigV4 requires. */
    public static function encodePath(string $path): string
    {
        return implode('/', array_map('rawurlencode', explode('/', $path)));
    }

    /**
     * Sign a request. Pure function of its inputs so it can be checked
     * against AWS's published examples.
     *
     * @param array<string,string> $headers lower-case names; must include host
     * @param array<string,string> $query
     * @return string the Authorization header value
     */
    public static function sign(string $method, string $path, array $query, array $headers,
        string $payloadHash, string $amzDate, string $region, string $key, string $secret, string $service = 's3'): string
    {
        ksort($query, SORT_STRING);
        $q = [];
        foreach ($query as $k => $v) {
            $q[] = rawurlencode((string)$k) . '=' . rawurlencode((string)$v);
        }
        ksort($headers, SORT_STRING);
        $canonHeaders = '';
        foreach ($headers as $k => $v) {
            $canonHeaders .= strtolower($k) . ':' . trim(preg_replace('/\s+/', ' ', (string)$v)) . "\n";
        }
        $signed = implode(';', array_map('strtolower', array_keys($headers)));
        $canonical = implode("\n", [$method, $path, implode('&', $q), $canonHeaders, $signed, $payloadHash]);

        $day = substr($amzDate, 0, 8);
        $scope = "$day/$region/$service/aws4_request";
        $toSign = implode("\n", ['AWS4-HMAC-SHA256', $amzDate, $scope, hash('sha256', $canonical)]);
        $k = hash_hmac('sha256', $day, 'AWS4' . $secret, true);
        $k = hash_hmac('sha256', $region, $k, true);
        $k = hash_hmac('sha256', $service, $k, true);
        $k = hash_hmac('sha256', 'aws4_request', $k, true);
        $sig = hash_hmac('sha256', $toSign, $k);
        return "AWS4-HMAC-SHA256 Credential=$key/$scope, SignedHeaders=$signed, Signature=$sig";
    }

    /**
     * @param array<string,string> $query
     * @param array<string,string> $extra extra headers (lower-case names)
     * @return array{status:int, body:string}
     */
    private function request(string $method, string $key, array $query = [], ?string $file = null,
        ?string $body = null, array $extra = [], ?string $sink = null): array
    {
        $path = $this->basePath . '/' . self::encodePath($key);
        if ($key === '' && $this->basePath !== '') {
            $path = $this->basePath; // bucket-level request, path style
        }
        $payloadHash = $file !== null ? hash_file('sha256', $file) : hash('sha256', (string)$body);

        $last = null;
        $tries = max(1, (int)($this->c['retries'] ?? 6));
        for ($attempt = 1; $attempt <= $tries; $attempt++) {
            $retryAfter = null;
            $amzDate = gmdate('Ymd\THis\Z');
            $headers = ['host' => $this->host, 'x-amz-content-sha256' => $payloadHash, 'x-amz-date' => $amzDate] + $extra;
            $auth = self::sign($method, $path, $query, $headers, $payloadHash, $amzDate,
                (string)$this->c['region'], (string)$this->c['access_key'], (string)$this->c['secret_key']);

            $qs = [];
            foreach ($query as $k => $v) {
                $qs[] = rawurlencode((string)$k) . '=' . rawurlencode((string)$v);
            }
            $url = $this->scheme . '://' . $this->host . $path . ($qs ? '?' . implode('&', $qs) : '');
            $h = ['Authorization: ' . $auth, 'Expect:'];
            foreach ($headers as $k => $v) {
                if ($k !== 'host') {
                    $h[] = $k . ': ' . $v;
                }
            }

            $ch = curl_init($url);
            $fp = null;
            $opts = [
                CURLOPT_CUSTOMREQUEST  => $method,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER     => $h,
                CURLOPT_CONNECTTIMEOUT => 20,
                CURLOPT_TIMEOUT        => 3600,
                // A busy server may say how long to wait.
                CURLOPT_HEADERFUNCTION => function ($ch, string $line) use (&$retryAfter): int {
                    if (preg_match('/^retry-after:\s*(\d+)/i', $line, $m)) {
                        $retryAfter = (int)$m[1];
                    }
                    return strlen($line);
                },
            ];
            if ($file !== null) {
                $fp = fopen($file, 'rb');
                $opts[CURLOPT_UPLOAD] = true;
                $opts[CURLOPT_INFILE] = $fp;
                $opts[CURLOPT_INFILESIZE] = filesize($file);
            } elseif ($body !== null) {
                $opts[CURLOPT_POSTFIELDS] = $body;
            }
            $out = null;
            if ($sink !== null) {
                // Download straight to disk: a dump need not fit in memory.
                $out = fopen($sink, 'wb');
                if (!$out) {
                    throw new RuntimeException("Could not write $sink");
                }
                unset($opts[CURLOPT_RETURNTRANSFER]);
                $opts[CURLOPT_FILE] = $out;
            }
            curl_setopt_array($ch, $opts);
            $resp = curl_exec($ch);
            $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $err = curl_error($ch);
            if ($fp) {
                fclose($fp);
            }
            if ($out) {
                fclose($out);
                if ($resp !== false) {
                    // An error reply was written to the file: read it back.
                    $resp = ($status >= 200 && $status < 300) ? '' : (string)file_get_contents($sink);
                }
            }

            if ($resp === false) {
                $last = "connection failed: $err";
            } elseif ($status >= 500 || $status === 429) {
                // 500/503/SlowDown: the service is busy, not refusing. S3
                // expects the client to back off and try again.
                $last = "HTTP $status " . self::errorText((string)$resp);
            } else {
                return ['status' => $status, 'body' => (string)$resp];
            }
            if ($attempt < $tries) {
                // 2, 4, 8, 16, 32 s (capped at a minute) plus a little
                // jitter, or what the server asked for.
                $wait = $retryAfter !== null ? min(120, max(1, $retryAfter)) : min(60, 2 ** $attempt);
                bs_log("S3 is busy ($last). Trying $method $key again in {$wait}s (attempt "
                    . ($attempt + 1) . " of $tries).");
                usleep($wait * 1000000 + random_int(0, 1000000));
            }
        }
        throw new RuntimeException("S3 $method $key: $last (tried $tries times)");
    }

    private static function errorText(string $xml): string
    {
        if (preg_match('#<Code>(.*?)</Code>#s', $xml, $c)) {
            $m = preg_match('#<Message>(.*?)</Message>#s', $xml, $mm) ? ': ' . $mm[1] : '';
            return $c[1] . $m;
        }
        return trim(substr($xml, 0, 200));
    }

    private static function ok(array $r, string $what): void
    {
        if ($r['status'] < 200 || $r['status'] >= 300) {
            throw new RuntimeException("S3 $what: HTTP {$r['status']} " . self::errorText($r['body']));
        }
    }

    public function put(string $key, string $file, string $contentType = 'application/octet-stream'): void
    {
        $extra = [
            'content-type' => $contentType,
            // S3 refuses the upload if the bytes do not arrive intact.
            'content-md5' => base64_encode(md5_file($file, true)),
        ];
        if (!empty($this->c['storage_class'])) {
            $extra['x-amz-storage-class'] = (string)$this->c['storage_class'];
        }
        self::ok($this->request('PUT', $key, [], $file, null, $extra), "PUT $key");
    }

    public function putString(string $key, string $data, string $contentType): void
    {
        $extra = ['content-type' => $contentType, 'content-md5' => base64_encode(md5($data, true))];
        self::ok($this->request('PUT', $key, [], null, $data, $extra), "PUT $key");
    }

    /** The object's bytes, or null when it does not exist. */
    public function get(string $key): ?string
    {
        $r = $this->request('GET', $key);
        if ($r['status'] === 404) {
            return null;
        }
        self::ok($r, "GET $key");
        return $r['body'];
    }

    /** Download an object into $file (written whole, or not left behind). */
    public function download(string $key, string $file): void
    {
        $part = $file . '.part';
        try {
            self::ok($this->request('GET', $key, [], null, null, [], $part), "GET $key");
            // rename() replaces the old file in one step; Windows refuses to
            // replace, so there the old one goes first.
            if (!@rename($part, $file) && !(@unlink($file) && rename($part, $file))) {
                throw new RuntimeException("Could not write $file");
            }
        } finally {
            if (is_file($part)) {
                @unlink($part);
            }
        }
    }

    public function delete(string $key): void
    {
        $r = $this->request('DELETE', $key);
        if ($r['status'] !== 404) {
            self::ok($r, "DELETE $key");
        }
    }

    /** @return array<string, array{size:int, modified:int}> key => info */
    public function list(string $prefix): array
    {
        $out = [];
        $token = null;
        do {
            $q = ['list-type' => '2', 'prefix' => $prefix];
            if ($token !== null) {
                $q['continuation-token'] = $token;
            }
            $r = $this->request('GET', '', $q);
            self::ok($r, "LIST $prefix");
            $xml = @simplexml_load_string($r['body']);
            if ($xml === false) {
                throw new RuntimeException('S3 LIST: the reply is not XML.');
            }
            foreach ($xml->Contents as $o) {
                $out[(string)$o->Key] = ['size' => (int)$o->Size, 'modified' => (int)strtotime((string)$o->LastModified)];
            }
            $token = ((string)$xml->IsTruncated === 'true') ? (string)$xml->NextContinuationToken : null;
        } while ($token);
        return $out;
    }
}

// ---------------------------------------------------------------------------
// Database dump
// ---------------------------------------------------------------------------

/** A compressed output stream: bzip2 when ext-bz2 is there, else gzip. */
final class Packed
{
    public string $ext;
    /** @var resource */
    private $h;
    private bool $bz;

    public function __construct(string $pathNoExt)
    {
        $this->bz = function_exists('bzopen');
        $this->ext = $this->bz ? '.sql.bz2' : '.sql.gz';
        $h = $this->bz ? bzopen($pathNoExt . $this->ext, 'w') : gzopen($pathNoExt . $this->ext, 'wb6');
        if (!$h) {
            throw new RuntimeException('Could not write ' . $pathNoExt . $this->ext);
        }
        $this->h = $h;
    }

    public function write(string $s): void
    {
        $ok = $this->bz ? bzwrite($this->h, $s) : gzwrite($this->h, $s);
        if ($ok === false || ($s !== '' && $ok === 0)) {
            throw new RuntimeException('Writing the dump failed (disk full?).');
        }
    }

    public function close(): void
    {
        $this->bz ? bzclose($this->h) : gzclose($this->h);
    }
}

/** A connection to the app's database, from its own settings. */
function bs_pdo(array $db): PDO
{
    $dsn = 'mysql:' . (!empty($db['socket'])
        ? 'unix_socket=' . $db['socket']
        : 'host=' . ($db['host'] ?? '127.0.0.1') . ';port=' . (int)($db['port'] ?? 3306))
        . ';dbname=' . ($db['database'] ?? '') . ';charset=utf8mb4';
    return new PDO($dsn, (string)($db['username'] ?? ''), (string)($db['password'] ?? ''), [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
}

/** Dump the app's tables into $file (no extension); returns the full path. */
function bs_dump(array $db, string $pathNoExt): string
{
    $pdo = bs_pdo($db);
    $prefix = (string)($db['prefix'] ?? 'rk_');

    // One consistent snapshot: a card saved while the dump runs cannot leave
    // it half old, half new (every table is InnoDB).
    $pdo->exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    $pdo->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    $pdo->exec("SET time_zone = '+00:00'");

    $tables = array_values(array_filter(
        $pdo->query('SHOW FULL TABLES')->fetchAll(PDO::FETCH_NUM),
        fn($r) => str_starts_with((string)$r[0], $prefix) && strtoupper((string)$r[1]) === 'BASE TABLE'
    ));
    if (!$tables) {
        throw new RuntimeException("No tables with the prefix '$prefix' in the database.");
    }

    $out = new Packed($pathNoExt);
    $nl = "\n";
    $out->write('-- Royal Tasks database backup, ' . gmdate('Y-m-d H:i:s') . ' UTC' . $nl
        . '-- Board content is encrypted: restore together with config.php (master_key).' . $nl
        . '-- prefix: ' . $prefix . $nl
        . 'SET NAMES utf8mb4;' . $nl . 'SET FOREIGN_KEY_CHECKS=0;' . $nl
        . "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';" . $nl . "SET time_zone='+00:00';" . $nl
        . 'SET AUTOCOMMIT=0;' . $nl . 'START TRANSACTION;' . $nl . $nl);

    $rows = 0;
    foreach ($tables as [$t]) {
        $q = '`' . str_replace('`', '``', (string)$t) . '`';
        $create = $pdo->query("SHOW CREATE TABLE $q")->fetch(PDO::FETCH_NUM)[1];
        $out->write("DROP TABLE IF EXISTS $q;$nl$create;$nl$nl");

        // Unbuffered: rows stream from the server instead of the whole table
        // being loaded into PHP's memory first.
        $pdo->setAttribute(\Pdo\Mysql::ATTR_USE_BUFFERED_QUERY, false);
        $st = $pdo->query("SELECT * FROM $q");
        $n = 0;
        $head = '';
        while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
            if ($n === 0) {
                $cols = array_map(fn($c) => '`' . str_replace('`', '``', $c) . '`', array_keys($row));
                $head = "INSERT INTO $q (" . implode(',', $cols) . ') VALUES' . $nl;
                $out->write($head);
            } elseif ($n % 200 === 0) {
                $out->write(';' . $nl . $head);
            } else {
                $out->write(',' . $nl);
            }
            $vals = [];
            foreach ($row as $v) {
                $vals[] = $v === null ? 'NULL' : $pdo->quote((string)$v);
            }
            $out->write('(' . implode(',', $vals) . ')');
            $n++;
        }
        $st->closeCursor();
        $pdo->setAttribute(\Pdo\Mysql::ATTR_USE_BUFFERED_QUERY, true);
        $out->write($n ? ';' . $nl . $nl : '-- (empty)' . $nl . $nl);
        $rows += $n;
    }
    $out->write('COMMIT;' . $nl . 'SET FOREIGN_KEY_CHECKS=1;' . $nl);
    $out->close();
    $pdo->commit();
    bs_log('Dumped ' . count($tables) . " tables, $rows rows.");
    return $pathNoExt . $out->ext;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function bs_backup_database(S3 $s3, array $cfg, string $prefix, string $tmp, bool $dry): string
{
    $name = 'royal-tasks-' . date('Ymd-His');
    $file = bs_dump(RK_DB_CONFIG, $tmp . DIRECTORY_SEPARATOR . $name . '-' . bin2hex(random_bytes(4)));
    $key = $prefix . 'database/' . $name . substr($file, strrpos($file, '.sql'));
    try {
        $size = (float)filesize($file);
        if ($dry) {
            bs_log("Would upload $key (" . bs_bytes($size) . ').');
        } else {
            $s3->put($key, $file, str_ends_with($file, '.bz2') ? 'application/x-bzip2' : 'application/gzip');
            bs_log("Uploaded $key (" . bs_bytes($size) . ').');
        }
    } finally {
        @unlink($file);
    }

    // Retention: dumps older than keep_days go, the newest keep_min stay,
    // and (keep_monthly) the first dump of every calendar month stays for good.
    $dumps = $s3->list($prefix . 'database/');
    $monthly = !empty($cfg['keep_monthly']) ? bs_monthly_dumps($dumps) : [];
    uasort($dumps, fn($a, $b) => $b['modified'] <=> $a['modified']);
    $cutoff = time() - (int)$cfg['keep_days'] * 86400;
    $i = 0;
    foreach ($dumps as $k => $info) {
        if (++$i <= max(1, (int)$cfg['keep_min']) || $info['modified'] >= $cutoff || $k === $key || isset($monthly[$k])) {
            continue;
        }
        if ($dry) {
            bs_log("Would delete the old dump $k.");
        } else {
            $s3->delete($k);
            bs_log("Deleted the old dump $k.");
        }
    }
    return $key;
}

/**
 * The first database dump of each calendar month (UTC): key => month. The
 * month comes from the date in the dump's name (royal-tasks-YYYYMMDD-...),
 * or from when it was stored when the name has none. The first, not the
 * last: it never changes as the month's later dumps arrive, so a monthly
 * copy is never swapped for a newer one and lost.
 *
 * @param array<string,array{modified:int}> $dumps
 * @return array<string,string>
 */
function bs_monthly_dumps(array $dumps): array
{
    $first = [];
    foreach ($dumps as $k => $info) {
        $month = preg_match('/-(\d{4})(\d{2})\d{2}-\d{6}\.sql/', $k, $m)
            ? $m[1] . '-' . $m[2]
            : gmdate('Y-m', (int)$info['modified']);
        // The name sorts like the time it was made; ties go to the stored time.
        $rank = [$k, (int)$info['modified']];
        if (!isset($first[$month]) || $rank[0] < $first[$month][0]) {
            $first[$month] = $rank;
        }
    }
    $out = [];
    foreach ($first as $month => [$k]) {
        $out[$k] = $month;
    }
    return $out;
}

/** @return array<string,string> relative path => full path, hardening files left out */
function bs_local_files(string $dir): array
{
    $out = [];
    if (!is_dir($dir)) {
        throw new RuntimeException("The uploads folder does not exist: $dir");
    }
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        if (!$f->isFile()) {
            continue;
        }
        $rel = str_replace('\\', '/', substr($f->getPathname(), strlen($dir) + 1));
        // The deny .htaccess and blank index.html are written by the app itself.
        if (preg_match('#(^|/)(\.htaccess|index\.html)$#', $rel)) {
            continue;
        }
        $out[$rel] = $f->getPathname();
    }
    ksort($out);
    return $out;
}

/** @return array{sent:int, same:int, removed:int, bytes:float} */
function bs_sync_uploads(S3 $s3, array $cfg, string $prefix, bool $dry, bool $full): array
{
    $manifestKey = $prefix . 'uploads.manifest.json';
    $raw = $full ? null : $s3->get($manifestKey);
    $manifest = $raw !== null ? (json_decode($raw, true)['files'] ?? []) : [];
    // Only what is really in the bucket counts as sent: an object removed by
    // hand (or a lost manifest) is sent again.
    $remote = $s3->list($prefix . 'uploads/');
    $local = bs_local_files(RK_UPLOAD_DIR);
    $now = time();
    $stats = ['sent' => 0, 'same' => 0, 'removed' => 0, 'bytes' => 0.0];
    $save = function () use ($s3, $manifestKey, &$manifest): void {
        $s3->putString($manifestKey, json_encode(['updated' => gmdate('c'), 'files' => $manifest],
            JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), 'application/json');
    };

    try {
        foreach ($local as $rel => $path) {
            $key = $prefix . 'uploads/' . $rel;
            $size = (int)filesize($path);
            $mtime = (int)filemtime($path);
            $m = $manifest[$rel] ?? null;
            $inBucket = isset($remote[$key]) && $remote[$key]['size'] === $size;
            if ($m && $inBucket && $m['size'] === $size && $m['mtime'] === $mtime) {
                unset($manifest[$rel]['gone']);
                $stats['same']++;
                continue; // unchanged since it was sent: not even hashed again
            }
            $md5 = md5_file($path);
            if ($m && $inBucket && ($m['md5'] ?? '') === $md5) {
                $manifest[$rel] = ['size' => $size, 'mtime' => $mtime, 'md5' => $md5];
                $stats['same']++;
                continue; // touched but not changed
            }
            if ($dry) {
                bs_log("Would upload uploads/$rel (" . bs_bytes($size) . ').');
            } else {
                $s3->put($key, $path);
            }
            $manifest[$rel] = ['size' => $size, 'mtime' => $mtime, 'md5' => $md5];
            $stats['sent']++;
            $stats['bytes'] += $size;
        }

        // Files deleted in the app: marked, then removed after keep_days, so the
        // dumps still in the bucket keep their attachments.
        $grace = (int)$cfg['keep_days'] * 86400;
        foreach ($manifest as $rel => $m) {
            if (isset($local[$rel])) {
                continue;
            }
            if (!isset($m['gone'])) {
                $manifest[$rel]['gone'] = $now;
            } elseif ($now - (int)$m['gone'] > $grace) {
                if ($dry) {
                    bs_log("Would delete uploads/$rel (deleted in the app).");
                } else {
                    $s3->delete($prefix . 'uploads/' . $rel);
                }
                unset($manifest[$rel]);
                $stats['removed']++;
            }
        }
    } catch (Throwable $e) {
        // Keep what did get sent: without the manifest the next run would
        // send those files again. The original error is what gets reported.
        if (!$dry) {
            try {
                $save();
            } catch (Throwable) {
            }
        }
        throw $e;
    }

    if (!$dry) {
        $save();
    }
    return $stats;
}

// ---------------------------------------------------------------------------
// list / restore / delete
// ---------------------------------------------------------------------------

/** A backup's short name: the file name without .sql.bz2 / .sql.gz. */
function bs_name(string $key): string
{
    return preg_replace('/\.sql\.(bz2|gz)$/', '', basename($key));
}

/** @return array<string, array{key:string, size:int, modified:int}> name => dump, newest first */
function bs_dumps(S3 $s3, string $prefix): array
{
    $out = [];
    foreach ($s3->list($prefix . 'database/') as $key => $info) {
        if (preg_match('/\.sql\.(bz2|gz)$/', $key)) {
            $out[bs_name($key)] = ['key' => $key] + $info;
        }
    }
    // The name carries the date, so it sorts the same way as the time.
    uasort($out, fn($a, $b) => [$b['modified'], $b['key']] <=> [$a['modified'], $a['key']]);
    return $out;
}

/** @return array{key:string, size:int, modified:int} */
function bs_find_dump(S3 $s3, string $prefix, ?string $name): array
{
    $dumps = bs_dumps($s3, $prefix);
    if (!$dumps) {
        throw new RuntimeException("There are no database backups under {$prefix}database/.");
    }
    if ($name === null || $name === 'latest') {
        return reset($dumps);
    }
    $n = bs_name($name);
    if (!isset($dumps[$n])) {
        throw new RuntimeException("No backup called $name. `php backups3.php list` shows them.");
    }
    return $dumps[$n];
}

function bs_list(S3 $s3, array $settings, string $prefix): void
{
    $where = 's3://' . $settings['s3']['bucket'] . '/' . $prefix;
    $dumps = bs_dumps($s3, $prefix);
    $total = array_sum(array_column($dumps, 'size'));
    fwrite(STDOUT, "Database backups in {$where}database/: " . count($dumps) . ', ' . bs_bytes((float)$total) . "\n");
    $monthly = !empty($settings['keep_monthly'])
        ? bs_monthly_dumps(array_column($dumps, null, 'key'))
        : [];
    $first = true;
    foreach ($dumps as $name => $d) {
        $tags = array_filter([$first ? 'latest' : '', isset($monthly[$d['key']]) ? 'monthly, kept' : '']);
        fwrite(STDOUT, sprintf("  %-32s %s  %10s%s\n", $name, date('Y-m-d H:i', $d['modified']),
            bs_bytes((float)$d['size']), $tags ? '   (' . implode('; ', $tags) . ')' : ''));
        $first = false;
    }
    if (!$dumps) {
        fwrite(STDOUT, "  (none)\n");
    }

    $files = $s3->list($prefix . 'uploads/');
    $bytes = array_sum(array_column($files, 'size'));
    fwrite(STDOUT, "\nUploaded files in {$where}uploads/: " . count($files) . ', ' . bs_bytes((float)$bytes) . "\n");
    $raw = $s3->get($prefix . 'uploads.manifest.json');
    if ($raw !== null) {
        $m = json_decode($raw, true) ?: [];
        $gone = array_filter($m['files'] ?? [], fn($f) => isset($f['gone']));
        fwrite(STDOUT, '  last synced ' . date('Y-m-d H:i', (int)strtotime((string)($m['updated'] ?? '')))
            . ($gone ? '; ' . count($gone) . ' deleted in the app, kept for ' . (int)$settings['keep_days'] . ' days' : '') . "\n");
    }
}

/**
 * Read a dump one statement at a time. The dump is this script's own: one
 * statement ends with ";" at the end of a line, and values never contain a
 * raw line break (PDO::quote escapes them), so this is enough.
 *
 * @return Generator<string>
 */
function bs_statements(string $file): Generator
{
    $bz = str_ends_with($file, '.bz2');
    if ($bz && !function_exists('bzopen')) {
        throw new RuntimeException('This backup is bzip2 and PHP has no bz2 extension. Unpack it with bunzip2 and '
            . 'import it with mysql, or install php-bz2.');
    }
    $h = $bz ? bzopen($file, 'r') : gzopen($file, 'rb');
    if (!$h) {
        throw new RuntimeException("Could not open $file");
    }
    $buf = '';
    $stmt = '';
    try {
        while (true) {
            $chunk = $bz ? bzread($h, 1 << 20) : gzread($h, 1 << 20);
            if ($chunk === false) {
                throw new RuntimeException('The backup file is damaged (could not decompress it).');
            }
            $eof = $chunk === '';
            $buf .= $chunk;
            while (($nl = strpos($buf, "\n")) !== false || ($eof && $buf !== '')) {
                $line = $nl === false ? $buf : substr($buf, 0, $nl);
                $buf = $nl === false ? '' : substr($buf, $nl + 1);
                if ($stmt === '' && (str_starts_with($line, '--') || trim($line) === '')) {
                    continue;
                }
                $stmt .= $line . "\n";
                if (str_ends_with(rtrim($line), ';')) {
                    yield $stmt;
                    $stmt = '';
                }
            }
            if ($eof) {
                break;
            }
        }
    } finally {
        $bz ? bzclose($h) : gzclose($h);
    }
    if (trim($stmt) !== '') {
        throw new RuntimeException('The backup file ends in the middle of a statement (incomplete download?).');
    }
}

/** The "-- prefix: rk_" line in a dump's header, or null for an older dump. */
function bs_dump_prefix(string $file): ?string
{
    $h = str_ends_with($file, '.bz2') ? (function_exists('bzopen') ? bzopen($file, 'r') : null) : gzopen($file, 'rb');
    if (!$h) {
        return null;
    }
    $head = str_ends_with($file, '.bz2') ? (string)bzread($h, 2048) : (string)gzread($h, 2048);
    str_ends_with($file, '.bz2') ? bzclose($h) : gzclose($h);
    return preg_match('/^-- prefix: (\S*)$/m', $head, $m) ? $m[1] : null;
}

function bs_restore_database(S3 $s3, array $settings, string $prefix, array $args, string $tmp): void
{
    $dump = bs_find_dump($s3, $prefix, $args['names'][0] ?? null);
    $name = bs_name($dump['key']);
    $when = date('Y-m-d H:i', $dump['modified']);

    if ($args['to'] !== null) {
        $s3->download($dump['key'], $args['to']);
        bs_log("Downloaded $name ($when, " . bs_bytes((float)$dump['size']) . ") to {$args['to']}.");
        return;
    }
    $db = RK_DB_CONFIG;
    $p = (string)($db['prefix'] ?? 'rk_');
    $target = ($db['database'] ?? '?') . ' (tables ' . $p . '*)';
    if ($args['dry-run']) {
        bs_log("Would replace the database $target with $name ($when).");
        return;
    }
    bs_confirm("This replaces every Royal Tasks table in $target with the backup $name from $when. "
        . 'Changes made since then are lost (a copy of the current database is saved first).', $args['yes']);

    $file = $tmp . DIRECTORY_SEPARATOR . 'restore-' . bin2hex(random_bytes(4)) . '-' . basename($dump['key']);
    try {
        $s3->download($dump['key'], $file);
        bs_log("Downloaded $name (" . bs_bytes((float)filesize($file)) . ').');
        $dp = bs_dump_prefix($file);
        if ($dp !== null && $dp !== $p) {
            throw new RuntimeException("This backup's tables are $dp*, this installation's are $p*. "
                . 'Restore it into an installation with the same prefix.');
        }

        $pdo = bs_pdo($db);
        // Remember what the browsers have seen, so they notice the restore
        // (see below).
        $counter = 0;
        $versions = [];
        try {
            $counter = (int)$pdo->query("SELECT value FROM `{$p}meta` WHERE name = 'change_counter'")->fetchColumn();
            $versions = $pdo->query("SELECT id, version FROM `{$p}boards`")->fetchAll(PDO::FETCH_KEY_PAIR);
        } catch (PDOException) {
            // An empty database (a fresh server): nothing to save or notify.
        }
        if ($counter > 0) {
            $safety = bs_dump($db, $tmp . DIRECTORY_SEPARATOR . 'royal-tasks-before-restore-' . date('Ymd-His'));
            bs_log("Saved the current database to $safety (keep it until the restore is checked).");
        }

        $n = 0;
        foreach (bs_statements($file) as $sql) {
            $pdo->exec($sql);
            $n++;
        }
        // The dump turns autocommit off for its own transaction; switch it
        // back on (which commits), or the updates below would be rolled back
        // when the connection closes.
        $pdo->exec('SET AUTOCOMMIT=1');
        $pdo->exec('SET FOREIGN_KEY_CHECKS=1');
        bs_log("Restored the database from $name: $n statements.");

        // Open browsers poll for a change counter different from the one they
        // saw, and stamp every write with the board version they saw. Both are
        // older in the backup: move them past what was there, so every open
        // page reloads the restored boards instead of being refused.
        if ($counter > 0) {
            $pdo->prepare("UPDATE `{$p}meta` SET value = ? WHERE name = 'change_counter'")->execute([$counter + 1]);
            $up = $pdo->prepare("UPDATE `{$p}boards` SET version = GREATEST(version, ?) + 1 WHERE id = ?");
            foreach ($versions as $id => $v) {
                $up->execute([(int)$v, $id]);
            }
        }
    } finally {
        @unlink($file);
    }

    // Prove the restore is readable: every board through the app's own storage.
    try {
        $boards = rk_storage()->all('boards');
        $cards = array_sum(array_map(fn($b) => count($b['cards'] ?? []), $boards));
        bs_log('Check: ' . count($boards) . " boards and $cards cards open with this installation's master key.");
    } catch (Throwable $e) {
        throw new RuntimeException('The database is restored, but the boards do not open: ' . $e->getMessage()
            . ' Is config.php the one from when the backup was made (the same master_key)?');
    }
    bs_log('If the app is newer than the backup, run upgrade.php once. Everyone is signed in as they were then.');
}

function bs_restore_uploads(S3 $s3, string $prefix, array $args): void
{
    $raw = $s3->get($prefix . 'uploads.manifest.json');
    $manifest = $raw !== null ? (json_decode($raw, true)['files'] ?? []) : [];
    $remote = $s3->list($prefix . 'uploads/');
    $got = 0;
    $same = 0;
    $bytes = 0.0;
    if (!$args['dry-run'] && function_exists('posix_geteuid') && posix_geteuid() === 0) {
        bs_log('Note: running as root. Restored files belong to root; give them to the web server\'s user '
            . '(chown -R www-data: ' . RK_UPLOAD_DIR . ') or run this as that user.');
    }
    foreach ($remote as $key => $info) {
        $rel = substr($key, strlen($prefix . 'uploads/'));
        // Names come from the bucket: never let one climb out of uploads/.
        if (!preg_match('#^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$#', $rel) || preg_match('#(^|/)\.\.?(/|$)#', $rel)) {
            bs_log("Skipped an object with an unexpected name: $key");
            continue;
        }
        $path = RK_UPLOAD_DIR . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel);
        if (is_file($path) && filesize($path) === $info['size']
            && (!isset($manifest[$rel]['md5']) || md5_file($path) === $manifest[$rel]['md5'])) {
            $same++;
            continue;
        }
        if ($args['dry-run']) {
            bs_log("Would download uploads/$rel (" . bs_bytes((float)$info['size']) . ').');
        } else {
            $dir = dirname($path);
            if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
                throw new RuntimeException("Could not create $dir");
            }
            $s3->download($key, $path);
        }
        $got++;
        $bytes += $info['size'];
    }
    bs_log('Uploads: ' . ($args['dry-run'] ? 'would download ' : 'downloaded ') . "$got (" . bs_bytes($bytes)
        . "), $same already in place.");
}

function bs_delete(S3 $s3, array $settings, string $prefix, array $args): void
{
    $where = 's3://' . $settings['s3']['bucket'] . '/' . $prefix;
    if ($args['all']) {
        if ($args['names']) {
            throw new RuntimeException('Give either backup names or --all, not both.');
        }
        $keys = $s3->list($prefix);
        if (!$keys) {
            bs_log("Nothing under $where.");
            return;
        }
        $bytes = array_sum(array_column($keys, 'size'));
        if ($args['dry-run']) {
            bs_log('Would delete ' . count($keys) . ' objects (' . bs_bytes((float)$bytes) . ") under $where.");
            return;
        }
        bs_confirm('This deletes EVERY backup under ' . $where . ': ' . count($keys) . ' objects, '
            . bs_bytes((float)$bytes) . ', database and files.', $args['yes']);
        foreach (array_keys($keys) as $k) {
            $s3->delete($k);
        }
        bs_log('Deleted ' . count($keys) . " objects under $where.");
        return;
    }
    if (!$args['names']) {
        throw new RuntimeException('Name the backups to delete (see `list`), or use --all.');
    }
    $all = bs_dumps($s3, $prefix);
    $pick = [];
    foreach ($args['names'] as $n) {
        if ($n === 'latest') {
            $n = (string)array_key_first($all);
        }
        $n = bs_name($n);
        if (!isset($all[$n])) {
            throw new RuntimeException("No backup called $n. `php backups3.php list` shows them.");
        }
        $pick[$n] = $all[$n];
    }
    if ($args['dry-run']) {
        bs_log('Would delete: ' . implode(', ', array_keys($pick)) . '.');
        return;
    }
    $left = count($all) - count($pick);
    bs_confirm('Delete ' . count($pick) . ' database backup' . (count($pick) > 1 ? 's' : '') . ' ('
        . implode(', ', array_keys($pick)) . ")? $left will be left." . ($left === 0 ? ' That is none at all.' : ''), $args['yes']);
    foreach ($pick as $n => $d) {
        $s3->delete($d['key']);
        bs_log("Deleted $n.");
    }
}

function bs_mail(array $notify, string $subject, string $text): void
{
    if (empty($notify['to'])) {
        return;
    }
    $crlf = "\r\n";
    $headers = (!empty($notify['from']) ? 'From: ' . $notify['from'] . $crlf : '')
        . 'MIME-Version: 1.0' . $crlf . 'Content-Type: text/plain; charset="utf-8"' . $crlf;
    if (!@mail((string)$notify['to'], $subject, $text, $headers)) {
        fwrite(STDERR, "Could not send the notification mail.\n");
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// A test can load the functions above without running a backup.
if (defined('BS_TEST')) {
    return;
}

// A web request only ever runs a plain backup: no restore, list or delete,
// and no options. $argv is missing where register_argc_argv is off (and
// always on the web); $_SERVER has the same list.
$args = BS_WEB ? bs_args(['backups3.php']) : bs_args($_SERVER['argv'] ?? $GLOBALS['argv'] ?? ['backups3.php']);

// The settings: configs3.php next to this script, or --config=FILE.
$configFile = $args['config'] ?? BS_CONFIG;
$loaded = is_file($configFile) ? require $configFile : null;
if (is_array($loaded)) {
    $settings = array_replace_recursive($settings, $loaded);
} elseif (!BS_WEB) {
    fwrite(STDERR, $loaded === null
        ? "No settings: copy configs3.example.php to $configFile and fill it in.\n"
        : "$configFile must return an array of settings (see configs3.example.php).\n");
    exit(2);
}

if (BS_WEB) {
    // The key, from the X-Backup-Key header or ?key=. Compared in constant
    // time; no settings, a missing, short or wrong key: the same bare 404.
    $webKey = (string)($settings['web_key'] ?? '');
    $given = (string)($_SERVER['HTTP_X_BACKUP_KEY'] ?? $_GET['key'] ?? $_POST['key'] ?? '');
    if (strlen($webKey) < 32 || $given === '' || !hash_equals($webKey, $given)) {
        http_response_code(404);
        exit;
    }
    // The command line's streams do not exist here: the log goes into the reply.
    define('STDOUT', fopen('php://output', 'w'));
    define('STDERR', STDOUT);
    define('STDIN', fopen('php://memory', 'r')); // never a terminal: nothing to confirm
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Robots-Tag: noindex');
    // A backup can outlast the request's time limit, and must not stop
    // halfway because the caller hung up.
    @set_time_limit(0);
    ignore_user_abort(true);
    // Held back until the end, so a failed backup can still answer 500.
    ob_start();
}
$settings['s3']['access_key'] = $settings['s3']['access_key'] ?: (string)getenv('AWS_ACCESS_KEY_ID');
$settings['s3']['secret_key'] = $settings['s3']['secret_key'] ?: (string)getenv('AWS_SECRET_ACCESS_KEY');
$notify = $settings['notify'] ?? [];
$started = microtime(true);
$lock = null;
$code = 0;

try {
    foreach (['curl_init' => 'curl', 'openssl_random_pseudo_bytes' => 'openssl', 'simplexml_load_string' => 'simplexml'] as $fn => $ext) {
        if (!function_exists($fn)) {
            throw new RuntimeException("PHP extension $ext is missing.");
        }
    }
    foreach (['bucket', 'access_key', 'secret_key', 'region', 'endpoint'] as $k) {
        if (trim((string)($settings['s3'][$k] ?? '')) === '') {
            throw new RuntimeException("Set s3.$k in the settings.");
        }
    }
    $command = $args['command'];
    // list and delete only talk to the bucket; backup and restore need the app.
    if ($command === 'backup' || ($command === 'restore' && $args['to'] === null)) {
        $root = rtrim((string)$settings['app_root'], '/\\');
        if (!is_file($root . '/src/bootstrap.php')) {
            throw new RuntimeException("app_root does not point at a Royal Tasks installation: $root");
        }
        // The app's own bootstrap: config.php (or ROYAL_KANBAN_CONFIG), the
        // database settings and the upload folder, resolved as the app does.
        require $root . '/src/bootstrap.php';
        if (!defined('RK_DB_CONFIG') || !is_array(RK_DB_CONFIG) || !RK_DB_CONFIG) {
            throw new RuntimeException('The app is not installed (no database settings in config.php).');
        }
    }

    $tmp = rtrim((string)($settings['temp_dir'] ?: sys_get_temp_dir()), '/\\');
    if ($command !== 'list') {
        // One run at a time: a restore or delete while the nightly backup is
        // sending (or two backups) would race on the dumps and the manifest.
        $lock = fopen($tmp . DIRECTORY_SEPARATOR . 'royal-tasks-backups3.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
            throw new RuntimeException('Another backups3.php run is still busy.');
        }
    }

    $prefix = trim((string)$settings['s3']['prefix'], '/');
    $prefix = $prefix === '' ? '' : $prefix . '/';
    $s3 = new S3($settings['s3']);
    $dry = $args['dry-run'];
    $report = [];
    if ($dry && $command !== 'list') {
        bs_log('Dry run: nothing is changed.');
    }

    if ($command === 'list') {
        bs_list($s3, $settings, $prefix);
    } elseif ($command === 'delete') {
        bs_delete($s3, $settings, $prefix, $args);
    } elseif ($command === 'restore') {
        if ($args['to'] !== null || !$args['uploads-only']) {
            bs_restore_database($s3, $settings, $prefix, $args, $tmp);
        }
        if ($args['to'] === null && !$args['db-only']) {
            bs_restore_uploads($s3, $prefix, $args);
        }
    } elseif (!$args['uploads-only']) {
        $key = bs_backup_database($s3, $settings, $prefix, $tmp, $dry);
        $report[] = "Database: $key";
    }
    if ($command === 'backup' && !$args['db-only']) {
        $st = bs_sync_uploads($s3, $settings, $prefix, $dry, $args['full']);
        $line = 'Uploads: ' . ($dry ? 'would send ' : '') . "{$st['sent']} " . ($dry ? '' : 'sent ') . '(' . bs_bytes($st['bytes'])
            . "), {$st['same']} unchanged, {$st['removed']} " . ($dry ? 'to remove.' : 'removed.');
        bs_log($line);
        $report[] = $line;
    }

    if ($command !== 'list') {
        $secs = round(microtime(true) - $started, 1);
        bs_log("Done in {$secs}s.");
    }
    if ($command === 'backup' && !empty($notify['on_success']) && !$dry) {
        bs_mail($notify, 'Royal Tasks backup OK', implode("\n", $report) . "\nTook {$secs}s.\n");
    }
} catch (BsCancelled $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    $code = 1;
} catch (Throwable $e) {
    $what = ucfirst($args['command'] ?? 'backup');
    fwrite(STDERR, '[' . date('Y-m-d H:i:s') . "] $what failed: " . $e->getMessage() . "\n");
    // The nightly run is the one nobody watches: only it mails.
    if (($args['command'] ?? 'backup') === 'backup') {
        bs_mail($notify, 'Backup Failed: Royal Tasks', 'The Royal Tasks backup to S3 failed: ' . $e->getMessage() . "\n");
    }
    $code = 1;
} finally {
    if ($lock) {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}
if (BS_WEB) {
    if ($code !== 0) {
        http_response_code(500);
    }
    ob_end_flush();
}
// Outside the try: exit() would skip the finally that releases the lock.
exit($code);
