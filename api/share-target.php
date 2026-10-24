<?php
// PWA Web Share Target endpoint. Accepts shared text/URLs and files, stashes
// them as an inbox item owned by the signed-in user, then redirects into the
// app where they pick the board + list for the new card.
//
// This endpoint writes to disk, so it requires a session: an anonymous caller
// could otherwise fill the disk and plant content for others to open.
declare(strict_types=1);

// src/ lives beside this api/ directory. ROYAL_KANBAN_SRC_DIR can point
// elsewhere when the deployment keeps the code out of the document root.
$rkSrc = getenv('ROYAL_KANBAN_SRC_DIR') ?: (string)($_SERVER['ROYAL_KANBAN_SRC_DIR'] ?? '');
require_once ($rkSrc !== '' ? rtrim($rkSrc, '/\\') : __DIR__ . '/../src') . '/bootstrap.php';

Security::startSession();
Security::sendHeaders("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");

const RK_INBOX_MAX_ITEMS_PER_USER = 25;
const RK_INBOX_MAX_BYTES = 64 * 1024 * 1024;

/** Send the user back into the app with a short status code in the URL. */
function rk_bounce(string $status, string $id = ''): never
{
    $q = $id !== '' ? '?inbox=' . urlencode($id) : '?share=' . urlencode($status);
    header('Location: ../index.html' . $q, true, 303);
    exit;
}

// POST only, and before anything else. The manifest declares method POST, and
// the session cookie is SameSite=Lax — which is still sent on a top-level
// cross-site GET — so a GET fallback would let any site plant inbox items for
// a signed-in user with a plain link.
if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit;
}

if (!rk_installed()) {
    rk_bounce('signin');
}

$store = rk_storage();
$auth = new AuthService($store);

$user = $auth->currentUser();
if (!$user || !empty($user['mustChangePassword'])) {
    // Nothing is stored for an unauthenticated share; the app explains why.
    rk_bounce('signin');
}

$wait = $store->throttle('share', (string)$user['id'], 60, 3600);
if ($wait > 0) {
    rk_bounce('throttled');
}

$id = Helpers::newId('i_');
$title = trim((string)($_POST['title'] ?? ''));
$text = trim((string)($_POST['text'] ?? ''));
$url = trim((string)($_POST['url'] ?? ''));

$title = mb_substr($title, 0, 200);
$text = mb_substr($text, 0, 20000);
$url = mb_substr($url, 0, 2000);

$files = [];
if (!empty($_FILES)) {
    if (Uploads::inboxBytes() > RK_INBOX_MAX_BYTES) {
        rk_bounce('full');
    }
    try {
        $files = Uploads::saveFiles($_FILES, 'inbox_' . $id);
    } catch (RuntimeException) {
        $files = [];
    }
}

if ($title === '' && $text !== '') {
    $first = preg_split('/\r?\n/', $text)[0] ?? '';
    $title = mb_substr(trim($first), 0, 120);
}
if ($title === '' && $url !== '') {
    $title = mb_substr($url, 0, 120);
}
if ($title === '' && count($files) > 0) {
    $title = (string)($files[0]['name'] ?? 'Shared files');
}
if ($title === '') {
    $title = 'Shared card';
}

$item = [
    'id' => $id,
    'userId' => $user['id'],
    'title' => $title,
    'text' => $text,
    'url' => $url,
    'files' => $files,
    'createdAt' => Helpers::now(),
];

// One indexed insert plus a scoped prune — never a load-everything rewrite,
// which two concurrent sharers could use to wipe each other's items.
$pruned = $store->addInboxItem($item, RK_INBOX_MAX_ITEMS_PER_USER, 7 * 24 * 3600);
foreach ($pruned as $old) {
    foreach ($old['files'] ?? [] as $f) {
        Uploads::deleteStored((string)($f['stored'] ?? ''));
    }
    Uploads::deleteDir('inbox_' . (string)($old['id'] ?? ''));
}

rk_bounce('ok', $id);
