<?php
// Serves card attachments with Master Gate access control.
//
// Files live outside the document root, so this script is the only way to
// reach them. Anything that could script our origin is sent as a download.
declare(strict_types=1);

// src/ lives beside this api/ directory. ROYAL_KANBAN_SRC_DIR can point
// elsewhere when the deployment keeps the code out of the document root.
$rkSrc = getenv('ROYAL_KANBAN_SRC_DIR') ?: (string)($_SERVER['ROYAL_KANBAN_SRC_DIR'] ?? '');
require_once ($rkSrc !== '' ? rtrim($rkSrc, '/\\') : __DIR__ . '/../src') . '/bootstrap.php';

Security::startSession();

if (!rk_installed()) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    exit('Not installed yet. Open install.php in a browser.');
}

$store = rk_storage();
$auth = new AuthService($store);

/**
 * Send a stored file's bytes, decrypted: files in uploads/ are encrypted at
 * rest under the master key (AtRest). A file that will not decrypt is an
 * error, never sent as it lies on disk.
 */
function rk_send_stored(string $path): never
{
    try {
        $bytes = Uploads::readStored($path);
    } catch (Throwable $e) {
        error_log('Royal Tasks: could not serve ' . basename($path) . ': ' . $e->getMessage());
        header_remove('Content-Disposition');
        rk_deny(500, 'The file could not be read.');
    }
    header('Content-Length: ' . (string)strlen($bytes));
    echo $bytes;
    exit;
}

function rk_deny(int $code, string $message): never
{
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    echo $message;
    exit;
}

$u = $auth->currentUser();
if (!$u || !empty($u['mustChangePassword'])) {
    rk_deny(401, 'Login required.');
}

$boardId = (string)($_GET['b'] ?? '');
$stored = (string)($_GET['f'] ?? '');

$board = $store->find('boards', $boardId);
if (!$board || !Helpers::canView($u, $board)) {
    rk_deny(403, 'No access.');
}

$path = Uploads::resolve($stored, $boardId);
if (!$path) {
    rk_deny(404, 'Not found.');
}

// A board background image is referenced by the board row itself rather than
// by a card attachment, so it is authorised differently: the row must name it.
$isBackground = ($board['backgroundImage'] ?? '') !== '' && $board['backgroundImage'] === $stored;
if ($isBackground) {
    // Raster types only, sandboxed like attachments. Anything else (an SVG
    // background stored before this check existed) goes as a download, never
    // rendered on our origin.
    $bgMime = (string)($board['backgroundMime'] ?? '');
    $raster = in_array($bgMime, BoardService::BACKGROUND_TYPES, true);
    header('Content-Type: ' . ($raster ? $bgMime : 'application/octet-stream'));
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Cross-Origin-Resource-Policy: same-origin');
    header("Content-Security-Policy: default-src 'none'; sandbox");
    header('Content-Disposition: ' . ($raster ? 'inline' : 'attachment; filename="background.bin"'));
    header('Cache-Control: private, max-age=300');
    rk_send_stored($path);
}

// A card attachment is only served while a live row still references it.
// The row is the authority: deleting a card removes its rows immediately, so
// the file stops being downloadable even before the bytes are unlinked, and a
// file that was removed from a card can never be reached by an old URL.
$row = null;
foreach ($board['cards'] ?? [] as $card) {
    foreach ($card['attachments'] ?? [] as $a) {
        if (($a['stored'] ?? '') === $stored) {
            $row = $a;
            break 2;
        }
    }
}
if ($row === null) {
    rk_deny(404, 'Not found.');
}

// A download name for the user; the value is quoted and escaped.
$name = Uploads::displayName((string)($row['name'] ?? 'attachment'));
$encrypted = !empty($row['encrypted']);

// The served type comes from our own allowlist, keyed off the extension we
// chose at upload time — never from the uploader's filename or content.
$mime = Uploads::mimeForStored($stored);
$inline = Uploads::isInlineSafe($mime);

if ($encrypted) {
    // Ciphertext: the browser decrypts it, so there is no type to act on and
    // nothing to render inline. Always an opaque download.
    $mime = 'application/octet-stream';
    $inline = false;
    $name = 'encrypted.bin';
}

header('Content-Type: ' . $mime);
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');
header('Cross-Origin-Resource-Policy: same-origin');
// Even if a type slipped through, the sandbox denies it script execution.
header("Content-Security-Policy: default-src 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'; sandbox");
header('Cache-Control: private, max-age=300');
header(
    'Content-Disposition: ' . ($inline ? 'inline' : 'attachment')
    . '; filename="' . addcslashes($name, '"\\') . '"'
    . "; filename*=UTF-8''" . rawurlencode($name)
);

rk_send_stored($path);
