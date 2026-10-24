<?php
/**
 * Router for PHP's built-in server (`php -S ... -t . router.php`).
 *
 * It serves static files itself rather than handing them back with
 * `return false`, for two reasons:
 *
 *  - headers set before `return false` are dropped by the built-in server,
 *    and X-Frame-Options cannot come from a <meta> tag;
 *  - the built-in server sends no Cache-Control, Last-Modified or ETag, so
 *    browsers cache assets heuristically and keep serving a stale stylesheet
 *    after a rebuild.
 *
 * The app is a single directory, so this router also stands in for the
 * .htaccess rules install.php writes: source folders and configuration are
 * never served. A production deployment should set the same rules in its web
 * server config — install.php prints them.
 */
declare(strict_types=1);

const RK_TYPES = [
    'html' => 'text/html; charset=utf-8',
    'css' => 'text/css; charset=utf-8',
    'js' => 'text/javascript; charset=utf-8',
    'mjs' => 'text/javascript; charset=utf-8',
    'json' => 'application/json; charset=utf-8',
    'webmanifest' => 'application/manifest+json',
    'map' => 'application/json; charset=utf-8',
    'svg' => 'image/svg+xml',
    'png' => 'image/png',
    'jpg' => 'image/jpeg',
    'jpeg' => 'image/jpeg',
    'gif' => 'image/gif',
    'webp' => 'image/webp',
    'ico' => 'image/x-icon',
    'woff' => 'font/woff',
    'woff2' => 'font/woff2',
    'txt' => 'text/plain; charset=utf-8',
];

// Files and folders that must never be served, mirroring install.php's
// .htaccess. PHP entry points are handled by `return false` below; the config
// is listed here so a direct request 404s instead of executing it.
const RK_PRIVATE_FILES = [
    'config.php', 'config.example.php', 'README.md', 'Agents.md',
    'package.json', 'package-lock.json', 'CREDITS.md', 'SECURITY.md', 'configs3.example.php',
];

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = rawurldecode($path);

// Never serve dotfiles (.htaccess, .user.ini and friends).
if (preg_match('#(^|/)\.#', $path)) {
    http_response_code(404);
    exit;
}
// Source, development and attachment folders. Attachments are served only
// through api/file.php, which applies the board access check.
if (preg_match('#^/(src|styles|scripts|deploy|node_modules|uploads)(/|$)#i', $path)) {
    http_response_code(404);
    exit;
}
// Configuration and other private files.
if (in_array(basename($path), RK_PRIVATE_FILES, true)) {
    http_response_code(404);
    exit;
}

// PHP endpoints set their own headers.
if (str_ends_with($path, '.php')) {
    return false;
}

$root = realpath(__DIR__);
$target = $path === '/' || str_ends_with($path, '/')
    ? $root . DIRECTORY_SEPARATOR . 'index.html'
    : $root . str_replace('/', DIRECTORY_SEPARATOR, $path);

$real = realpath($target);
// Stay inside the document root whatever the request says.
if ($real === false || !is_file($real) || !str_starts_with($real, $root . DIRECTORY_SEPARATOR)) {
    rk_send($root . DIRECTORY_SEPARATOR . 'index.html', 'html', 200);
}

rk_send($real, strtolower(pathinfo($real, PATHINFO_EXTENSION)), 200);

function rk_send(string $file, string $ext, int $status): never
{
    http_response_code($status);
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    header('Content-Type: ' . (RK_TYPES[$ext] ?? 'application/octet-stream'));
    // Always revalidate: a rebuilt asset must never be masked by the cache.
    header('Cache-Control: no-cache, must-revalidate');

    // Documents additionally carry the framing protection that a <meta>
    // Content-Security-Policy cannot express.
    if ($ext === 'html') {
        header('X-Frame-Options: DENY');
        header("Content-Security-Policy: frame-ancestors 'none'");
    }

    header('Content-Length: ' . (string)filesize($file));
    readfile($file);
    exit;
}
