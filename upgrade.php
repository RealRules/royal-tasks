<?php
/**
 * Royal Tasks — database upgrade.
 *
 * Brings an installation up to date (see src/Upgrade.php): applies the schema
 * this code expects (MysqlSchema::VERSION), adds a master key to config.php if
 * there is none, and encrypts every stored board under it. Safe to run any
 * number of times: every step is idempotent.
 *
 *   From the command line:   php upgrade.php
 *   In a browser:            open upgrade.php while signed in as an administrator
 *
 * Anyone else gets one fixed page that reveals nothing (not even whether the
 * app is installed or the database answers). Applying the upgrade runs DDL, so
 * it needs a signed-in administrator and carries the same same-origin and CSRF
 * checks as the API: an administrator visiting another site must not be able
 * to have this page run for them. Database errors are logged, not printed.
 *
 * Run it after copying a new version of the app over an installation.
 */
declare(strict_types=1);

require_once __DIR__ . '/src/bootstrap.php';

ini_set('display_errors', PHP_SAPI === 'cli' ? '1' : '0');

$prefix = (string)(defined('RK_DB_CONFIG') ? (RK_DB_CONFIG['prefix'] ?? MysqlSchema::DEFAULT_PREFIX) : MysqlSchema::DEFAULT_PREFIX);

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
if (PHP_SAPI === 'cli') {
    if (!rk_installed()) {
        fwrite(STDERR, "Not installed yet. Run install.php first.\n");
        exit(1);
    }
    try {
        $r = Upgrade::run(rk_storage(), $prefix);
    } catch (Throwable $e) {
        fwrite(STDERR, 'Upgrade failed: ' . $e->getMessage() . "\n");
        exit(1);
    }
    echo Upgrade::describe($r) . "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------
Security::sendHeaders("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
header('X-Robots-Tag: noindex, nofollow');

$message = null;
$error = null;
$isAdmin = false;
$applied = null;
$token = '';

// Who is asking decides what the page may say. Anyone but a signed-in
// administrator gets one fixed page with nothing on it: not whether the app
// is installed, not whether the database answers, not the schema version.
$store = null;
if (rk_installed()) {
    Security::startSession();
    $token = Security::csrfToken();
    try {
        $store = rk_storage();
        $user = (new AuthService($store))->currentUser();
        $isAdmin = $user !== null && ($user['role'] ?? '') === 'admin' && empty($user['mustChangePassword']);
    } catch (Throwable $e) {
        error_log('Royal Tasks upgrade: ' . $e->getMessage());
        $isAdmin = false;
    }
}
if (!$isAdmin) {
    http_response_code(403);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<meta name="robots" content="noindex, nofollow"><title>Royal Tasks</title>'
        . '<style>body{margin:0;padding:40px 16px;font:15px/1.6 system-ui,sans-serif;text-align:center}</style></head>'
        . '<body><p>Sign in to <a href="./">Royal Tasks</a> as an administrator, then reload this page.</p></body></html>';
    exit;
}

{
    try {
        $applied = Upgrade::applied($store->pdo(), $prefix);
    } catch (Throwable $e) {
        error_log('Royal Tasks upgrade: ' . $e->getMessage());
        $error = 'Could not read the database. See the server error log for details.';
    }

    if ($error === null && $_SERVER['REQUEST_METHOD'] === 'POST') {
        try {
            Security::assertSameOrigin();
            $sent = (string)($_POST['csrf'] ?? '');
            if ($sent === '' || !hash_equals((string)($_SESSION['csrf'] ?? ''), $sent)) {
                throw new RuntimeException('Invalid or missing CSRF token. Reload this page and try again.');
            }
            $r = Upgrade::run($store, $prefix);
            $applied = $r['to'];
            $message = Upgrade::describe($r);
        } catch (RuntimeException $e) {
            $error = $e->getMessage();
        } catch (Throwable $e) {
            error_log('Royal Tasks upgrade failed: ' . $e->getMessage());
            $error = 'The upgrade failed. See the server error log for details.';
        }
    }
}

function h(?string $s): string
{
    return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
// Up to date means the schema is current and the boards are encrypted.
$current = $applied !== null && $applied >= MysqlSchema::VERSION && AtRest::hasKey();
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Royal Tasks — Upgrade</title>
<style>
  :root { color-scheme: light dark; --ink:#0f141b; --muted:#6b7686; --line:#dde3ea;
          --card:#fff; --bg:#f4f6f8; --ok:#057a3d; --bad:#c81e1e; --accent:#1e7a46; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e8edf4; --muted:#8a95a6; --line:#2a323d; --card:#161b23; --bg:#0d1117; --accent:#2f9c5d; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--ink);
         font:15px/1.6 Inter, system-ui, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width:560px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:22px 24px; }
  h1 { font-size:20px; margin:0 0 4px; letter-spacing:-.01em; }
  p { margin:10px 0; }
  .muted { color:var(--muted); font-size:14px; }
  .ok { color:var(--ok); font-weight:600; }
  .bad { color:var(--bad); font-weight:600; }
  .mono { font-family:ui-monospace, "JetBrains Mono", Consolas, monospace; font-size:13px; }
  button { font:inherit; font-weight:600; padding:9px 16px; border-radius:10px; border:1px solid var(--accent);
           background:var(--accent); color:#fff; cursor:pointer; }
  a { color:var(--accent); }
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <h1>♛ Royal Tasks — database upgrade</h1>
  <?php if ($applied !== null): ?>
    <p class="mono">Database schema: version <?= h((string)$applied) ?> · this code expects version <?= h((string)MysqlSchema::VERSION) ?></p>
  <?php endif; ?>

  <?php if ($message !== null): ?><p class="ok"><?= h($message) ?></p><?php endif; ?>
  <?php if ($error !== null): ?><p class="bad"><?= h($error) ?></p><?php endif; ?>

  <?php if ($applied === null): ?>
    <!-- The database could not be read: nothing to offer. -->
  <?php elseif ($current): ?>
    <p class="ok">The database is up to date. Nothing to do.</p>
    <p><a href="./">Back to Royal Tasks</a></p>
  <?php else: ?>
    <p>The database needs updating before the new version can use every feature.
       The upgrade only adds what is missing; no board data is removed.</p>
    <?php if (!AtRest::hasKey()): ?>
    <p>It also generates a master key into <span class="mono">config.php</span> and encrypts every
       board in the database with it. From then on, back up <span class="mono">config.php</span>
       together with the database: without the key the boards cannot be read.</p>
    <?php endif; ?>
    <form method="post">
      <input type="hidden" name="csrf" value="<?= h($token) ?>">
      <button type="submit">Upgrade database</button>
    </form>
  <?php endif; ?>
  <p class="muted">From a shell: <span class="mono">php upgrade.php</span></p>
</div></div>
</body>
</html>
