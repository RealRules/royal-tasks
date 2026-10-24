<?php
// Serves a user's avatar (their profile picture).
//
// Only to someone signed in who is that user or shares a board with them:
// an avatar is personal, and people who never meet on a board have no
// business seeing each other's. The file is sealed at rest like any upload.
declare(strict_types=1);

$rkSrc = getenv('ROYAL_KANBAN_SRC_DIR') ?: (string)($_SERVER['ROYAL_KANBAN_SRC_DIR'] ?? '');
require_once ($rkSrc !== '' ? rtrim($rkSrc, '/\\') : __DIR__ . '/../src') . '/bootstrap.php';

Security::startSession();

function rk_avatar_deny(int $code): never
{
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    exit;
}

if (!rk_installed()) {
    rk_avatar_deny(503);
}
$store = rk_storage();
$auth = new AuthService($store);
$me = $auth->currentUser();
if (!$me || !empty($me['mustChangePassword'])) {
    rk_avatar_deny(401);
}

$id = (string)($_GET['u'] ?? '');
if (!preg_match('/^[A-Za-z0-9_]{1,32}$/', $id)) {
    rk_avatar_deny(404);
}
$user = $id === $me['id'] ? $me : $store->find('users', $id);
// A user who does not exist and one this person may not see answer the same.
if (!$user || ($id !== $me['id'] && !$store->usersShareBoard((string)$me['id'], $id))) {
    rk_avatar_deny(404);
}
$stored = (string)($user['avatar'] ?? '');
$path = $stored !== '' ? Uploads::resolveAny($stored) : null;
if ($path === null || !str_starts_with(str_replace('\\', '/', $stored), 'avatars/')) {
    rk_avatar_deny(404);
}
try {
    $bytes = Uploads::readStored($path);
} catch (Throwable $e) {
    error_log('Royal Tasks: could not serve an avatar: ' . $e->getMessage());
    rk_avatar_deny(500);
}
$mime = Uploads::mimeForStored($stored);
if (!in_array($mime, ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], true)) {
    rk_avatar_deny(404);
}
header('Content-Type: ' . $mime);
header('X-Content-Type-Options: nosniff');
header('Content-Disposition: inline');
// The URL carries a version (?v=) that changes with the picture, so the
// browser may keep it; private: never in a shared cache.
header('Cache-Control: private, max-age=86400');
header('Content-Length: ' . (string)strlen($bytes));
echo $bytes;
