<?php
declare(strict_types=1);

// src/ lives beside this api/ directory. ROYAL_KANBAN_SRC_DIR can point
// elsewhere when the deployment keeps the code out of the document root.
$rkSrc = getenv('ROYAL_KANBAN_SRC_DIR') ?: (string)($_SERVER['ROYAL_KANBAN_SRC_DIR'] ?? '');
require_once ($rkSrc !== '' ? rtrim($rkSrc, '/\\') : __DIR__ . '/../src') . '/bootstrap.php';

Security::startSession();
// This endpoint only ever returns JSON, so nothing may be loaded or framed.
Security::sendHeaders("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");

$in = Helpers::input();
$action = Helpers::str($in, 'action', '');

// Before installation there is no storage to talk to. `me` still answers so
// the page can point at install.php; every other action is refused.
if (!rk_installed()) {
    if ($action === 'me') {
        Helpers::json([
            'ok' => true,
            'installed' => false,
            'user' => null,
            'csrfToken' => Security::csrfToken(),
            'mustChangePassword' => false,
        ]);
    }
    Helpers::fail('Not installed yet. Open install.php in a browser.', 503, ['install' => true]);
}

$store = rk_storage();
$auth = new AuthService($store);
$boards = new BoardService($store);

// The board version the client last saw. Absent means the client makes no
// claim, and the service falls back to the version it loaded.
$boards->expectBoardVersion(
    array_key_exists('boardVersion', $in) && $in['boardVersion'] !== ''
        ? (int)$in['boardVersion']
        : null
);

// Method + CSRF policy before anything touches state.
Security::enforce($action);

try {
    switch ($action) {
        // ---- public ----
        case 'login': {
            $u = $auth->login(Helpers::str($in, 'username'), (string)($in['password'] ?? ''));
            Helpers::json([
                'ok' => true,
                'user' => Helpers::sanitizeUser($u),
                'csrfToken' => Security::csrfToken(),
                'mustChangePassword' => !empty($u['mustChangePassword']),
            ]);
        }
        case 'logout':
            $auth->logout();
            Helpers::json(['ok' => true, 'csrfToken' => Security::csrfToken()]);
        case 'me': {
            $u = $auth->currentUser();
            // The database server and its version are not reported: they
            // tell the browser (and anyone reading its console) nothing it
            // needs, and they help someone looking for a known weakness.
            Helpers::json([
                'ok' => true,
                'installed' => true,
                'user' => $u ? Helpers::sanitizeUser($u) : null,
                'csrfToken' => Security::csrfToken(),
                'mustChangePassword' => $u ? !empty($u['mustChangePassword']) : false,
                'version' => $store->getVersion(),
                'canForgot' => (new Accounts($store))->canForgot(),
            ]);
        }
        case 'change_password': {
            $u = $auth->requireUser(); // allowed while mustChangePassword is set
            $updated = $auth->changeOwnPassword(
                $u,
                (string)($in['currentPassword'] ?? ''),
                (string)($in['newPassword'] ?? '')
            );
            Helpers::json([
                'ok' => true,
                'user' => Helpers::sanitizeUser($updated),
                'csrfToken' => Security::csrfToken(),
                'mustChangePassword' => false,
            ]);
        }

        // ---- boards (auth) ----
        case 'list_boards':
        case 'poll': {
            $u = $auth->requireActiveUser();
            $version = $store->getVersion();
            if ($action === 'poll') {
                $since = (int)($in['since'] ?? 0);
                if ($since === $version) {
                    Helpers::json(['ok' => true, 'version' => $version, 'changed' => false]);
                }
            }
            Helpers::json(['ok' => true, 'version' => $version, 'changed' => true, 'boards' => $boards->listFor($u), 'schemes' => BoardService::COLOR_SCHEMES]);
        }
        case 'create_board': {
            $u = $auth->requireActiveUser();
            $b = $boards->create($u, Helpers::str($in, 'title'), Helpers::str($in, 'colorScheme', Helpers::COLOR_SCHEMES[0]));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'update_board': {
            $u = $auth->requireActiveUser();
            $title = array_key_exists('title', $in) ? (string)$in['title'] : null;
            $color = array_key_exists('colorScheme', $in) ? (string)$in['colorScheme'] : null;
            $b = $boards->update($u, Helpers::str($in, 'boardId'), $title, $color);
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'delete_board': {
            $u = $auth->requireActiveUser();
            $bid = Helpers::str($in, 'boardId');
            $boards->delete($u, $bid);
            Uploads::deleteDir($bid); // remove the whole board's files, background included
            Helpers::json(['ok' => true, 'version' => $store->getVersion()]);
        }
        case 'share_board': {
            $u = $auth->requireActiveUser();
            $b = $boards->share($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'username'), Helpers::str($in, 'access', 'view'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'unshare_board': {
            $u = $auth->requireActiveUser();
            $b = $boards->unshare($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'userId'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'get_board_key': {
            $u = $auth->requireActiveUser();
            Helpers::json(['ok' => true, 'key' => $boards->boardKeyFor($u, Helpers::str($in, 'boardId'))]);
        }
        case 'seal_board_content': {
            $u = $auth->requireActiveUser();
            $p = $in['content'] ?? null;
            $b = $boards->sealContent($u, Helpers::str($in, 'boardId'), is_array($p) ? $p : []);
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'save_board_key': {
            $u = $auth->requireActiveUser();
            $data = $in['key'] ?? null;
            if (!is_array($data)) {
                Helpers::fail('No key material provided.');
            }
            $key = $boards->saveBoardKey($u, Helpers::str($in, 'boardId'), $data);
            Helpers::json(['ok' => true, 'key' => $key]);
        }

        // ---- lists ----
        case 'create_list': {
            $u = $auth->requireActiveUser();
            $b = $boards->createList($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'title', 'New list'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'update_list': {
            $u = $auth->requireActiveUser();
            $b = $boards->updateList($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'listId'), Helpers::str($in, 'title'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'delete_list': {
            $u = $auth->requireActiveUser();
            $b = $boards->deleteList($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'listId'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'move_list': {
            $u = $auth->requireActiveUser();
            $b = $boards->moveList($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'listId'), (int)($in['toIndex'] ?? 0));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }

        // ---- cards ----
        case 'create_card': {
            $u = $auth->requireActiveUser();
            $res = $boards->createCard($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'listId'), Helpers::str($in, 'title'));
            Helpers::json(['ok' => true, 'board' => $res['board'], 'card' => $res['card'], 'version' => $store->getVersion()]);
        }
        case 'update_card': {
            $u = $auth->requireActiveUser();
            $b = $boards->updateCard(
                $u,
                Helpers::str($in, 'boardId'),
                Helpers::str($in, 'cardId'),
                array_key_exists('title', $in) ? (string)$in['title'] : null,
                array_key_exists('description', $in) ? (string)$in['description'] : null,
                array_key_exists('dueDate', $in) ? (string)$in['dueDate'] : null
            );
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'move_card': {
            $u = $auth->requireActiveUser();
            $b = $boards->moveCard($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'toListId'), (int)($in['toIndex'] ?? 0));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'delete_card': {
            $u = $auth->requireActiveUser();
            $b = $boards->deleteCard($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'archive_card': {
            $u = $auth->requireActiveUser();
            $b = $boards->archiveCard($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), (bool)($in['archived'] ?? true));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }

        case 'complete_card': {
            $u = $auth->requireActiveUser();
            $b = $boards->completeCard($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), (bool)($in['completed'] ?? true));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'empty_archive': {
            $u = $auth->requireActiveUser();
            $res = $boards->emptyArchive($u, Helpers::str($in, 'boardId'));
            Helpers::json(['ok' => true, 'board' => $res['board'], 'deleted' => $res['deleted'], 'version' => $store->getVersion()]);
        }
        case 'archive_list_cards': {
            $u = $auth->requireActiveUser();
            $b = $boards->archiveListCards($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'listId'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }

        // ---- checklists ----
        case 'add_checklist': {
            $u = $auth->requireActiveUser();
            $b = $boards->addChecklist($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'title', 'Checklist'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'delete_checklist': {
            $u = $auth->requireActiveUser();
            $b = $boards->deleteChecklist($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'checklistId'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'rename_checklist': {
            $u = $auth->requireActiveUser();
            $b = $boards->renameChecklist($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'checklistId'), Helpers::str($in, 'title'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'add_item': {
            $u = $auth->requireActiveUser();
            $b = $boards->addItem($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'checklistId'), Helpers::str($in, 'text'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'toggle_item': {
            $u = $auth->requireActiveUser();
            $done = array_key_exists('done', $in) ? (bool)$in['done'] : null;
            $itemId = Helpers::str($in, 'itemId');
            $b = $boards->toggleItem($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'checklistId'), $itemId, $done);
            // Only the item and the board's new version go back: ticking items
            // in a row would otherwise send the whole board for every click.
            $item = null;
            foreach ($b['cards'] as $c) {
                foreach ($c['checklists'] ?? [] as $k) {
                    foreach ($k['items'] ?? [] as $t) {
                        if (($t['id'] ?? null) === $itemId) $item = ['id' => $itemId, 'done' => (bool)($t['done'] ?? false)];
                    }
                }
            }
            Helpers::json(['ok' => true, 'item' => $item, 'board' => ['id' => $b['id'], 'version' => $b['version']], 'version' => $store->getVersion()]);
        }
        case 'move_item': {
            $u = $auth->requireActiveUser();
            $b = $boards->moveItem($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'checklistId'),
                Helpers::str($in, 'itemId'), Helpers::str($in, 'toChecklistId'), (int)($in['toIndex'] ?? 0));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'rename_item': {
            $u = $auth->requireActiveUser();
            $b = $boards->renameItem($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'checklistId'),
                Helpers::str($in, 'itemId'), (string)($in['text'] ?? ''));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'delete_item': {
            $u = $auth->requireActiveUser();
            $b = $boards->deleteItem($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'checklistId'), Helpers::str($in, 'itemId'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }

        // ---- comments ----
        case 'add_comment': {
            $u = $auth->requireActiveUser();
            $b = $boards->addComment($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'text'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'edit_comment': {
            $u = $auth->requireActiveUser();
            $b = $boards->editComment($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'commentId'), Helpers::str($in, 'text'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'delete_comment': {
            $u = $auth->requireActiveUser();
            $b = $boards->deleteComment($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'commentId'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }

        // ---- attachments ----
        case 'prepare_attachment': {
            // Mint the attachment id before the client encrypts, so the id can
            // be the AAD that binds the ciphertext to its row. Remember it in
            // the session: upload_attachment will only accept an id this server
            // actually issued to this user, so a client cannot pick an id that
            // belongs to another card.
            $u = $auth->requireActiveUser();
            $boardId = Helpers::str($in, 'boardId');
            $boards->editableBoard($u, $boardId);
            $attachmentId = Helpers::newId('f_');
            $pending = $_SESSION['pending_attachments'] ?? [];
            $pending[$attachmentId] = ['boardId' => $boardId, 'userId' => $u['id'], 'at' => time()];
            // Keep the map small: drop anything older than an hour.
            foreach ($pending as $pid => $meta) {
                if (time() - (int)($meta['at'] ?? 0) > 3600) {
                    unset($pending[$pid]);
                }
            }
            $_SESSION['pending_attachments'] = $pending;
            Helpers::json(['ok' => true, 'attachmentId' => $attachmentId]);
        }
        // ---- the signed-in user's own profile ----
        case 'update_profile': {
            $u = $auth->requireActiveUser();
            $name = trim((string)($in['displayName'] ?? ''));
            $email = trim((string)($in['email'] ?? ''));
            if ($name === '' || mb_strlen($name) > 80) {
                Helpers::fail('A name is 1 to 80 characters.');
            }
            if ($email !== '' && (strlen($email) > 254 || filter_var($email, FILTER_VALIDATE_EMAIL) === false)) {
                Helpers::fail('That is not an email address.');
            }
            if (strcasecmp($email, trim((string)($u['email'] ?? ''))) !== 0) {
                // A new address takes the password: it is where password
                // links go, so a stolen session must not be able to move it.
                if ($store->throttle('profile_pw', (string)$u['id'], 10, 900) > 0) {
                    Helpers::fail('Too many attempts. Try again in a few minutes.', 429);
                }
                if (!password_verify((string)($in['password'] ?? ''), (string)($u['passwordHash'] ?? ''))) {
                    Helpers::fail('To change your email address, enter your password.', 403, ['needPassword' => true]);
                }
                $other = $email === '' ? null : $store->findUserByEmail($email);
                if ($other !== null && (string)$other['id'] !== (string)$u['id']) {
                    Helpers::fail('That email address belongs to another account.', 409);
                }
            }
            $u['displayName'] = $name;
            $u['email'] = $email;
            $saved = $store->save('users', $u);
            Helpers::json(['ok' => true, 'user' => Helpers::sanitizeUser($saved)]);
        }
        case 'upload_avatar': {
            $u = $auth->requireActiveUser();
            $wait = $store->throttle('avatar', (string)$u['id'], 30, 3600);
            if ($wait > 0) {
                Helpers::fail('Too many new pictures. Try again shortly.', 429);
            }
            $f = $_FILES['avatar'] ?? null;
            if (!is_array($f) || ($f['error'] ?? 1) !== UPLOAD_ERR_OK || !is_uploaded_file((string)$f['tmp_name'])) {
                Helpers::fail('No picture received.');
            }
            if ((int)$f['size'] > 2 * 1024 * 1024) {
                Helpers::fail('A picture can be at most 2 MB.');
            }
            // What the bytes are, not what the name says; only formats every
            // browser draws, and never SVG (it can carry script).
            $info = @getimagesize((string)$f['tmp_name']);
            $ext = [IMAGETYPE_PNG => 'png', IMAGETYPE_JPEG => 'jpg', IMAGETYPE_WEBP => 'webp', IMAGETYPE_GIF => 'gif'][$info[2] ?? 0] ?? null;
            if ($ext === null) {
                Helpers::fail('A picture must be PNG, JPEG, WebP or GIF.');
            }
            $bytes = (string)file_get_contents((string)$f['tmp_name']);
            $rec = Uploads::saveBytes($bytes, 'avatars', $ext);
            $old = (string)($u['avatar'] ?? '');
            $u['avatar'] = $rec['stored'];
            $saved = $store->save('users', $u);
            if ($old !== '') {
                Uploads::deleteStored($old);
            }
            Helpers::json(['ok' => true, 'user' => Helpers::sanitizeUser($saved)]);
        }
        case 'remove_avatar': {
            $u = $auth->requireActiveUser();
            $old = (string)($u['avatar'] ?? '');
            $u['avatar'] = '';
            $saved = $store->save('users', $u);
            if ($old !== '') {
                Uploads::deleteStored($old);
            }
            Helpers::json(['ok' => true, 'user' => Helpers::sanitizeUser($saved)]);
        }

        case 'upload_attachment': {
            $u = $auth->requireActiveUser();
            $boardId = Helpers::str($in, 'boardId');
            $cardId = Helpers::str($in, 'cardId');
            $boards->editableBoard($u, $boardId); // permission check before touching disk
            $wait = $store->throttle('upload', (string)$u['id'], 120, 3600);
            if ($wait > 0) {
                Helpers::fail('Upload limit reached. Try again shortly.', 429);
            }
            if (empty($_FILES)) {
                Helpers::fail('No file received.');
            }
            // An encrypted board uploads ciphertext as application/octet-stream,
            // which the extension allowlist would otherwise reject. Only an
            // existing encrypted board may take this path, and only with an id
            // this server issued for this board and user.
            $encrypted = Helpers::str($in, 'encrypted') === '1' && $store->isBoardEncrypted($boardId);
            $attachmentId = Helpers::str($in, 'attachmentId');
            $encName = Helpers::str($in, 'encName');
            if ($encrypted) {
                $pending = $_SESSION['pending_attachments'][$attachmentId] ?? null;
                if (!preg_match('/^f_[A-Za-z0-9]+$/', $attachmentId)
                    || !is_array($pending)
                    || ($pending['boardId'] ?? null) !== $boardId
                    || ($pending['userId'] ?? null) !== $u['id']) {
                    Helpers::fail('That attachment id was not issued for this upload.');
                }
                unset($_SESSION['pending_attachments'][$attachmentId]);
            }
            try {
                $records = $encrypted
                    ? Uploads::saveCiphertext($_FILES, $boardId, $attachmentId, $encName)
                    : Uploads::saveFiles($_FILES, $boardId);
            } catch (RuntimeException $e) {
                Helpers::fail($e->getMessage());
            }
            if (count($records) === 0) {
                Helpers::fail('No file received.');
            }
            $b = $boards->addAttachments($u, $boardId, $cardId, $records, $encrypted);
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'delete_attachment': {
            $u = $auth->requireActiveUser();
            $b = $boards->deleteAttachment($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'attachmentId'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }

        // ---- board background image ----
        case 'upload_board_background': {
            $u = $auth->requireActiveUser();
            $boardId = Helpers::str($in, 'boardId');
            $boards->editableBoard($u, $boardId); // permission check before touching disk
            if (empty($_FILES)) {
                Helpers::fail('No image received.');
            }
            try {
                $records = Uploads::saveFiles($_FILES, $boardId);
            } catch (RuntimeException $e) {
                Helpers::fail($e->getMessage());
            }
            if (count($records) === 0) {
                Helpers::fail('No image received.');
            }
            $b = $boards->setBackground($u, $boardId, $records);
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'clear_board_background': {
            $u = $auth->requireActiveUser();
            $b = $boards->clearBackground($u, Helpers::str($in, 'boardId'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }

        // ---- share inbox ----
        case 'get_inbox': {
            $u = $auth->requireActiveUser();
            $item = BoardService::findInboxFor($store, Helpers::str($in, 'id'), $u);
            if (!$item) {
                Helpers::fail('Share not found or expired.', 404);
            }
            Helpers::json(['ok' => true, 'item' => $item]);
        }
        case 'claim_inbox': {
            $u = $auth->requireActiveUser();
            $res = $boards->claimInbox(
                $u,
                Helpers::str($in, 'inboxId'),
                Helpers::str($in, 'boardId'),
                Helpers::str($in, 'listId'),
                array_key_exists('title', $in) ? (string)$in['title'] : null,
                Helpers::str($in, 'cardId')
            );
            Helpers::json(['ok' => true, 'board' => $res['board'], 'card' => $res['card'], 'version' => $store->getVersion()]);
        }

        case 'set_cover': {
            $u = $auth->requireActiveUser();
            $b = $boards->setCover($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'attachmentId'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'save_labels': {
            $u = $auth->requireActiveUser();
            $labels = is_array($in['labels'] ?? null) ? $in['labels'] : [];
            $b = $boards->saveLabels($u, Helpers::str($in, 'boardId'), $labels);
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'set_card_assignees': {
            $u = $auth->requireActiveUser();
            $ids = is_array($in['userIds'] ?? null) ? $in['userIds'] : [];
            $b = $boards->setCardAssignees($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), $ids);
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'set_item_assignee': {
            $u = $auth->requireActiveUser();
            $b = $boards->setItemAssignee($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), Helpers::str($in, 'checklistId'),
                Helpers::str($in, 'itemId'), Helpers::str($in, 'userId'));
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        case 'set_card_labels': {
            $u = $auth->requireActiveUser();
            $ids = is_array($in['labelIds'] ?? null) ? $in['labelIds'] : [];
            $b = $boards->setCardLabels($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), $ids);
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }
        // ---- calendar subscription ----
        case 'calendar_settings': {
            $u = $auth->requireActiveUser();
            $feed = $store->calendarFeed((string)$u['id']);
            Helpers::json(['ok' => true, 'available' => $store->hasCalendar(), 'feed' => $feed]);
        }
        case 'calendar_save': {
            // Turn the subscription on, or change what it shows. The address
            // stays the same unless `newLink` asks for another (the old one
            // then stops working).
            $u = $auth->requireActiveUser();
            $uid = (string)$u['id'];
            $scope = Helpers::str($in, 'scope', 'mine');
            if (!in_array($scope, Calendar::SCOPES, true)) {
                Helpers::fail('Unknown calendar choice.');
            }
            $mine = array_map(fn($b) => (string)$b['id'], $store->boardsVisibleTo($uid));
            $ids = is_array($in['boardIds'] ?? null) ? array_values(array_intersect(array_map('strval', $in['boardIds']), $mine)) : [];
            $old = $store->calendarFeed($uid);
            $token = ($old && empty($in['newLink'])) ? $old['token'] : Calendar::newToken();
            try {
                $store->saveCalendarFeed($uid, $token, $scope, $ids);
            } catch (RuntimeException $e) {
                Helpers::fail($e->getMessage(), 503);
            }
            Helpers::json(['ok' => true, 'available' => true, 'feed' => $store->calendarFeed($uid)]);
        }
        case 'calendar_off': {
            $u = $auth->requireActiveUser();
            $store->deleteCalendarFeed((string)$u['id']);
            Helpers::json(['ok' => true, 'available' => $store->hasCalendar(), 'feed' => null]);
        }
        case 'calendar_names': {
            // This user's calendar names for the cards of one board.
            $u = $auth->requireActiveUser();
            $b = $store->find('boards', Helpers::str($in, 'boardId'));
            if (!$b || !Helpers::canView($u, $b)) {
                Helpers::fail('No access to this board.', 403);
            }
            $names = $store->calendarNames((string)$u['id'], array_map(fn($c) => (string)$c['id'], $b['cards'] ?? []));
            Helpers::json(['ok' => true, 'names' => (object)$names]);
        }
        case 'set_calendar_name': {
            // Per user and plain text on purpose: it is what this user's
            // calendar shows for a card on an end-to-end board. Not a board
            // change, so no version moves.
            $u = $auth->requireActiveUser();
            $b = $store->find('boards', Helpers::str($in, 'boardId'));
            if (!$b || !Helpers::canView($u, $b)) {
                Helpers::fail('No access to this board.', 403);
            }
            $cardId = Helpers::str($in, 'cardId');
            if (!in_array($cardId, array_map(fn($c) => (string)$c['id'], $b['cards'] ?? []), true)) {
                Helpers::fail('Card not found.', 404);
            }
            $name = Calendar::cleanName((string)($in['name'] ?? ''));
            try {
                $store->setCalendarName((string)$u['id'], $cardId, $name);
            } catch (RuntimeException $e) {
                Helpers::fail($e->getMessage(), 503);
            }
            Helpers::json(['ok' => true, 'name' => $name]);
        }
        case 'page_title': {
            // The title of a web page, for a card made from a shared link.
            // POST like every action that makes the server fetch something,
            // so another site cannot trigger it; the same budget as title
            // images, and the same guarded fetcher.
            $u = $auth->requireActiveUser();
            if ($store->throttle('cover_fetch', (string)$u['id'], 30, 600) > 0) {
                Helpers::fail('Too many pages fetched just now. Try again shortly.', 429);
            }
            try {
                $t = WebCover::pageTitle(Helpers::str($in, 'url'));
            } catch (RuntimeException $e) {
                Helpers::fail($e->getMessage(), 422);
            }
            Helpers::json(['ok' => true, 'title' => $t]);
        }
        case 'fetch_cover': {
            $u = $auth->requireActiveUser();
            $res = $boards->fetchCover($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'), !empty($in['replace']));
            Helpers::json(['ok' => true, 'board' => $res['board'], 'found' => $res['found'], 'version' => $store->getVersion()]);
        }
        case 'fetch_item_link': {
            $u = $auth->requireActiveUser();
            $res = $boards->fetchItemLink($u, Helpers::str($in, 'boardId'), Helpers::str($in, 'cardId'),
                Helpers::str($in, 'checklistId'), Helpers::str($in, 'itemId'));
            Helpers::json(['ok' => true, 'board' => $res['board'], 'found' => $res['found'], 'version' => $store->getVersion()]);
        }
        case 'import_into_board': {
            $u = $auth->requireActiveUser();
            $payload = $in['payload'] ?? null;
            if (!is_array($payload)) {
                Helpers::fail('Nothing to import.');
            }
            $res = $boards->importIntoBoard($u, Helpers::str($in, 'boardId'), $payload);
            Helpers::json(['ok' => true, 'board' => $res['board'], 'imported' => $res['cards'], 'version' => $store->getVersion()]);
        }

        // ---- Trello import ----
        case 'import_board': {
            $u = $auth->requireActiveUser();
            $data = $in['data'] ?? null;
            if (!is_array($data)) {
                Helpers::fail('No board data provided.');
            }
            $b = $boards->importTrello(
                $u,
                $data,
                array_key_exists('title', $in) ? (string)$in['title'] : null,
                array_key_exists('colorScheme', $in) ? (string)$in['colorScheme'] : null
            );
            Helpers::json(['ok' => true, 'board' => $b, 'version' => $store->getVersion()]);
        }

        // ---- accounts by email: no session needed (a CSRF token is) ----
        case 'forgot_password': {
            // The same answer whatever happened, so this cannot be used to
            // learn which names or addresses have accounts.
            if ($store->throttle('forgot_ip', Security::clientIp(), 10, 900) > 0) {
                Helpers::fail('Too many requests. Try again in a few minutes.', 429);
            }
            (new Accounts($store))->forgot(Helpers::str($in, 'login'));
            Helpers::json(['ok' => true]);
        }
        case 'link_info': {
            if ($store->throttle('link_ip', Security::clientIp(), 30, 900) > 0) {
                Helpers::fail('Too many requests. Try again in a few minutes.', 429);
            }
            Helpers::json(['ok' => true] + (new Accounts($store))->linkInfo(Helpers::str($in, 'token')));
        }
        case 'complete_reset': {
            if ($store->throttle('link_ip', Security::clientIp(), 30, 900) > 0) {
                Helpers::fail('Too many requests. Try again in a few minutes.', 429);
            }
            $u = (new Accounts($store))->completeReset(Helpers::str($in, 'token'), (string)($in['password'] ?? ''));
            $auth->signIn($u);
            Helpers::json(['ok' => true, 'user' => Helpers::sanitizeUser($u), 'csrfToken' => Security::csrfToken(), 'mustChangePassword' => false]);
        }
        case 'accept_invite': {
            if ($store->throttle('link_ip', Security::clientIp(), 30, 900) > 0) {
                Helpers::fail('Too many requests. Try again in a few minutes.', 429);
            }
            $u = (new Accounts($store))->acceptInvite(Helpers::str($in, 'token'), Helpers::str($in, 'username'),
                Helpers::str($in, 'displayName'), (string)($in['password'] ?? ''));
            $auth->signIn($u);
            Helpers::json(['ok' => true, 'user' => Helpers::sanitizeUser($u), 'csrfToken' => Security::csrfToken(), 'mustChangePassword' => false]);
        }

        // ---- admin: settings and invitations ----
        case 'admin_settings': {
            $auth->requireAdmin();
            $acc = new Accounts($store);
            $mailer = $acc->mailer();
            Helpers::json(['ok' => true, 'available' => $store->hasAccounts(), 'settings' => $acc->settings(),
                'mail' => $mailer->describe(), 'mailReady' => $mailer->configured()]);
        }
        case 'save_admin_settings': {
            $auth->requireAdmin();
            if (!$store->hasAccounts()) {
                Helpers::fail('Settings need a database update: run upgrade.php.', 503);
            }
            $s = (new Accounts($store))->saveSettings(!empty($in['allowForgot']), !empty($in['allowAdminReset']), Helpers::str($in, 'appUrl'));
            Helpers::json(['ok' => true, 'settings' => $s]);
        }
        case 'invite_user': {
            $me = $auth->requireAdmin();
            if ($store->throttle('invite', (string)$me['id'], 30, 3600) > 0) {
                Helpers::fail('Too many invitations just now. Try again later.', 429);
            }
            $acc = new Accounts($store);
            $acc->learnAppUrl(Helpers::str($in, 'appUrl'));
            $acc->invite($me, Helpers::str($in, 'email'), Helpers::str($in, 'displayName'), Helpers::str($in, 'role', 'user'));
            Helpers::json(['ok' => true, 'invites' => $acc->pendingInvites()]);
        }
        case 'revoke_invite': {
            $auth->requireAdmin();
            $acc = new Accounts($store);
            $acc->revokeInvite(Helpers::str($in, 'id'));
            Helpers::json(['ok' => true, 'invites' => $acc->pendingInvites()]);
        }
        case 'send_reset_link': {
            $me = $auth->requireAdmin();
            if ($store->throttle('invite', (string)$me['id'], 30, 3600) > 0) {
                Helpers::fail('Too many emails just now. Try again later.', 429);
            }
            $acc = new Accounts($store);
            $acc->learnAppUrl(Helpers::str($in, 'appUrl'));
            $to = $acc->adminReset($me, Helpers::str($in, 'userId'));
            Helpers::json(['ok' => true, 'to' => $to]);
        }

        // ---- admin: users ----
        case 'list_users': {
            $auth->requireAdmin();
            $users = array_map([Helpers::class, 'sanitizeUser'], $store->all('users'));
            // How email goes out (no secrets), for the Users dialog.
            $mailer = (new Accounts($store))->mailer();
            Helpers::json(['ok' => true, 'users' => array_values($users), 'mail' => $mailer->describe(),
                'mailReady' => $mailer->configured(), 'invites' => (new Accounts($store))->pendingInvites(),
                'allowAdminReset' => (new Accounts($store))->settings()['allowAdminReset']]);
        }
        case 'send_test_mail': {
            // An administrator checks the mail settings by mailing themselves.
            $me = $auth->requireAdmin();
            $to = trim((string)($me['email'] ?? ''));
            if ($to === '') {
                Helpers::fail('Add an email address to your profile first (the user menu, Profile).');
            }
            $wait = $store->throttle('testmail', (string)$me['id'], 10, 3600);
            if ($wait > 0) {
                Helpers::fail('Too many test emails. Try again later.', 429);
            }
            try {
                (new Accounts($store))->mailer()->send($to, 'Royal Tasks: test email',
                    "This is a test email from Royal Tasks.\n\nIf you can read this, the mail settings in config.php work.\n");
            } catch (RuntimeException $e) {
                Helpers::fail('Could not send: ' . $e->getMessage(), 502);
            }
            Helpers::json(['ok' => true, 'to' => $to]);
        }
        case 'create_user': {
            $auth->requireAdmin();
            $username = strtolower(Helpers::str($in, 'username'));
            $password = (string)($in['password'] ?? '');
            if (!preg_match('/^[a-z0-9_\-]{2,40}$/', $username)) {
                Helpers::fail('Username must be 2-40 chars: a-z 0-9 _ -');
            }
            AuthService::assertPasswordPolicy($password, $username);
            if ($store->findUserByUsername($username) !== null) {
                Helpers::fail('Username already exists.', 409);
            }
            $role = Helpers::str($in, 'role', 'user') === 'admin' ? 'admin' : 'user';
            $nu = $store->save('users', [
                'id' => Helpers::newId('u_'),
                'username' => $username,
                'displayName' => mb_substr(Helpers::str($in, 'displayName', $username), 0, 80),
                'role' => $role,
                'passwordHash' => password_hash($password, PASSWORD_DEFAULT),
                'mustChangePassword' => true,
                'createdAt' => Helpers::now(),
            ]);
            Helpers::json(['ok' => true, 'user' => Helpers::sanitizeUser($nu)]);
        }
        case 'update_user': {
            $me = $auth->requireAdmin();
            $target = $store->find('users', Helpers::str($in, 'userId'));
            if (!$target) {
                Helpers::fail('User not found.', 404);
            }
            if (array_key_exists('displayName', $in) && trim((string)$in['displayName']) !== '') {
                $target['displayName'] = mb_substr(trim((string)$in['displayName']), 0, 80);
            }
            if (array_key_exists('role', $in)) {
                $newRole = ((string)$in['role'] === 'admin') ? 'admin' : 'user';
                // Do not let the last administrator demote themselves out of
                // the system: there would be no way back in.
                if ($target['id'] === $me['id'] && $newRole !== 'admin') {
                    Helpers::fail('You cannot remove your own admin role.');
                }
                if ($newRole !== 'admin' && ($target['role'] ?? '') === 'admin' && rk_admin_count($store) <= 1) {
                    Helpers::fail('There must be at least one administrator.');
                }
                $target['role'] = $newRole;
            }
            if (array_key_exists('password', $in) && trim((string)$in['password']) !== '') {
                AuthService::assertPasswordPolicy((string)$in['password'], (string)$target['username']);
                $target['passwordHash'] = password_hash((string)$in['password'], PASSWORD_DEFAULT);
                // An admin-set password is temporary by definition.
                $target['mustChangePassword'] = true;
                $target['passwordChangedAt'] = Helpers::now();
            }
            $store->save('users', $target);
            Helpers::json(['ok' => true, 'user' => Helpers::sanitizeUser($target)]);
        }
        case 'preview_delete_user': {
            // Read-only: what deleting this user would do to their boards, so
            // the admin can confirm (and choose a viewers policy) knowingly.
            $auth->requireAdmin();
            $uid = Helpers::str($in, 'userId');
            if (!$store->find('users', $uid)) {
                Helpers::fail('User not found.', 404);
            }
            $boards = $store->previewDetachUser($uid);
            Helpers::json([
                'ok' => true,
                'boards' => $boards,
                'needsViewerPolicy' => array_sum(array_map(
                    fn($b) => $b['editSuccessors'] === 0 && $b['viewers'] > 0 ? 1 : 0,
                    $boards
                )) > 0,
            ]);
        }
        case 'delete_user': {
            $me = $auth->requireAdmin();
            $uid = Helpers::str($in, 'userId');
            if ($uid === $me['id']) {
                Helpers::fail('You cannot delete yourself.');
            }
            $target = $store->find('users', $uid);
            if (!$target) {
                Helpers::fail('User not found.', 404);
            }
            if (($target['role'] ?? '') === 'admin' && rk_admin_count($store) <= 1) {
                Helpers::fail('There must be at least one administrator.');
            }
            // How to treat boards left with only view-only members. The admin
            // must choose explicitly when there are any: an API caller that does
            // not state a policy gets a 400 rather than silently deleting boards.
            $preview = $store->previewDetachUser($uid);
            $needsPolicy = false;
            foreach ($preview as $b) {
                if ($b['editSuccessors'] === 0 && $b['viewers'] > 0) {
                    $needsPolicy = true;
                    break;
                }
            }
            $raw = Helpers::str($in, 'viewerPolicy', '');
            $policy = in_array($raw, ['promote', 'transfer', 'delete'], true) ? $raw : '';
            if ($needsPolicy && $policy === '') {
                Helpers::fail(
                    'This user owns boards with only view-only members. Send viewerPolicy: "promote", "transfer" or "delete".',
                    400
                );
            }
            // No viewer-only boards: the policy is irrelevant, but still
            // validated so nothing unstated can reach the storage layer.
            if ($policy === '') {
                $policy = 'delete';
            }

            // Detach first, then delete the account. Doing it the other way
            // round let the foreign keys act before the transfer: membership
            // rows cascade away and owner_id is SET NULL, so there was nothing
            // left to reassign by the time detachUser ran.
            $deletedBoards = $store->detachUser($uid, $policy, (string)$me['id']);

            // Remove the user's pending share inbox and the files behind it.
            // The rows cascade with the account, but the inbox_* folders are
            // on disk and would otherwise linger until someone else shares.
            foreach ($store->findInboxIdsFor($uid) as $inboxId) {
                Uploads::deleteDir('inbox_' . $inboxId);
            }

            $store->delete('users', $uid);
            if (!empty($target['avatar'])) {
                Uploads::deleteStored((string)$target['avatar']); // their picture goes with them
            }
            foreach ($deletedBoards as $boardId) {
                Uploads::deleteDir($boardId); // memberless board: remove its files too
            }
            $store->bumpVersion();
            Helpers::json([
                'ok' => true,
                'transferred' => true,
                'deletedBoards' => count($deletedBoards),
                'viewerPolicy' => $policy,
            ]);
        }

        default:
            Helpers::fail('Unknown action.', 404);
    }
} catch (VersionConflict $e) {
    // Someone else saved this board first. Return it as it stands so the
    // client can show the current state instead of retrying blindly.
    Helpers::fail($e->getMessage(), 409, [
        'conflict' => true,
        'board' => $e->current,
        'version' => $store->getVersion(),
    ]);
} catch (PDOException $e) {
    // A PDOException is a RuntimeException, but its message names the
    // database, tables and constraints: log it, tell the client nothing.
    Helpers::failInternal($e);
} catch (RuntimeException $e) {
    // Service-level failures carry a message meant for the user.
    $code = (int)$e->getCode();
    if ($code < 400 || $code >= 600) {
        $code = 400;
    }
    Helpers::fail($e->getMessage() ?: 'Request failed.', $code);
} catch (Throwable $e) {
    // Anything else is a bug: log it, tell the client nothing.
    Helpers::failInternal($e);
}

/** Number of accounts that can still administer the app. */
function rk_admin_count(StorageInterface $store): int
{
    $n = 0;
    foreach ($store->all('users') as $u) {
        if (($u['role'] ?? '') === 'admin') {
            $n++;
        }
    }
    return $n;
}
