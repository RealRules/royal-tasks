<?php
// A user's deadlines as an iCalendar feed, for a calendar app to subscribe to.
//
// The address is the secret: ?t=<token>, made in Preferences. No session and
// no cookie (calendar apps have neither); the token is looked up by its
// SHA-256, and the feed is built from the boards its owner is a member of
// right now. Anything wrong answers the same bare 404, so the endpoint tells a
// guesser nothing. GET only; it changes nothing.
declare(strict_types=1);

$rkSrc = getenv('ROYAL_KANBAN_SRC_DIR') ?: (string)($_SERVER['ROYAL_KANBAN_SRC_DIR'] ?? '');
require_once ($rkSrc !== '' ? rtrim($rkSrc, '/\\') : __DIR__ . '/../src') . '/bootstrap.php';

function rk_calendar_deny(int $code): never
{
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET' && ($_SERVER['REQUEST_METHOD'] ?? '') !== 'HEAD') {
    header('Allow: GET, HEAD');
    rk_calendar_deny(405);
}
if (!rk_installed()) {
    rk_calendar_deny(404);
}
$token = (string)($_GET['t'] ?? '');
if (!Calendar::looksLikeToken($token)) {
    rk_calendar_deny(404);
}
try {
    $store = rk_storage();
    $hash = Calendar::hash($token);
    // A calendar app polls; a stolen address hammered should not load the
    // server. Counted per address, as hashed by the limiter.
    if ($store->throttle('calendar_feed', $hash, 120, 3600) > 0) {
        header('Retry-After: 600');
        rk_calendar_deny(429);
    }
    $feed = $store->calendarFeedByHash($hash);
    $owner = $feed ? $store->find('users', $feed['userId']) : null;
    if (!$feed || !$owner) {
        rk_calendar_deny(404);
    }
    $ics = Calendar::build($store, $feed);
} catch (Throwable $e) {
    error_log('Royal Tasks: calendar feed failed: ' . $e->getMessage());
    rk_calendar_deny(500);
}

header('Content-Type: text/calendar; charset=utf-8');
header('Content-Disposition: inline; filename="royal-tasks.ics"');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Robots-Tag: noindex, nofollow');
// Calendar apps poll on their own schedule; a short private cache is plenty.
header('Cache-Control: private, max-age=300');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
    exit;
}
echo $ics;
