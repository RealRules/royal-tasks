<?php
/**
 * Royal Tasks — installer.
 *
 * Upload the folder to where it should be served (e.g. public_html/kanban/),
 * open https://yoursite/kanban/install.php, and fill in the database details.
 * The whole app lives in that one directory: there is no public/ split and
 * nothing is moved anywhere.
 *
 * It does four things:
 *   1. connects to MySQL/MariaDB and creates the tables (prefix-safe, so it
 *      can share a database with an existing site);
 *   2. creates the master administrator with a generated password, shown once;
 *   3. writes config.php with the connection details;
 *   4. hardens the folder: deny rules for the code and for uploads/.
 *
 * Sensitive files: config.php is PHP, so the server executes it rather than
 * sending it, and a .htaccess denial is written as a second layer. uploads/
 * is static, so it gets a deny file and a blank index.html. Apache reads
 * these; nginx does not, so the required snippets are printed for you.
 *
 * Runs from the command line too:
 *   php install.php --host=127.0.0.1 --database=kanban --user=kanban \
 *                   --password=secret [--prefix=rk_] [--admin=admin] \
 *                   [--display="Administrator"]
 *
 * DELETE THIS FILE once the app is running.
 */
declare(strict_types=1);

require_once __DIR__ . '/src/bootstrap.php';

// The installer is the one place that should show its own errors.
ini_set('display_errors', PHP_SAPI === 'cli' ? '1' : '0');

const RK_I_MIN_PHP = '8.4.0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rk_i_requirements(): array
{
    $out = [];
    $out[] = [
        'ok'     => version_compare(PHP_VERSION, RK_I_MIN_PHP, '>='),
        'label'  => 'PHP ' . RK_I_MIN_PHP . ' or newer',
        'detail' => 'found ' . PHP_VERSION,
    ];
    foreach ([
        'pdo'       => 'database access',
        'pdo_mysql' => 'MySQL/MariaDB access',
        'dom'       => 'rich-text sanitiser',
        'json'      => 'storage codec',
        'session'   => 'sign-in',
    ] as $ext => $why) {
        $out[] = [
            'ok'     => extension_loaded($ext),
            'label'  => "ext-$ext",
            'detail' => extension_loaded($ext) ? 'loaded' : "required for $why",
        ];
    }
    foreach (['mbstring' => 'correct handling of non-ASCII text', 'fileinfo' => 'an extra check on uploads'] as $ext => $why) {
        $loaded = extension_loaded($ext);
        $out[] = [
            'ok'     => true,
            'state'  => $loaded ? 'ok' : 'warn',
            'label'  => "ext-$ext (optional)",
            'detail' => $loaded ? 'loaded' : "missing; affects $why",
        ];
    }
    return $out;
}

/** @return array<string,string> form values, trimmed */
function rk_i_input(array $src): array
{
    $get = static fn(string $k, string $d = ''): string => trim((string)($src[$k] ?? $d));
    return [
        'host'     => $get('host', '127.0.0.1'),
        'port'     => $get('port', '3306'),
        'database' => $get('database', ''),
        'user'     => $get('user', ''),
        'password' => (string)($src['password'] ?? ''),
        'prefix'   => $get('prefix', MysqlSchema::DEFAULT_PREFIX),
        'admin'    => strtolower($get('admin', 'admin')),
        'display'  => $get('display', 'Administrator'),
    ];
}

/** @return array<int,string> validation errors */
function rk_i_validate(array $in): array
{
    $errors = [];
    if ($in['host'] === '') {
        $errors[] = 'Database host is required.';
    }
    if ($in['port'] === '' || (int)$in['port'] < 1 || (int)$in['port'] > 65535) {
        $errors[] = 'Port must be a number between 1 and 65535.';
    }
    if (!preg_match('/^[A-Za-z0-9_]{1,64}$/', $in['database'])) {
        $errors[] = 'Database name may contain only letters, digits and underscores.';
    }
    if ($in['user'] === '') {
        $errors[] = 'Database username is required.';
    }
    if ($in['prefix'] !== '' && !preg_match('/^[A-Za-z][A-Za-z0-9_]{0,20}$/', $in['prefix'])) {
        $errors[] = 'Table prefix must start with a letter and contain only letters, digits and underscores.';
    }
    if (!preg_match('/^[a-z0-9_\-]{2,40}$/', $in['admin'])) {
        $errors[] = 'Master username must be 2-40 characters: a-z 0-9 _ -';
    }
    return $errors;
}

/**
 * Connect, creating the database first when it does not exist and the account
 * is allowed to.
 *
 * The database name cannot be a bound parameter — it is an identifier — so it
 * is validated against a fixed pattern before it is interpolated.
 */
function rk_i_connect(array $in): PDO
{
    $host = $in['host'];
    $port = (int)$in['port'];
    $dbName = $in['database'];
    $options = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ];
    $dsnNoDb = "mysql:host={$host};port={$port};charset=utf8mb4";
    $dsn = "mysql:host={$host};port={$port};dbname={$dbName};charset=utf8mb4";

    try {
        return new PDO($dsn, $in['user'], $in['password'], $options);
    } catch (PDOException $e) {
        // 1049 = unknown database: create it when the account may.
        if ((int)($e->errorInfo[1] ?? 0) !== 1049) {
            throw $e;
        }
    }
    $server = new PDO($dsnNoDb, $in['user'], $in['password'], $options);
    $server->exec(
        "CREATE DATABASE IF NOT EXISTS `{$dbName}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    );
    return new PDO($dsn, $in['user'], $in['password'], $options);
}

function rk_i_db_config(array $in): array
{
    return [
        'host'     => $in['host'],
        'port'     => (int)$in['port'],
        'database' => $in['database'],
        'username' => $in['user'],
        'password' => $in['password'],
        'prefix'   => $in['prefix'],
        // Applied by this installer; a normal request must never run DDL.
        'auto_migrate' => false,
    ];
}

function rk_i_config_php(array $db): string
{
    $body = "<?php\n"
        . "// Written by install.php. The database connection for this deployment.\n"
        . "// Delete this file to run the installer again from scratch.\n"
        . "// master_key encrypts every board in the database. Keep it with the database\n"
        . "// backups: without it the boards cannot be read. Never commit it.\n"
        . "return " . var_export(['db' => $db, 'upload_dir' => 'uploads', 'master_key' => AtRest::generateKey()], true) . ";\n";
    return $body;
}

/** Rules an Apache-family server reads, written into the app folder. */
function rk_i_htaccess_root(): string
{
    return implode("\n", [
        '# Written by install.php. Apache hardening for the app folder.',
        'Options -Indexes',
        'DirectoryIndex index.html index.php',
        '',
        '# The config holds database credentials. PHP executes it, but never',
        '# let a misconfigured handler hand it over as a download.',
        '<FilesMatch "^(config\\.php|config\\.example\\.php|\\.user\\.ini|\\.gitignore)$">',
        '    <IfModule mod_authz_core.c>',
        '        Require all denied',
        '    </IfModule>',
        '    <IfModule !mod_authz_core.c>',
        '        Order allow,deny',
        '        Deny from all',
        '    </IfModule>',
        '</FilesMatch>',
        '',
        '# Development and source folders have no business being served.',
        '#',
        '# The patterns must not contain a bare space: Apache splits a RewriteRule',
        '# into pattern / substitution / flags on whitespace, so a file name with',
        '# a space made it read the flags as garbage ("bad flag delimiters"). A space is',
        '# escaped with a backslash, which the regex engine treats as a literal',
        '# space and Apache keeps inside the pattern.',
        '<IfModule mod_rewrite.c>',
        '    RewriteEngine On',
        '    RewriteRule ^(src|styles|scripts|deploy|node_modules|docs|tests)/ - [F,L]',
        '    RewriteRule ^(README\\.md|Agents\\.md|CREDITS\\.md|SECURITY\\.md|package(-lock)?\\.json|configs3\\.example\\.php)$ - [F,L]',
        '</IfModule>',
        '',
        '<IfModule mod_headers.c>',
        '    Header always set X-Content-Type-Options "nosniff"',
        '    Header always set Referrer-Policy "same-origin"',
        '    Header always set X-Frame-Options "DENY"',
        '</IfModule>',
        '',
    ]);
}

function rk_i_htaccess_deny(): string
{
    return implode("\n", [
        '# Written by install.php. Never serve anything in this directory.',
        '<IfModule mod_authz_core.c>',
        '    Require all denied',
        '</IfModule>',
        '<IfModule !mod_authz_core.c>',
        '    Order allow,deny',
        '    Deny from all',
        '</IfModule>',
        '',
    ]);
}

function rk_i_user_ini(): string
{
    return implode("\n", [
        '; Written by install.php. Applies to PHP-FPM/CGI; mod_php ignores it.',
        'upload_max_filesize = 12M',
        'post_max_size = 130M',
        'max_file_uploads = 10',
        'display_errors = Off',
        'log_errors = On',
        'session.cookie_httponly = 1',
        'session.cookie_samesite = "Lax"',
        '',
    ]);
}

/** @return array<int,string> what was written, for the summary */
function rk_i_harden(string $appDir): array
{
    $log = [];
    $write = static function (string $path, string $body) use (&$log): void {
        $dir = dirname($path);
        if (!is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        if (@file_put_contents($path, $body) === false) {
            $log[] = "COULD NOT WRITE $path (check permissions)";
            return;
        }
        $log[] = "wrote $path";
    };

    $write($appDir . '/.htaccess', rk_i_htaccess_root());
    $write($appDir . '/.user.ini', rk_i_user_ini());
    $write($appDir . '/src/.htaccess', rk_i_htaccess_deny());
    $write($appDir . '/uploads/.htaccess', rk_i_htaccess_deny());
    $write($appDir . '/uploads/index.html', '');
    foreach (['styles', 'scripts', 'deploy', 'node_modules'] as $dev) {
        if (is_dir($appDir . '/' . $dev)) {
            $write($appDir . '/' . $dev . '/.htaccess', rk_i_htaccess_deny());
        }
    }
    return $log;
}

function rk_i_nginx_rules(string $base): string
{
    $base = rtrim($base, '/');
    return implode("\n", [
        'location ~ \.php$ {',
        '    # your existing PHP-FPM block',
        '}',
        '',
        '# The app must not be framed by another site (clickjacking).',
        'add_header X-Frame-Options "DENY" always;',
        'add_header X-Content-Type-Options "nosniff" always;',
        'add_header Referrer-Policy "same-origin" always;',
        '',
        '# Never serve the source, dev folders, config or uploads directly.',
        'location ~ ^' . $base . '/(src|styles|scripts|deploy|node_modules|docs|tests)/ { deny all; }',
        'location ~* ^' . $base . '/(README\.md|Agents\.md|CREDITS\.md|SECURITY\.md|package(-lock)?\.json|configs3\.example\.php)$ { deny all; }',
        'location = ' . $base . '/config.php { deny all; }',
        'location = ' . $base . '/config.example.php { deny all; }',
        'location ^~ ' . $base . '/uploads/ { deny all; }',
        'location ~ /\. { deny all; }',
    ]);
}

/**
 * Run the whole installation. Returns a result array or throws.
 *
 * @return array{password:?string,created:bool,user:array<string,mixed>|null}
 */
function rk_i_run(array $in): array
{
    $pdo = rk_i_connect($in);
    MysqlSchema::apply($pdo, $in['prefix']);

    $db = rk_i_db_config($in);
    $store = new MysqlStorage($db);
    $auth = new AuthService($store);
    $created = $auth->createMasterUser($in['admin'], null, $in['display']);

    if (@file_put_contents(RK_ROOT . '/config.php', rk_i_config_php($db)) === false) {
        throw new RuntimeException('Could not write config.php. Check that the app folder is writable.');
    }
    @chmod(RK_ROOT . '/config.php', 0600);

    return [
        'password' => $created['password'] ?? null,
        'created'  => $created !== null,
        'user'     => $created['user'] ?? null,
    ];
}

/**
 * Delete install.php without killing the response that is being sent.
 *
 * Deleting the running script and then returning a normal page is fine on
 * PHP-FPM/mod_php, but under php's built-in server the response connection is
 * torn down when the file it is executing disappears, which the browser sees
 * as a server error. Finishing the output first and unlinking in a shutdown
 * function keeps the response intact on every SAPI.
 *
 * @return bool true when the file is gone (or already was)
 */
function rk_i_self_delete(): bool
{
    $file = __FILE__;
    if (!is_file($file)) {
        return true;
    }
    // Try immediately; if this SAPI allows it, we are done.
    if (@unlink($file)) {
        return true;
    }
    // Otherwise defer: the response finishes, then the file goes.
    register_shutdown_function(static function () use ($file): void {
        @unlink($file);
    });
    return !is_file($file);
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

if (PHP_SAPI === 'cli') {
    foreach (rk_i_requirements() as $r) {
        if (!$r['ok']) {
            fwrite(STDERR, "requirement failed: {$r['label']} ({$r['detail']})\n");
            exit(1);
        }
    }

    $opts = [];
    foreach (array_slice($argv, 1) as $arg) {
        if (preg_match('/^--([a-z_]+)(?:=(.*))?$/', $arg, $m)) {
            $opts[$m[1]] = $m[2] ?? '1';
        }
    }
    if (isset($opts['self-delete'])) {
        $ok = rk_i_self_delete();
        fwrite($ok ? STDOUT : STDERR, $ok ? "install.php deleted.\n" : "Could not delete install.php.\n");
        exit($ok ? 0 : 1);
    }
    // Apply pending schema changes to an install that already exists.
    if (isset($opts['migrate'])) {
        if (!rk_installed()) {
            fwrite(STDERR, "Not installed yet; run the installer first.\n");
            exit(1);
        }
        try {
            $store = rk_storage();
            $r = Upgrade::run($store, (string)(RK_DB_CONFIG['prefix'] ?? MysqlSchema::DEFAULT_PREFIX));
        } catch (Throwable $e) {
            fwrite(STDERR, "failed: " . $e->getMessage() . "\n");
            exit(1);
        }
        echo Upgrade::describe($r) . "\n";
        exit(0);
    }
    if (rk_installed()) {
        fwrite(STDERR, "Already installed (config.php exists). Delete it to reinstall,\n"
            . "or run `php install.php --migrate` to apply database updates.\n");
        exit(1);
    }
    $in = rk_i_input($opts);
    $errors = rk_i_validate($in);
    if ($errors) {
        foreach ($errors as $e) {
            fwrite(STDERR, "error: $e\n");
        }
        fwrite(STDERR, "\nusage: php install.php --host=HOST --database=DB --user=USER --password=PASS"
            . " [--port=3306] [--prefix=rk_] [--admin=admin] [--display=Name]\n"
            . "       php install.php --migrate        apply database updates to an existing install\n"
            . "       php install.php --self-delete    remove this file\n");
        exit(2);
    }
    try {
        $result = rk_i_run($in);
    } catch (Throwable $e) {
        fwrite(STDERR, "failed: " . $e->getMessage() . "\n");
        exit(1);
    }
    foreach (rk_i_harden(RK_ROOT) as $line) {
        echo "  $line\n";
    }
    echo "\nInstalled.\n";
    echo "  database: {$in['database']} (prefix '{$in['prefix']}')\n";
    if ($result['created']) {
        echo "  master  : {$in['admin']}\n";
        echo "  password: {$result['password']}\n";
        echo "  (shown once — you must change it at first sign-in)\n";
    } else {
        echo "  accounts already existed; the master user was left untouched.\n";
    }
    echo "\nAdd these to your nginx config if you do not use Apache:\n\n";
    echo rk_i_nginx_rules('') . "\n";
    echo "\nNow delete install.php.\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------

Security::sendHeaders("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");

$requirements = rk_i_requirements();
$blocked = array_values(array_filter($requirements, static fn($r) => !$r['ok']));
$installed = rk_installed();

$in = rk_i_input($_POST);
$errors = [];
$result = null;
$hardened = [];
$deleted = false;
$deleteFailed = false;
$migrated = null;
$needsAdmin = false;

// Once installed, the web installer must not be usable anonymously. The migrate
// action runs DDL, so require a signed-in administrator: a forgotten install.php
// then holds no capability rather than being "no back door" only by convention.
if ($installed && PHP_SAPI !== 'cli') {
    Security::startSession();
    $rkStore = null;
    try {
        $rkStore = rk_storage();
    } catch (Throwable) {
        $rkStore = null;
    }
    $rkUser = null;
    if ($rkStore !== null) {
        $rkAuth = new AuthService($rkStore);
        $rkUser = $rkAuth->currentUser();
    }
    $isAdmin = $rkUser !== null && ($rkUser['role'] ?? '') === 'admin';
    $rkToken = Security::csrfToken();

    // Admin actions change the database and the filesystem, so they get the
    // same protections as the API: same-origin check plus a CSRF token. Without
    // these a signed-in admin visiting another site could have their installer
    // run migrate or delete install.php for them.
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && in_array($_POST['action'] ?? '', ['migrate', 'delete'], true)) {
        try {
            Security::assertSameOrigin();
            $sent = (string)($_POST['csrf'] ?? '');
            if ($sent === '' || !hash_equals((string)($_SESSION['csrf'] ?? ''), $sent)) {
                throw new RuntimeException('Invalid or missing CSRF token. Reload this page and try again.');
            }
        } catch (Throwable $e) {
            $errors[] = $e->getMessage();
            $isAdmin = false; // refuse the action
        }
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'migrate' && !$errors) {
        if (!$isAdmin) {
            $needsAdmin = true;
        } else {
            try {
                $r = Upgrade::run($rkStore, (string)(RK_DB_CONFIG['prefix'] ?? MysqlSchema::DEFAULT_PREFIX));
                $migrated = Upgrade::describe($r);
            } catch (Throwable $e) {
                // Log the detail; do not print driver messages into the page.
                error_log('Royal Tasks migrate failed: ' . $e->getMessage());
                $migrated = 'Update failed. See the server error log for details.';
            }
        }
    }
    $canDelete = $isAdmin;
    $csrfField = '<input type="hidden" name="csrf" value="' . h($rkToken) . '">';
} else {
    // Pre-install, or CLI: no account exists yet, so the setup actions are open
    // (that is the point of the installer) but the file should be deleted after.
    $canDelete = !$installed;
    $csrfField = '';
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && !$installed && !$blocked) {
    if (($_POST['action'] ?? '') === 'delete') {
        if (!$canDelete) {
            $needsAdmin = true;
        } else {
            $deleted = rk_i_self_delete();
            $deleteFailed = !$deleted;
        }
    } else {
        $errors = rk_i_validate($in);
        if (!$errors) {
            try {
                $result = rk_i_run($in);
                $hardened = rk_i_harden(RK_ROOT);
            } catch (Throwable $e) {
                $errors[] = $e->getMessage();
            }
        }
    }
}

// An installed app: only a signed-in administrator may remove the installer.
if ($installed && $_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'delete' && !$errors) {
    if ($canDelete) {
        $deleted = rk_i_self_delete();
        $deleteFailed = !$deleted;
    } else {
        $needsAdmin = true;
    }
}

function h(?string $s): string
{
    return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Royal Tasks — Install</title>
<style>
  :root { color-scheme: light dark; --ink:#0f141b; --muted:#6b7686; --line:#dde3ea;
          --card:#fff; --bg:#f4f6f8; --ok:#057a3d; --bad:#c81e1e; --accent:#1e7a46; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e8edf4; --muted:#8a95a6; --line:#2a323d; --card:#161b23; --bg:#0d1117; --accent:#2f9c5d; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--ink);
         font:15px/1.6 Inter, system-ui, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width:720px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px;
          padding:22px 24px; margin-bottom:16px; }
  h1 { font-size:24px; margin:0 0 4px; letter-spacing:-.02em; }
  h2 { font-size:14px; margin:20px 0 8px; text-transform:uppercase;
       letter-spacing:.1em; color:var(--muted); font-family:ui-monospace,monospace; }
  code, .mono, input, pre { font-family:ui-monospace, "Cascadia Mono", Consolas, monospace; font-size:13px; }
  table { width:100%; border-collapse:collapse; }
  td { padding:5px 0; vertical-align:top; border-bottom:1px solid var(--line); }
  td:first-child { width:26px; }
  .ok { color:var(--ok); font-weight:700; } .bad { color:var(--bad); font-weight:700; }
  td.warn { color:var(--muted); font-weight:700; }
  label { display:block; font-size:12px; text-transform:uppercase; letter-spacing:.08em;
          color:var(--muted); margin:10px 0 4px; font-family:ui-monospace,monospace; }
  input[type=text], input[type=password] { width:100%; padding:10px 12px; border:1px solid var(--line);
       border-radius:9px; background:var(--bg); color:var(--ink); }
  .grid { display:grid; grid-template-columns:2fr 1fr; gap:12px; }
  button { background:var(--accent); color:#fff; border:0; border-radius:9px;
           padding:11px 18px; font-weight:700; font-size:14px; cursor:pointer; }
  button.secondary { background:transparent; color:var(--ink); border:1px solid var(--line); }
  button.danger { background:var(--bad); }
  .note { color:var(--muted); font-size:13px; }
  .warn { border-left:3px solid var(--bad); padding-left:12px; }
  .cred { background:var(--bg); border:1px dashed var(--accent); border-radius:9px; padding:14px; }
  pre { background:var(--bg); border-radius:9px; padding:12px 14px; overflow:auto; }
</style>
</head>
<body>
<div class="wrap">

<div class="card">
  <h1>♛ Royal Tasks — Install</h1>
  <?php if (!$installed || !empty($isAdmin)): ?>
  <div class="note">App folder: <span class="mono"><?= h(RK_ROOT) ?></span></div>
  <?php endif; ?>
</div>

<?php if ($deleted): ?>
  <div class="card">
    <h2 style="margin-top:0">Installer removed</h2>
    <p>install.php has been deleted. <a href="./">Open the app</a>.</p>
  </div>

<?php elseif ($deleteFailed): ?>
  <div class="card warn">
    <h2 style="margin-top:0">Could not delete install.php</h2>
    <p>The web-server user cannot remove the file. Delete it yourself, or run:</p>
    <pre class="mono">php install.php --self-delete</pre>
  </div>

<?php elseif ($installed): ?>
  <div class="card warn">
    <h2 style="margin-top:0">Already installed</h2>
    <p>config.php exists, so the database connection is already set up. The installer will not run again.</p>
    <?php if ($needsAdmin): ?>
      <p class="warn" style="border-left:0;padding-left:0">Sign in to the app as an administrator to apply database
        updates or remove this file. It no longer does anything for an anonymous visitor.</p>
    <?php endif; ?>
    <?php if ($errors): ?>
      <p class="warn" style="border-left:0;padding-left:0"><?= h($errors[0]) ?></p>
    <?php endif; ?>
    <?php if ($migrated !== null): ?>
      <p class="mono"><?= h($migrated) ?></p>
    <?php endif; ?>
    <?php if ($canDelete): ?>
      <p>After an update, apply any new database tables or column changes with:</p>
      <form method="post" style="margin-bottom:12px">
        <input type="hidden" name="action" value="migrate">
        <?= $csrfField ?>
        <button class="secondary" type="submit">Apply database updates</button>
      </form>
    <?php endif; ?>
    <p><strong>Delete <span class="mono">install.php</span> now.</strong>
       To reinstall from scratch, delete <span class="mono">config.php</span> first
       (the database tables can stay).</p>
    <?php if ($canDelete): ?>
      <form method="post" style="margin-top:12px">
        <input type="hidden" name="action" value="delete">
        <?= $csrfField ?>
        <button class="danger" type="submit">Delete install.php</button>
      </form>
    <?php endif; ?>
  </div>

<?php elseif ($result !== null): ?>
  <div class="card">
    <h2 style="margin-top:0">Installed</h2>
    <?php if ($result['created']): ?>
      <p>Your master account is ready. This password is shown once and must be changed at first sign-in.</p>
      <div class="cred">
        <div>username <strong class="mono"><?= h($in['admin']) ?></strong></div>
        <div>password <strong class="mono"><?= h((string)$result['password']) ?></strong></div>
      </div>
    <?php else: ?>
      <p>The database already had accounts, so the master user was left untouched. Sign in with an existing administrator.</p>
    <?php endif; ?>
    <h2>Hardening written</h2>
    <pre class="mono"><?php foreach ($hardened as $line): ?><?= h($line) . "\n" ?><?php endforeach; ?></pre>
    <h2>Two things left</h2>
    <p class="warn"><strong>Delete <span class="mono">install.php</span>.</strong> It refuses to run now, but has no business on a live site.</p>
    <form method="post" style="margin-bottom:16px">
      <input type="hidden" name="action" value="delete">
      <button class="danger" type="submit">Delete install.php</button>
    </form>
    <h2>nginx users</h2>
    <p class="note">Apache reads the .htaccess files that were written. nginx does not — add these by hand:</p>
    <pre class="mono"><?= h(rk_i_nginx_rules('')) ?></pre>
    <p><a href="./">Open the app</a></p>
  </div>

<?php elseif ($blocked): ?>
  <div class="card">
    <h2 style="margin-top:0">Requirements</h2>
    <table>
      <?php foreach ($requirements as $r): ?>
        <?php $st = $r['state'] ?? ($r['ok'] ? 'ok' : 'bad'); ?>
        <tr><td class="<?= h($st) ?>"><?= $st === 'ok' ? '✓' : ($st === 'warn' ? '◦' : '✕') ?></td>
            <td><?= h($r['label']) ?><div class="note"><?= h($r['detail']) ?></div></td></tr>
      <?php endforeach; ?>
    </table>
    <p class="warn">Fix the failures above, then reload this page.</p>
  </div>

<?php else: ?>
  <div class="card">
    <h2 style="margin-top:0">Requirements</h2>
    <table>
      <?php foreach ($requirements as $r): ?>
        <?php $st = $r['state'] ?? ($r['ok'] ? 'ok' : 'bad'); ?>
        <tr><td class="<?= h($st) ?>"><?= $st === 'ok' ? '✓' : ($st === 'warn' ? '◦' : '✕') ?></td>
            <td><?= h($r['label']) ?><div class="note"><?= h($r['detail']) ?></div></td></tr>
      <?php endforeach; ?>
    </table>
  </div>

  <?php if ($errors): ?>
    <div class="card warn">
      <h2 style="margin-top:0">Could not install</h2>
      <?php foreach ($errors as $e): ?><p class="mono"><?= h($e) ?></p><?php endforeach; ?>
      <p class="note">Nothing was changed. Fix the cause and try again.</p>
    </div>
  <?php endif; ?>

  <form method="post">
    <div class="card">
      <h2 style="margin-top:0">Database</h2>
      <p class="note">MySQL or MariaDB. If the database does not exist and your account
        may create it, the installer will. The prefix lets this app share one database
        with an existing site.</p>
      <div class="grid">
        <div>
          <label for="host">Host</label>
          <input id="host" type="text" name="host" value="<?= h($in['host']) ?>" spellcheck="false">
        </div>
        <div>
          <label for="port">Port</label>
          <input id="port" type="text" name="port" value="<?= h($in['port']) ?>" spellcheck="false">
        </div>
      </div>
      <label for="database">Database name</label>
      <input id="database" type="text" name="database" value="<?= h($in['database']) ?>" spellcheck="false">
      <div class="grid">
        <div>
          <label for="user">Database user</label>
          <input id="user" type="text" name="user" value="<?= h($in['user']) ?>" spellcheck="false">
        </div>
        <div>
          <label for="prefix">Table prefix</label>
          <input id="prefix" type="text" name="prefix" value="<?= h($in['prefix']) ?>" spellcheck="false">
        </div>
      </div>
      <label for="password">Database password</label>
      <input id="password" type="password" name="password" value="" autocomplete="new-password">
    </div>

    <div class="card">
      <h2 style="margin-top:0">Master account</h2>
      <p class="note">The first administrator. A strong password is generated and shown
        once; you must change it at first sign-in.</p>
      <div class="grid">
        <div>
          <label for="admin">Username</label>
          <input id="admin" type="text" name="admin" value="<?= h($in['admin']) ?>" spellcheck="false">
        </div>
        <div>
          <label for="display">Display name</label>
          <input id="display" type="text" name="display" value="<?= h($in['display']) ?>">
        </div>
      </div>
    </div>

    <div class="card">
      <button type="submit">Install</button>
    </div>
  </form>
<?php endif; ?>

<p class="note" style="text-align:center">Royal Tasks installer · delete this file when done</p>
</div>
</body>
</html>
