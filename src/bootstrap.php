<?php
declare(strict_types=1);

/**
 * Shared bootstrap for every entry point (api/*.php, install.php, CLI tools).
 *
 * One directory: the app is deployed as a single web root that holds
 * index.html, api/, assets/, src/, install.php and config.php together. There
 * is no public/ split and no data directory. Boards, users, comments and the
 * rate limiter live in MySQL/MariaDB; the only application files on disk are
 * the attachments under uploads/.
 *
 * src/ and config.php sit inside the web root but are PHP, which the server
 * executes rather than sends. uploads/ is static, so it is protected by a
 * deny file (Apache), by an unguessable name per file, and by never being
 * linked directly — attachments are served through api/file.php, which
 * applies the board access check. install.php prints the nginx rules for
 * servers that do not read .htaccess.
 */

// A direct request for this file must never run the bootstrap. Every entry
// point includes it; only someone probing asks for it by name.
if (isset($_SERVER['SCRIPT_FILENAME'])
    && realpath((string)$_SERVER['SCRIPT_FILENAME']) === realpath(__FILE__)) {
    http_response_code(404);
    exit;
}

define('RK_SRC_DIR', __DIR__);
define('RK_ROOT', dirname(__DIR__));

/** Read a setting from the environment, then config.php, then the default. */
function rk_setting(string $envName, string $configKey, array $config, string $default): string
{
    $env = getenv($envName);
    if ($env === false || $env === '') {
        // Apache SetEnv / fastcgi_param arrive here rather than in getenv().
        $env = (string)($_SERVER[$envName] ?? '');
    }
    if ($env !== '') {
        return $env;
    }
    $fromFile = (string)($config[$configKey] ?? '');
    return $fromFile !== '' ? $fromFile : $default;
}

/** Absolute, separator-normalised path. Relative values hang off the app root. */
function rk_resolve_dir(string $value): string
{
    $value = trim($value);
    $isAbsolute = (bool)preg_match('#^([a-zA-Z]:[\\\\/]|[\\\\/]{1,2})#', $value);
    $path = $isAbsolute ? $value : RK_ROOT . DIRECTORY_SEPARATOR . $value;
    $path = str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $path);
    return rtrim($path, DIRECTORY_SEPARATOR);
}

/**
 * Harden a directory that the web server may end up serving.
 *
 * Attachments are the one thing this app writes as static files, and in a
 * one-directory install they sit under the web root. A deny file stops an
 * Apache-family server handing them out; a blank index.html stops a listing
 * if directory indexes are enabled. The file names themselves are random, and
 * the app only ever links to api/file.php, so this is the second layer rather
 * than the first.
 */
function rk_deny_web_access(string $dir): void
{
    if (!is_dir($dir)) {
        return;
    }
    $htaccess = $dir . DIRECTORY_SEPARATOR . '.htaccess';
    if (!file_exists($htaccess)) {
        @file_put_contents($htaccess, implode("\n", [
            '# Never serve these files over HTTP.',
            '<IfModule mod_authz_core.c>',
            '    Require all denied',
            '</IfModule>',
            '<IfModule !mod_authz_core.c>',
            '    Order allow,deny',
            '    Deny from all',
            '</IfModule>',
            '',
        ]));
    }
    $index = $dir . DIRECTORY_SEPARATOR . 'index.html';
    if (!file_exists($index)) {
        @file_put_contents($index, '');
    }
}

/**
 * Where config.php lives.
 *
 * Normally the app root. ROYAL_KANBAN_CONFIG (or RK_CONFIG_FILE) can point
 * elsewhere, which is only useful when the config must be kept out of the
 * document root.
 */
$rkConfigEnv = getenv('ROYAL_KANBAN_CONFIG');
if ($rkConfigEnv === false || $rkConfigEnv === '') {
    $rkConfigEnv = (string)($_SERVER['ROYAL_KANBAN_CONFIG'] ?? '');
}
if (defined('RK_CONFIG_FILE')) {
    $rkConfigFile = (string)RK_CONFIG_FILE;
} elseif ($rkConfigEnv !== '') {
    $rkConfigFile = $rkConfigEnv;
} else {
    $rkConfigFile = RK_ROOT . DIRECTORY_SEPARATOR . 'config.php';
}
$rkConfig = is_file($rkConfigFile) ? require $rkConfigFile : [];
if (!is_array($rkConfig)) {
    $rkConfig = [];
}

$rkDbConfig = is_array($rkConfig['db'] ?? null) ? $rkConfig['db'] : null;

define('RK_UPLOAD_DIR', rk_resolve_dir(
    rk_setting('ROYAL_KANBAN_UPLOAD_DIR', 'upload_dir', $rkConfig, 'uploads')
));
// The directory the web server serves. Defaults to the app root; set it only
// when the app is nested inside a larger site.
define('RK_PUBLIC_DIR', rk_resolve_dir(
    rk_setting('ROYAL_KANBAN_PUBLIC_DIR', 'public_dir', $rkConfig, RK_ROOT)
));
// Trust X-Forwarded-Proto / X-Forwarded-For. Off by default: those headers are
// trivially forged, so they are honoured only when the deployment says a
// reverse proxy is in front (config.php: 'trust_proxy' => true, or
// ROYAL_KANBAN_TRUST_PROXY=1). Behind a proxy the Secure cookie flag and the
// per-IP login limit both depend on them.
define('RK_TRUST_PROXY', in_array(
    strtolower(rk_setting('ROYAL_KANBAN_TRUST_PROXY', 'trust_proxy', $rkConfig, '')),
    ['1', 'true', 'yes', 'on'],
    true
));
// How many trusted proxy hops sit in front (default 1). With more, the client
// address is taken that many entries from the right of X-Forwarded-For.
define('RK_TRUSTED_PROXIES', max(1, (int)rk_setting('ROYAL_KANBAN_TRUSTED_PROXIES', 'trusted_proxies', $rkConfig, '1')));

if (!is_dir(RK_UPLOAD_DIR)) {
    @mkdir(RK_UPLOAD_DIR, 0700, true);
}
rk_deny_web_access(RK_UPLOAD_DIR);

// Which config.php is in use: upgrade.php adds the master key to this file.
define('RK_CONFIG_PATH', $rkConfigFile);
// The master key that encrypts every board in the database (see AtRest).
$rkMasterKey = rk_setting('ROYAL_KANBAN_MASTER_KEY', 'master_key', $rkConfig, '');

/** How the app sends email: the "mail" section of config.php (see Mailer). */
// ROYAL_KANBAN_MAIL_LOG=/path writes mail to files there instead of sending
// it (a test server); it overrides the config's mail section.
$rkMailLog = (string)(getenv('ROYAL_KANBAN_MAIL_LOG') ?: ($_SERVER['ROYAL_KANBAN_MAIL_LOG'] ?? ''));
define('RK_MAIL_CONFIG', $rkMailLog !== ''
    ? ['transport' => 'log', 'log_dir' => $rkMailLog, 'from' => 'noreply@royal-tasks.test']
    : (is_array($rkConfig['mail'] ?? null) ? $rkConfig['mail'] : []));
unset($rkMailLog);

unset($rkConfigFile, $rkConfigEnv, $rkConfig);

require_once __DIR__ . '/AtRest.php';
if ($rkMasterKey !== '') {
    AtRest::setKey(AtRest::decodeKey($rkMasterKey));
    if (!AtRest::hasKey()) {
        error_log('Royal Tasks: master_key in config.php is not a valid key (base64 of 32 bytes).');
    }
}
unset($rkMasterKey);
require_once __DIR__ . '/VersionConflict.php';
require_once __DIR__ . '/StorageInterface.php';
require_once __DIR__ . '/MysqlSchema.php';
require_once __DIR__ . '/MysqlStorage.php';
require_once __DIR__ . '/HtmlSanitizer.php';
require_once __DIR__ . '/Helpers.php';
require_once __DIR__ . '/Security.php';
require_once __DIR__ . '/AuthService.php';
require_once __DIR__ . '/Uploads.php';
require_once __DIR__ . '/Calendar.php';
require_once __DIR__ . '/Accounts.php';
require_once __DIR__ . '/BoardService.php';
require_once __DIR__ . '/Upgrade.php';
require_once __DIR__ . '/WebCover.php';
require_once __DIR__ . '/Mailer.php';

/** Database credentials from config.php, or null before install.php has run. */
define('RK_DB_CONFIG', $rkDbConfig);
unset($rkDbConfig);

/** True once install.php has written a database configuration. */
function rk_installed(): bool
{
    return RK_DB_CONFIG !== null;
}

/**
 * The one storage backend: MySQL/MariaDB.
 *
 * Throws when the app has not been installed, so an entry point can answer
 * with "open install.php" instead of a stack trace.
 */
function rk_storage(): StorageInterface
{
    static $store = null;
    if ($store === null) {
        if (RK_DB_CONFIG === null) {
            throw new RuntimeException('Not installed yet. Open install.php in a browser.', 503);
        }
        $store = new MysqlStorage(RK_DB_CONFIG);
    }
    return $store;
}

// Never render PHP errors into a response; log them to the server's configured
// error log. Nothing is written under the web root.
ini_set('display_errors', '0');
ini_set('log_errors', '1');
