<?php
declare(strict_types=1);

final class BoardService
{
    public const COLOR_SCHEMES = Helpers::COLOR_SCHEMES;

    // Upper bounds so a single request cannot turn into a permanent DoS.
    public const MAX_MEMBERS = 200;
    public const MAX_LISTS = 60;
    public const MAX_CARDS_PER_BOARD = 5000;
    public const MAX_CHECKLISTS_PER_CARD = 50;
    public const MAX_ITEMS_PER_CHECKLIST = 200;
    public const MAX_COMMENTS_PER_CARD = 500;
    public const MAX_ATTACHMENTS_PER_CARD = 50;

    public function __construct(private StorageInterface $store) {}

    /**
     * The board version the client believed it was editing, from this
     * request. Held on the service because every mutation funnels through
     * persist(); threading it through twenty method signatures would say the
     * same thing twenty times. Null means "no claim" and skips the check.
     */
    private ?int $expectedVersion = null;

    public function expectBoardVersion(?int $version): void
    {
        $this->expectedVersion = $version;
    }

    /** @return array<string,mixed> */
    private function getBoardOrFail(string $boardId): array
    {
        $b = $this->store->find('boards', $boardId);
        if (!$b) {
            Helpers::fail('Board not found.', 404);
        }
        // normalize shape for old files
        $b['members'] ??= [];
        $b['lists'] ??= [];
        $b['cards'] ??= [];
        $b['colorScheme'] = Helpers::colorScheme($b['colorScheme'] ?? null);
        $b['backgroundImage'] ??= '';
        $b['backgroundMime'] ??= '';
        foreach ($b['cards'] as &$c) {
            $c['archived'] ??= false;
            $c['attachments'] ??= [];
        }
        unset($c);
        return $b;
    }

    private function persist(array $board, array $actor, string $activityText = ''): array
    {
        $board['updatedAt'] = Helpers::now();
        // The version this request loaded. If the client made no claim, this
        // still detects a write that landed between our read and our write,
        // so the guarantee does not depend on the client participating.
        $loaded = (int)($board['version'] ?? 0);
        $board['version'] = $loaded + 1;
        try {
            // Refuses the write if someone else has saved this board since it
            // was read, instead of overwriting their work.
            if ($this->expectedVersion !== null && $this->expectedVersion !== $loaded) {
                throw new VersionConflict($this->store->find('boards', (string)$board['id']) ?? $board, $loaded, $this->expectedVersion);
            }
            $saved = $this->store->saveIfVersion('boards', $board, $loaded);
        } catch (VersionConflict $e) {
            // Hand back the board as it actually is, with this user's role on
            // it, so the client can show the current state.
            $e->current['myRole'] = Helpers::boardRole($actor, $e->current) ?? 'view';
            throw $e;
        }
        $this->store->bumpVersion();
        // Keep the actor's role on the response: without it the client
        // treats the board as role-less (read-only) until the next refresh.
        $saved['myRole'] = Helpers::boardRole($actor, $saved) ?? 'view';
        return $saved;
    }

    /** @param array<string,mixed> $actor */
    private function logCard(array &$card, array $actor, string $text): void
    {
        $card['activity'][] = [
            'id' => Helpers::newId('a_'),
            'userId' => $actor['id'],
            'username' => $actor['displayName'] ?? $actor['username'],
            'text' => $text,
            'createdAt' => Helpers::now(),
        ];
    }

    /** True when this board's content is encrypted in the browser. */
    private function encrypted(string $boardId): bool
    {
        return $this->store->isBoardEncrypted($boardId);
    }

    /**
     * Prepare a free-text field for storage.
     *
     * On a plaintext board the value is sanitised and cut at the column's
     * plaintext limit, as before. On an encrypted board the value is opaque
     * ciphertext: sanitising it would corrupt the base64 and cutting it at the
     * plaintext limit would truncate the box. The client enforces the real
     * limit; the server only applies a generous byte cap so a request cannot
     * store unbounded data.
     */
    private function content(string $value, int $plainLimit, string $boardId, bool $rich = false): string
    {
        if ($this->encrypted($boardId)) {
            return mb_substr($value, 0, 4000000);
        }
        if ($rich) {
            $value = Helpers::sanitizeRichText($value);
        }
        return mb_substr($value, 0, $plainLimit);
    }

    // ---------- boards ----------

    /** @return array<int,mixed> */
    public function listFor(array $user): array
    {
        // The store answers "boards this user may see" directly; loading
        // every board and filtering in PHP does not survive a thousand users.
        // Membership is the only thing that grants sight of a board, so the
        // admin flag is always false here — an admin is not a member of boards
        // they were not invited to.
        $boards = $this->store->boardsVisibleTo((string)$user['id'], false);
        foreach ($boards as &$b) {
            $b['myRole'] = Helpers::boardRole($user, $b);
        }
        usort($boards, fn($a, $b) => strcmp((string)($b['updatedAt'] ?? ''), (string)($a['updatedAt'] ?? '')));
        return $boards;
    }

    public function create(array $user, string $title, string $color): array
    {
        $title = trim($title);
        if ($title === '') {
            Helpers::fail('Board title is required.');
        }
        $color = Helpers::colorScheme($color);
        $board = [
            'id' => Helpers::newId('b_'),
            'title' => mb_substr($title, 0, 120),
            'colorScheme' => $color,
            'ownerId' => $user['id'],
            'members' => [],
            'lists' => [
                ['id' => Helpers::newId('l_'), 'title' => 'To do', 'order' => 0],
                ['id' => Helpers::newId('l_'), 'title' => 'In progress', 'order' => 1],
                ['id' => Helpers::newId('l_'), 'title' => 'Done', 'order' => 2],
            ],
            'cards' => [],
            'createdAt' => Helpers::now(),
            'updatedAt' => Helpers::now(),
            'version' => 1,
        ];
        $this->store->save('boards', $board);
        $this->store->bumpVersion();
        $board['myRole'] = 'admin';
        return $board;
    }

    public function update(array $user, string $boardId, ?string $title, ?string $color): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('No access to this board.', 403);
        }
        if ($title !== null && trim($title) !== '') {
            $b['title'] = mb_substr(trim($title), 0, 120);
        }
        if ($color !== null && in_array($color, self::COLOR_SCHEMES, true)) {
            $b['colorScheme'] = $color;
        }
        return $this->persist($b, $user);
    }

    public function delete(array $user, string $boardId): void
    {
        $b = $this->getBoardOrFail($boardId);
        $role = Helpers::boardRole($user, $b);
        if ($role !== 'admin') {
            Helpers::fail('Only board owner/admin can delete.', 403);
        }
        $this->store->delete('boards', $boardId);
        $this->store->bumpVersion();
    }

    /**
     * Set or replace a board's background image.
     *
     * The file is stored like any other upload (allowlisted type, generated
     * name, under the board's own folder), and only the stored path and MIME
     * type go in the board row. The old image is removed once the new one is
     * saved, so a replacement never leaves the previous file behind.
     *
     * @param array<int,array<string,mixed>> $records from Uploads::saveFiles
     */
    /** The image types a board background may be (see setBackground and api/file.php). */
    public const BACKGROUND_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

    public function setBackground(array $user, string $boardId, array $records): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $rec = $records[0] ?? null;
        if (!$rec || ($rec['stored'] ?? '') === '') {
            Helpers::fail('No image received.');
        }
        if ($this->encrypted($boardId)) {
            // A background is not encrypted in the browser; on an end-to-end
            // board the server would see the picture.
            Uploads::deleteStored((string)$rec['stored']);
            Helpers::fail('An end-to-end encrypted board has no background picture.', 400);
        }
        // PNG, JPEG, GIF or WebP, by name and by content. Never SVG: an SVG
        // is a document that can run script on the app's origin.
        $mime = (string)($rec['mime'] ?? '');
        if (!in_array($mime, self::BACKGROUND_TYPES, true) || !Uploads::isRasterImage((string)$rec['stored'], $boardId)) {
            Uploads::deleteStored((string)$rec['stored']);
            Helpers::fail('A board background must be a PNG, JPEG, GIF or WebP image.');
        }
        $previous = (string)($b['backgroundImage'] ?? '');
        $b['backgroundImage'] = (string)$rec['stored'];
        $b['backgroundMime'] = $mime;
        $saved = $this->persist($b, $user);
        if ($previous !== '' && $previous !== $b['backgroundImage']) {
            Uploads::deleteStored($previous);
        }
        return $saved;
    }

    public function clearBackground(array $user, string $boardId): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $previous = (string)($b['backgroundImage'] ?? '');
        $b['backgroundImage'] = '';
        $b['backgroundMime'] = '';
        $saved = $this->persist($b, $user);
        if ($previous !== '') {
            Uploads::deleteStored($previous);
        }
        return $saved;
    }

    public function share(array $user, string $boardId, string $username, string $access): array
    {
        $b = $this->getBoardOrFail($boardId);
        // Membership is the board owner's call: an editor may change content,
        // not who else gets in.
        if (!Helpers::canAdminBoard($user, $b)) {
            Helpers::fail('Only the board owner can change sharing.', 403);
        }
        if (!in_array($access, ['view', 'edit'], true)) {
            Helpers::fail('Access must be view or edit.');
        }
        if (count($b['members']) >= self::MAX_MEMBERS) {
            Helpers::fail('This board already has the maximum number of members.');
        }
        $target = $this->store->findUserByUsername($username);
        if (!$target) {
            // Deliberately vague: this endpoint is not a username oracle.
            Helpers::fail('Could not share the board with that user.', 404);
        }
        if ($target['id'] === $b['ownerId']) {
            Helpers::fail('That user already owns the board.');
        }
        $found = false;
        foreach ($b['members'] as &$m) {
            if ($m['userId'] === $target['id']) {
                $m['access'] = $access;
                $found = true;
            }
        }
        if (!$found) {
            $b['members'][] = ['userId' => $target['id'], 'username' => $target['username'], 'access' => $access];
        }
        return $this->persist($b, $user);
    }

    public function unshare(array $user, string $boardId, string $targetUserId): array
    {
        $b = $this->getBoardOrFail($boardId);
        // Members may always remove themselves; removing anyone else is the
        // owner's call.
        if ($targetUserId !== ($user['id'] ?? null) && !Helpers::canAdminBoard($user, $b)) {
            Helpers::fail('Only the board owner can change sharing.', 403);
        }
        $b['members'] = array_values(array_filter($b['members'], fn($m) => ($m['userId'] ?? null) !== $targetUserId));
        return $this->persist($b, $user);
    }

    // ---------- board encryption keys ----------

    /**
     * The wrapped key material a client needs to unlock a board.
     *
     * Any member may read what is needed to derive the board key — they still
     * have to know the password. The recovery copy is owner-only: it is a
     * second way in and must not be handed to every member.
     *
     * @return array<string,mixed>
     */
    public function boardKeyFor(array $user, string $boardId): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canView($user, $b)) {
            Helpers::fail('No access to this board.', 403);
        }
        $key = $this->store->boardKey($boardId);
        if (!$key) {
            return ['encrypted' => false];
        }
        $out = [
            'encrypted' => true,
            'alg' => (string)$key['kdf_alg'],
            'salt' => (string)$key['kdf_salt'],
            'opslimit' => (int)$key['kdf_opslimit'],
            'memlimit' => (int)$key['kdf_memlimit'],
            'wrappedKey' => (string)$key['wrapped_key'],
        ];
        if (Helpers::canAdminBoard($user, $b) && !empty($key['recovery_wrapped_key'])) {
            $out['recoveryWrappedKey'] = (string)$key['recovery_wrapped_key'];
        }
        return $out;
    }

    /**
     * Set or replace a board's password-protected key.
     *
     * The server stores only the KDF parameters and the wrapped board key; it
     * cannot derive the key. Only the board owner (or a site admin) may change
     * it — a password change locks everyone else out until the owner shares
     * the new one, so it is not a member-level action.
     *
     * @param array<string,mixed> $data
     * @return array<string,mixed>
     */
    /**
     * Replace a just-encrypted board's existing text with the ciphertext the
     * owner's browser made of it (RKE2E.sealExisting), in one write: list and
     * label names, card titles and descriptions, checklist titles, items and
     * comments, each found by id. Only on a board that is end-to-end
     * encrypted, by its owner; anything not on the board is ignored. The
     * values are stored as they come, like every field of such a board.
     *
     * @param array<string,mixed> $p {lists, labels, checklists, items, comments: {id: text}, cards: {id: {title, description}}}
     */
    public function sealContent(array $user, string $boardId, array $p): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canAdminBoard($user, $b)) {
            Helpers::fail('Only the board owner can encrypt its content.', 403);
        }
        if (!$this->encrypted($boardId)) {
            Helpers::fail('Set the board password first.', 400);
        }
        $map = static function (mixed $m): array {
            $out = [];
            foreach (is_array($m) ? $m : [] as $id => $v) {
                if (is_string($v) && strlen($v) <= 400000) {
                    $out[(string)$id] = $v;
                }
            }
            return $out;
        };
        $lists = $map($p['lists'] ?? null);
        $labels = $map($p['labels'] ?? null);
        $checklists = $map($p['checklists'] ?? null);
        $items = $map($p['items'] ?? null);
        $comments = $map($p['comments'] ?? null);
        $cards = is_array($p['cards'] ?? null) ? $p['cards'] : [];
        foreach ($b['lists'] as &$l) {
            if (isset($lists[$l['id']])) $l['title'] = $lists[$l['id']];
        }
        unset($l);
        foreach ($b['labels'] ?? [] as $n => $l) {
            if (isset($labels[$l['id']])) $b['labels'][$n]['name'] = $labels[$l['id']];
        }
        foreach ($b['cards'] as &$c) {
            $cc = $cards[$c['id']] ?? null;
            if (is_array($cc)) {
                foreach (['title', 'description'] as $f) {
                    if (is_string($cc[$f] ?? null) && strlen($cc[$f]) <= 400000) $c[$f] = $cc[$f];
                }
            }
            foreach ($c['checklists'] ?? [] as $kn => $k) {
                if (isset($checklists[$k['id']])) $c['checklists'][$kn]['title'] = $checklists[$k['id']];
                foreach ($k['items'] ?? [] as $tn => $t) {
                    if (isset($items[$t['id']])) {
                        $c['checklists'][$kn]['items'][$tn]['text'] = $items[$t['id']];
                        unset($c['checklists'][$kn]['items'][$tn]['link']); // a page title read before: plaintext
                    }
                }
            }
            foreach ($c['comments'] ?? [] as $mn => $m) {
                if (isset($comments[$m['id']])) $c['comments'][$mn]['text'] = $comments[$m['id']];
            }
        }
        unset($c);
        return $this->persist($b, $user);
    }

    public function saveBoardKey(array $user, string $boardId, array $data): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canAdminBoard($user, $b)) {
            Helpers::fail('Only the board owner can set the board password.', 403);
        }
        $alg = (string)($data['alg'] ?? 'argon2id13');
        if ($alg !== 'argon2id13') {
            Helpers::fail('Unsupported key derivation.');
        }
        $salt = (string)($data['salt'] ?? '');
        $wrapped = (string)($data['wrappedKey'] ?? '');
        if ($salt === '' || $wrapped === '') {
            Helpers::fail('Missing key material.');
        }
        if (strlen($salt) > 256 || strlen($wrapped) > 100000) {
            Helpers::fail('Key material is too large.');
        }
        $recovery = (string)($data['recoveryWrappedKey'] ?? '');
        if (strlen($recovery) > 100000) {
            Helpers::fail('Key material is too large.');
        }
        $this->store->saveBoardKey($boardId, [
            'alg' => $alg,
            'salt' => $salt,
            'opslimit' => (int)($data['opslimit'] ?? 0),
            'memlimit' => (int)($data['memlimit'] ?? 0),
            'wrappedKey' => $wrapped,
            'recoveryWrappedKey' => $recovery,
        ]);
        return $this->boardKeyFor($user, $boardId);
    }

    // ---------- lists ----------

    public function createList(array $user, string $boardId, string $title): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        if (count($b['lists']) >= self::MAX_LISTS) {
            Helpers::fail('This board already has the maximum number of lists.');
        }
        $title = trim($title) ?: 'New list';
        $b['lists'][] = ['id' => Helpers::newId('l_'), 'title' => $this->content($title, 80, $boardId), 'order' => Helpers::nextOrder($b['lists'])];
        $b['lists'] = Helpers::resequence($b['lists']);
        return $this->persist($b, $user);
    }

    public function updateList(array $user, string $boardId, string $listId, string $title): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        foreach ($b['lists'] as &$l) {
            if ($l['id'] === $listId) {
                $l['title'] = $this->content(trim($title) ?: $l['title'], 80, $boardId);
            }
        }
        return $this->persist($b, $user);
    }

    public function deleteList(array $user, string $boardId, string $listId): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        // The cards in this list go with it, so their files must too.
        $files = [];
        foreach ($b['cards'] as $c) {
            if (($c['listId'] ?? null) === $listId) {
                $files = array_merge($files, $this->cardStoredFiles($b, (string)$c['id']));
            }
        }
        $b['lists'] = array_values(array_filter($b['lists'], fn($l) => $l['id'] !== $listId));
        $b['cards'] = array_values(array_filter($b['cards'], fn($c) => ($c['listId'] ?? null) !== $listId));
        $b['lists'] = Helpers::resequence($b['lists']);
        $saved = $this->persist($b, $user);
        $this->purgeFiles($files);
        return $saved;
    }

    public function moveList(array $user, string $boardId, string $listId, int $toIndex): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $lists = Helpers::resequence($b['lists']);
        $from = null;
        foreach ($lists as $i => $l) {
            if ($l['id'] === $listId) {
                $from = $i;
                break;
            }
        }
        if ($from === null) {
            Helpers::fail('List not found.', 404);
        }
        $item = $lists[$from];
        array_splice($lists, $from, 1);
        $toIndex = max(0, min($toIndex, count($lists)));
        array_splice($lists, $toIndex, 0, [$item]);
        foreach ($lists as $i => &$l) {
            $l['order'] = $i;
        }
        $b['lists'] = $lists;
        return $this->persist($b, $user);
    }

    // ---------- cards ----------

    /** @return array<string,mixed> card ref index */
    private function cardIndex(array $board, string $cardId): int
    {
        foreach ($board['cards'] as $i => $c) {
            if (($c['id'] ?? null) === $cardId) {
                return $i;
            }
        }
        Helpers::fail('Card not found.', 404);
        return -1; // unreachable
    }

    public function createCard(array $user, string $boardId, string $listId, string $title): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $title = trim($title);
        if ($title === '') {
            Helpers::fail('Card title is required.');
        }
        if (count($b['cards']) >= self::MAX_CARDS_PER_BOARD) {
            Helpers::fail('This board already has the maximum number of cards.');
        }
        $this->requireList($b, $listId);
        $inList = array_filter($b['cards'], fn($c) => ($c['listId'] ?? null) === $listId);
        $card = [
            'id' => Helpers::newId('c_'),
            'boardId' => $boardId,
            'listId' => $listId,
            'title' => $this->content($title, 200, $boardId),
            'description' => '',
            'dueDate' => null,
            'order' => Helpers::nextOrder($inList),
            'archived' => false,
            'archivedAt' => null,
            'checklists' => [],
            'comments' => [],
            'attachments' => [],
            'activity' => [[
                'id' => Helpers::newId('a_'),
                'userId' => $user['id'],
                'username' => $user['displayName'] ?? $user['username'],
                'text' => 'created this card',
                'createdAt' => Helpers::now(),
            ]],
            'createdAt' => Helpers::now(),
            'updatedAt' => Helpers::now(),
        ];
        $b['cards'][] = $card;
        $saved = $this->persist($b, $user);
        // return the created card
        foreach ($saved['cards'] as $c) {
            if ($c['id'] === $card['id']) {
                return ['board' => $saved, 'card' => $c];
            }
        }
        return ['board' => $saved, 'card' => $card];
    }

    public function updateCard(array $user, string $boardId, string $cardId, ?string $title, ?string $description, ?string $dueDate): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $i = $this->cardIndex($b, $cardId);
        if ($title !== null && trim($title) !== '') {
            $b['cards'][$i]['title'] = $this->content(trim($title), 200, $boardId);
        }
        if ($description !== null) {
            $b['cards'][$i]['description'] = $this->content($description, 20000, $boardId, true);
        }
        if ($dueDate !== null) {
            $d = trim($dueDate);
            // A calendar day, YYYY-MM-DD, that exists (no 2026-02-30), in a
            // sensible range: a date field typed digit by digit passes through
            // years like 0002 and 0202 on its way to 2026.
            if ($d !== '' && (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $d, $m)
                || !checkdate((int)$m[2], (int)$m[3], (int)$m[1]) || (int)$m[1] < 1900 || (int)$m[1] > 2999)) {
                Helpers::fail('A finish date must be a real day, YYYY-MM-DD.');
            }
            $b['cards'][$i]['dueDate'] = $d === '' ? null : $d;
        }
        $b['cards'][$i]['updatedAt'] = Helpers::now();
        $this->logCard($b['cards'][$i], $user, 'updated this card');
        return $this->persist($b, $user);
    }

    public function moveCard(array $user, string $boardId, string $cardId, string $toListId, int $toIndex): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $this->requireList($b, $toListId);
        $i = $this->cardIndex($b, $cardId);
        $card = $b['cards'][$i];
        // remove from ordering, then re-insert
        unset($b['cards'][$i]);
        $b['cards'] = array_values($b['cards']);

        $card['listId'] = $toListId;
        // siblings in target list (without the card), ordered
        $siblings = array_values(array_filter($b['cards'], fn($c) => ($c['listId'] ?? null) === $toListId));
        usort($siblings, fn($a, $c) => ((int)($a['order'] ?? 0)) <=> ((int)($c['order'] ?? 0)));
        $card['updatedAt'] = Helpers::now();
        $b['cards'][] = $card;
        // toIndex is a position among the cards the client can see, which
        // excludes archived ones. Insert before the toIndex-th visible sibling
        // in the full ordering, so archived cards do not shift the target.
        $ids = array_map(fn($c) => $c['id'], $siblings);
        $visible = array_values(array_filter($siblings, fn($c) => empty($c['archived'])));
        $toIndex = max(0, $toIndex);
        $at = $toIndex < count($visible)
            ? (int)array_search($visible[$toIndex]['id'], $ids, true)
            : count($ids);
        array_splice($ids, $at, 0, [$cardId]);
        $byId = [];
        foreach ($b['cards'] as $c) {
            $byId[$c['id']] = $c;
        }
        foreach ($ids as $ord => $cid) {
            $byId[$cid]['order'] = $ord;
        }
        $b['cards'] = array_values($byId);
        $idx = $this->cardIndex($b, $cardId);
        $this->logCard($b['cards'][$idx], $user, 'moved this card');
        return $this->persist($b, $user);
    }

    public function deleteCard(array $user, string $boardId, string $cardId): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        // Collect the files before the rows are gone: deleting a card must
        // delete what it stored, or the bytes stay on disk and stay reachable.
        $files = $this->cardStoredFiles($b, $cardId);
        $b['cards'] = array_values(array_filter($b['cards'], fn($c) => ($c['id'] ?? null) !== $cardId));
        $saved = $this->persist($b, $user);
        $this->purgeFiles($files);
        return $saved;
    }

    /**
     * Every stored file path referenced by a card.
     *
     * @return array<int,string>
     */
    private function cardStoredFiles(array $board, string $cardId): array
    {
        foreach ($board['cards'] ?? [] as $c) {
            if (($c['id'] ?? null) === $cardId) {
                return array_values(array_filter(array_map(
                    fn($a) => (string)($a['stored'] ?? ''),
                    $c['attachments'] ?? []
                )));
            }
        }
        return [];
    }

    /**
     * Remove stored files, but only those no live attachment row still points
     * at. A whole-board delete passes no keep-list and removes the files it was
     * given unconditionally.
     *
     * @param array<int,string> $stored
     */
    private function purgeFiles(array $stored): void
    {
        foreach ($stored as $path) {
            if ($path === '') {
                continue;
            }
            if ($this->store->storedFileInUse($path)) {
                continue; // referenced by another card; leave it alone
            }
            Uploads::deleteStored($path);
        }
    }

    public function archiveCard(array $user, string $boardId, string $cardId, bool $archived): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $i = $this->cardIndex($b, $cardId);
        $b['cards'][$i]['archived'] = $archived;
        $b['cards'][$i]['archivedAt'] = $archived ? Helpers::now() : null;
        $b['cards'][$i]['updatedAt'] = Helpers::now();
        $this->logCard($b['cards'][$i], $user, $archived ? 'archived this card' : 'restored this card');
        return $this->persist($b, $user);
    }

    /** Tick or untick a card's "Mark complete" box. */
    public function completeCard(array $user, string $boardId, string $cardId, bool $completed): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $i = $this->cardIndex($b, $cardId);
        if (!empty($b['cards'][$i]['completed']) === $completed) {
            return $b; // already so; no write, no version bump
        }
        $b['cards'][$i]['completed'] = $completed;
        $b['cards'][$i]['updatedAt'] = Helpers::now();
        $this->logCard($b['cards'][$i], $user, $completed ? 'marked this card complete' : 'marked this card incomplete');
        return $this->persist($b, $user);
    }

    /**
     * Archive every unarchived card in one list, in a single write. One call
     * rather than one per card: each write bumps the board version, so a loop
     * of archive_card calls from the client would race its own conflicts.
     */
    public function archiveListCards(array $user, string $boardId, string $listId): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        if (!in_array($listId, array_map(fn($l) => $l['id'], $b['lists']), true)) {
            Helpers::fail('List not found.', 404);
        }
        $now = Helpers::now();
        foreach ($b['cards'] as $i => $c) {
            if (($c['listId'] ?? null) !== $listId || !empty($c['archived'])) {
                continue;
            }
            $b['cards'][$i]['archived'] = true;
            $b['cards'][$i]['archivedAt'] = $now;
            $b['cards'][$i]['updatedAt'] = $now;
            $this->logCard($b['cards'][$i], $user, 'archived this card');
        }
        return $this->persist($b, $user);
    }

    /**
     * Empty the board's archive: every archived card goes, the ones on the
     * board stay. Their files go too, after the rows, like deleting one card.
     *
     * @return array{board:array<string,mixed>,deleted:int}
     */
    public function emptyArchive(array $user, string $boardId): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $gone = fn($c) => !empty($c['archived']);
        $files = [];
        $deleted = 0;
        foreach ($b['cards'] as $c) {
            if ($gone($c)) {
                $files = array_merge($files, $this->cardStoredFiles($b, (string)$c['id']));
                $deleted++;
            }
        }
        $b['cards'] = array_values(array_filter($b['cards'], fn($c) => !$gone($c)));
        $saved = $this->persist($b, $user);
        $this->purgeFiles($files);
        return ['board' => $saved, 'deleted' => $deleted];
    }

    // ---------- checklists ----------

    public function addChecklist(array $user, string $boardId, string $cardId, string $title): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $i = $this->cardIndex($b, $cardId);
        if (count($b['cards'][$i]['checklists'] ?? []) >= self::MAX_CHECKLISTS_PER_CARD) {
            Helpers::fail('This card already has the maximum number of checklists.');
        }
        $b['cards'][$i]['checklists'][] = [
            'id' => Helpers::newId('k_'),
            'title' => $this->content(trim($title) ?: 'Checklist', 120, $boardId),
            'items' => [],
        ];
        $this->logCard($b['cards'][$i], $user, 'added a checklist');
        return $this->persist($b, $user);
    }

    public function deleteChecklist(array $user, string $boardId, string $cardId, string $checklistId): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $i = $this->cardIndex($b, $cardId);
        $b['cards'][$i]['checklists'] = array_values(array_filter(
            $b['cards'][$i]['checklists'] ?? [],
            fn($k) => ($k['id'] ?? null) !== $checklistId
        ));
        return $this->persist($b, $user);
    }

    public function renameChecklist(array $user, string $boardId, string $cardId, string $checklistId, string $title): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $title = trim($title);
        if ($title === '') {
            Helpers::fail('Checklist title is required.');
        }
        $i = $this->cardIndex($b, $cardId);
        foreach ($b['cards'][$i]['checklists'] as &$k) {
            if (($k['id'] ?? null) === $checklistId) {
                $k['title'] = $this->content($title, 120, $boardId);
            }
        }
        return $this->persist($b, $user);
    }

    public function addItem(array $user, string $boardId, string $cardId, string $checklistId, string $text): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $i = $this->cardIndex($b, $cardId);
        $text = trim($text);
        if ($text === '') {
            Helpers::fail('Item text is required.');
        }
        foreach ($b['cards'][$i]['checklists'] as &$k) {
            if (($k['id'] ?? null) === $checklistId) {
                if (count($k['items'] ?? []) >= self::MAX_ITEMS_PER_CHECKLIST) {
                    Helpers::fail('This checklist already has the maximum number of items.');
                }
                $k['items'][] = ['id' => Helpers::newId('t_'), 'text' => $this->content($text, 300, $boardId), 'done' => false];
            }
        }
        unset($k);
        return $this->persist($b, $user);
    }

    public function toggleItem(array $user, string $boardId, string $cardId, string $checklistId, string $itemId, ?bool $done): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $i = $this->cardIndex($b, $cardId);
        foreach ($b['cards'][$i]['checklists'] as &$k) {
            if (($k['id'] ?? null) === $checklistId) {
                foreach ($k['items'] as &$t) {
                    if (($t['id'] ?? null) === $itemId) {
                        $t['done'] = $done ?? !((bool)($t['done'] ?? false));
                    }
                }
            }
        }
        return $this->persist($b, $user);
    }

    /**
     * Move a checklist item: to another place in its checklist, or into
     * another checklist of the same card, at $toIndex.
     */
    public function moveItem(array $user, string $boardId, string $cardId, string $checklistId, string $itemId,
        string $toChecklistId, int $toIndex): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $i = $this->cardIndex($b, $cardId);
        $lists = &$b['cards'][$i]['checklists'];
        $from = $to = null;
        foreach ($lists as $n => $k) {
            if (($k['id'] ?? null) === $checklistId) $from = $n;
            if (($k['id'] ?? null) === ($toChecklistId !== '' ? $toChecklistId : $checklistId)) $to = $n;
        }
        if ($from === null || $to === null) {
            Helpers::fail('That checklist is not on this card.', 404);
        }
        $item = null;
        foreach ($lists[$from]['items'] ?? [] as $n => $t) {
            if (($t['id'] ?? null) === $itemId) {
                $item = $t;
                array_splice($lists[$from]['items'], $n, 1);
                break;
            }
        }
        if ($item === null) {
            Helpers::fail('That item is not on this card.', 404);
        }
        if ($to !== $from) {
            // Into another checklist: a fresh id. Rows never change owner (the
            // upsert is guarded by checklist_id), so under its old id the item
            // would stay with the old checklist and be swept away with it.
            $item['id'] = Helpers::newId('t_');
        }
        $lists[$to]['items'] = $lists[$to]['items'] ?? [];
        array_splice($lists[$to]['items'], max(0, min($toIndex, count($lists[$to]['items']))), 0, [$item]);
        unset($lists);
        return $this->persist($b, $user);
    }

    /** Change a checklist item's text (clicked and edited in the card). */
    public function renameItem(array $user, string $boardId, string $cardId, string $checklistId, string $itemId, string $text): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $text = trim($text);
        if ($text === '') {
            Helpers::fail('An item needs some text.');
        }
        $i = $this->cardIndex($b, $cardId);
        $found = false;
        foreach ($b['cards'][$i]['checklists'] as &$k) {
            if (($k['id'] ?? null) === $checklistId) {
                foreach ($k['items'] as &$t) {
                    if (($t['id'] ?? null) === $itemId) {
                        $t['text'] = $this->content($text, 300, $boardId);
                        if (($t['link']['url'] ?? null) !== $text) {
                            unset($t['link']); // it described the old address
                        }
                        $found = true;
                    }
                }
                unset($t);
            }
        }
        unset($k);
        if (!$found) {
            Helpers::fail('That item is not on this card.', 404);
        }
        return $this->persist($b, $user);
    }

    public function deleteItem(array $user, string $boardId, string $cardId, string $checklistId, string $itemId): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        $i = $this->cardIndex($b, $cardId);
        foreach ($b['cards'][$i]['checklists'] as &$k) {
            if (($k['id'] ?? null) === $checklistId) {
                $k['items'] = array_values(array_filter($k['items'] ?? [], fn($t) => ($t['id'] ?? null) !== $itemId));
            }
        }
        return $this->persist($b, $user);
    }

    // ---------- comments ----------

    public function addComment(array $user, string $boardId, string $cardId, string $text): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canView($user, $b)) {
            Helpers::fail('No access to this board.', 403);
        }
        // viewers may comment, editors+ may do everything
        $text = trim($text);
        if ($text === '') {
            Helpers::fail('Comment is empty.');
        }
        $i = $this->cardIndex($b, $cardId);
        if (count($b['cards'][$i]['comments'] ?? []) >= self::MAX_COMMENTS_PER_CARD) {
            Helpers::fail('This card already has the maximum number of comments.');
        }
        $b['cards'][$i]['comments'][] = [
            'id' => Helpers::newId('m_'),
            'userId' => $user['id'],
            'username' => $user['displayName'] ?? $user['username'],
            'text' => $this->content($text, 2000, $boardId),
            'createdAt' => Helpers::now(),
        ];
        $this->logCard($b['cards'][$i], $user, 'commented');
        return $this->persist($b, $user);
    }

    /**
     * Edit a comment's text. Only its author may: the owner can remove
     * someone else's comment, but never put words in their mouth. The
     * comment is marked as edited, with the time.
     */
    public function editComment(array $user, string $boardId, string $cardId, string $commentId, string $text): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canView($user, $b)) {
            Helpers::fail('No access to this board.', 403);
        }
        $text = trim($text);
        if ($text === '') {
            Helpers::fail('Comment is empty.');
        }
        $i = $this->cardIndex($b, $cardId);
        $found = false;
        foreach ($b['cards'][$i]['comments'] ?? [] as $k => $m) {
            if (($m['id'] ?? null) !== $commentId) {
                continue;
            }
            if (($m['userId'] ?? null) !== $user['id']) {
                Helpers::fail('Only the comment\'s author can edit it.', 403);
            }
            $b['cards'][$i]['comments'][$k]['text'] = $this->content($text, 2000, $boardId);
            $b['cards'][$i]['comments'][$k]['editedAt'] = Helpers::now();
            $found = true;
        }
        if (!$found) {
            Helpers::fail('That comment is not on this card.', 404);
        }
        return $this->persist($b, $user);
    }

    /**
     * Delete a comment: its author may (whatever their access: a viewer can
     * comment, so can take it back), and so may the board's owner. An editor
     * cannot delete someone else's words.
     */
    public function deleteComment(array $user, string $boardId, string $cardId, string $commentId): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canView($user, $b)) {
            Helpers::fail('No access to this board.', 403);
        }
        $i = $this->cardIndex($b, $cardId);
        $comment = null;
        foreach ($b['cards'][$i]['comments'] ?? [] as $m) {
            if (($m['id'] ?? null) === $commentId) {
                $comment = $m;
            }
        }
        if ($comment === null) {
            Helpers::fail('That comment is not on this card.', 404);
        }
        if (($comment['userId'] ?? null) !== $user['id'] && !Helpers::canAdminBoard($user, $b)) {
            Helpers::fail('Only the comment\'s author or the board owner can delete it.', 403);
        }
        $b['cards'][$i]['comments'] = array_values(array_filter(
            $b['cards'][$i]['comments'] ?? [],
            fn($m) => ($m['id'] ?? null) !== $commentId
        ));
        return $this->persist($b, $user);
    }

    // ---------- attachments ----------

    /** @return array<string,mixed> board the user may edit (Master Gate). */
    public function editableBoard(array $user, string $boardId): array
    {
        $b = $this->getBoardOrFail($boardId);
        if (!Helpers::canEdit($user, $b)) {
            Helpers::fail('Read-only board.', 403);
        }
        return $b;
    }

    /** @param array<int,array<string,mixed>> $records from Uploads::saveFiles */
    public function addAttachments(array $user, string $boardId, string $cardId, array $records, bool $encrypted = false): array
    {
        $b = $this->editableBoard($user, $boardId);
        $i = $this->cardIndex($b, $cardId);
        if (count($b['cards'][$i]['attachments'] ?? []) + count($records) > self::MAX_ATTACHMENTS_PER_CARD) {
            Helpers::fail('This card already has the maximum number of attachments.');
        }
        foreach ($records as $r) {
            $stored = (string)($r['stored'] ?? '');
            if ($stored === '') {
                continue;
            }
            // Never take an attachment id that already exists: the encrypted
            // upload path supplies a server-issued id, and a plaintext upload
            // gets a fresh one here. A collision would mean a client tried to
            // claim an existing row, which would overwrite another card's.
            $attId = (string)($r['attachmentId'] ?? '');
            if ($attId === '') {
                $attId = Helpers::newId('f_');
            } elseif ($this->store->attachmentExists($attId)) {
                Helpers::fail('That attachment id is not available.');
            }
            // On an encrypted board the display name is ciphertext supplied in
            // encName (the real name is never sent); the owner-only upload check
            // still applies through editableBoard().
            $name = $encrypted
                ? (string)($r['encName'] ?? $r['name'] ?? 'encrypted file')
                : (string)($r['name'] ?? 'file');
            $b['cards'][$i]['attachments'][] = [
                'id' => $attId,
                'name' => $name,
                'stored' => $stored,
                'mime' => $encrypted ? 'application/octet-stream' : (string)($r['mime'] ?? 'application/octet-stream'),
                'size' => (int)($r['size'] ?? 0),
                'encrypted' => $encrypted,
                'url' => 'api/file.php?b=' . urlencode($boardId) . '&f=' . urlencode($stored),
                'userId' => $user['id'],
                'username' => $user['displayName'] ?? $user['username'],
                'uploadedAt' => Helpers::now(),
            ];
        }
        $this->logCard($b['cards'][$i], $user, 'added attachment(s)');
        return $this->persist($b, $user);
    }

    public function deleteAttachment(array $user, string $boardId, string $cardId, string $attachmentId): array
    {
        $b = $this->editableBoard($user, $boardId);
        $i = $this->cardIndex($b, $cardId);
        $gone = null;
        $kept = [];
        foreach ($b['cards'][$i]['attachments'] ?? [] as $a) {
            if (($a['id'] ?? null) === $attachmentId) {
                $gone = $a;
            } else {
                $kept[] = $a;
            }
        }
        $b['cards'][$i]['attachments'] = array_values($kept);
        if (($b['cards'][$i]['cover'] ?? null) === $attachmentId) {
            $b['cards'][$i]['cover'] = null; // it was the title image
        }
        $saved = $this->persist($b, $user);
        if ($gone) {
            Uploads::deleteStored((string)($gone['stored'] ?? ''));
        }
        return $saved;
    }

    // ---------- title image ----------

    /** Images a title image may be (shown inline by the browser). */
    private const COVER_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

    /**
     * Make one of the card's attachments its title image, or clear it with ''.
     * On an ordinary board it must be a PNG, JPEG, GIF or WebP; on an
     * end-to-end board the server cannot see the type, so the browser checks.
     */
    public function setCover(array $user, string $boardId, string $cardId, string $attachmentId): array
    {
        $b = $this->editableBoard($user, $boardId);
        $i = $this->cardIndex($b, $cardId);
        if ($attachmentId === '') {
            $b['cards'][$i]['cover'] = null;
        } else {
            $att = null;
            foreach ($b['cards'][$i]['attachments'] ?? [] as $a) {
                if (($a['id'] ?? null) === $attachmentId) {
                    $att = $a;
                }
            }
            if ($att === null) {
                Helpers::fail('That attachment is not on this card.', 404);
            }
            if (empty($att['encrypted']) && !in_array((string)($att['mime'] ?? ''), self::COVER_TYPES, true)) {
                Helpers::fail('A title image must be a PNG, JPEG, GIF or WebP image.');
            }
            $b['cards'][$i]['cover'] = $attachmentId;
        }
        $b['cards'][$i]['updatedAt'] = Helpers::now();
        return $this->persist($b, $user);
    }

    /** An imported timestamp (ISO 8601, as Trello writes them), or null when it is not one. */
    private static function importDate(mixed $value): ?string
    {
        $v = trim((string)$value);
        if (!preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/', $v)) {
            return null;
        }
        try {
            return (new DateTimeImmutable($v))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
        } catch (Exception) {
            return null;
        }
    }

    /** A board has at most this many labels (keys 1-9 and 0 toggle them on a card). */
    public const MAX_LABELS = 10;

    /** A label colour: #rrggbb, lower case, or null when it is not one. */
    public static function labelColor(mixed $color): ?string
    {
        $c = strtolower(trim((string)$color));
        return preg_match('/^#[0-9a-f]{6}$/', $c) ? $c : null;
    }

    /**
     * Replace the board's labels with $labels ([{id?, name, color}], in
     * order). An id the board already has keeps that label (so the cards
     * that carry it keep it); anything else is a new label with a fresh id —
     * a client never chooses an id. Labels left out are removed from every
     * card.
     */
    public function saveLabels(array $user, string $boardId, array $labels): array
    {
        $b = $this->editableBoard($user, $boardId);
        if (count($labels) > self::MAX_LABELS) {
            Helpers::fail('A board can have at most ' . self::MAX_LABELS . ' labels.');
        }
        $known = array_column($b['labels'] ?? [], null, 'id');
        $out = [];
        foreach (array_values($labels) as $l) {
            if (!is_array($l)) {
                Helpers::fail('Each label needs a name and a colour.');
            }
            $color = self::labelColor($l['color'] ?? '');
            if ($color === null) {
                Helpers::fail('A label colour must be #rrggbb.');
            }
            $id = (string)($l['id'] ?? '');
            $out[] = [
                'id' => isset($known[$id]) ? $id : Helpers::newId('lb_'),
                'name' => $this->content(trim((string)($l['name'] ?? '')), 30, $boardId),
                'color' => $color,
            ];
        }
        $b['labels'] = $out;
        $ids = array_column($out, 'id');
        foreach ($b['cards'] as &$c) {
            $c['labels'] = array_values(array_intersect($c['labels'] ?? [], $ids));
        }
        unset($c);
        return $this->persist($b, $user);
    }

    /** The ids of the people a board's cards can be assigned to (owner and members). */
    private static function peopleIds(array $b): array
    {
        $ids = array_map(fn($p) => (string)($p['id'] ?? ''), $b['people'] ?? []);
        if (!empty($b['ownerId'])) {
            $ids[] = (string)$b['ownerId'];
        }
        foreach ($b['members'] ?? [] as $m) {
            $ids[] = (string)($m['userId'] ?? '');
        }
        return array_values(array_unique(array_filter($ids)));
    }

    /** Who a card is assigned to: people of this board only, in the order given. */
    public function setCardAssignees(array $user, string $boardId, string $cardId, array $userIds): array
    {
        $b = $this->editableBoard($user, $boardId);
        $i = $this->cardIndex($b, $cardId);
        $people = self::peopleIds($b);
        $ids = [];
        foreach ($userIds as $id) {
            $id = (string)$id;
            if (in_array($id, $people, true) && !in_array($id, $ids, true)) {
                $ids[] = $id;
            }
        }
        $b['cards'][$i]['assignees'] = array_slice($ids, 0, 12);
        $b['cards'][$i]['updatedAt'] = Helpers::now();
        return $this->persist($b, $user);
    }

    /** Who a checklist item is assigned to: one person of the board, or nobody (''). */
    public function setItemAssignee(array $user, string $boardId, string $cardId, string $checklistId, string $itemId, string $userId): array
    {
        $b = $this->editableBoard($user, $boardId);
        if ($userId !== '' && !in_array($userId, self::peopleIds($b), true)) {
            Helpers::fail('That person is not on this board.');
        }
        $i = $this->cardIndex($b, $cardId);
        $found = false;
        foreach ($b['cards'][$i]['checklists'] as &$k) {
            if (($k['id'] ?? null) === $checklistId) {
                foreach ($k['items'] as &$t) {
                    if (($t['id'] ?? null) === $itemId) {
                        $t['assignee'] = $userId === '' ? null : $userId;
                        $found = true;
                    }
                }
                unset($t);
            }
        }
        unset($k);
        if (!$found) {
            Helpers::fail('That item is not on this card.', 404);
        }
        return $this->persist($b, $user);
    }

    /** Set a card's labels: ids of this board's labels, in the order given. */
    public function setCardLabels(array $user, string $boardId, string $cardId, array $labelIds): array
    {
        $b = $this->editableBoard($user, $boardId);
        $i = $this->cardIndex($b, $cardId);
        $board = array_column($b['labels'] ?? [], 'id');
        $ids = [];
        foreach ($labelIds as $id) {
            $id = (string)$id;
            if (in_array($id, $board, true) && !in_array($id, $ids, true)) {
                $ids[] = $id;
            }
        }
        $b['cards'][$i]['labels'] = $ids;
        $b['cards'][$i]['updatedAt'] = Helpers::now();
        return $this->persist($b, $user);
    }

    /**
     * For a card whose title is a web address and which has no title image:
     * fetch the page's title image (og:image and the like, see WebCover),
     * store it as an attachment and make it the title image.
     *
     * Not on an end-to-end board: the server would have to learn the title,
     * which that board keeps from it. Rate-limited per user.
     *
     * @return array{board:array<string,mixed>,found:bool}
     */
    public function fetchCover(array $user, string $boardId, string $cardId, bool $replace = false): array
    {
        $b = $this->editableBoard($user, $boardId);
        if ($this->encrypted($boardId)) {
            Helpers::fail('Title images are not fetched for end-to-end encrypted boards.', 400);
        }
        $i = $this->cardIndex($b, $cardId);
        $card = $b['cards'][$i];
        // The title when it is a web address, else a description that is
        // nothing but one (a page shared from a phone).
        $url = trim((string)($card['title'] ?? ''));
        if (!preg_match('#^https?://\S+$#i', $url)) {
            $url = trim(html_entity_decode(strip_tags((string)($card['description'] ?? '')), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        }
        if (!preg_match('#^https?://\S+$#i', $url)) {
            Helpers::fail('Neither the card title nor its description is a web address.');
        }
        if (!empty($card['cover']) && !$replace) {
            return ['board' => $b, 'found' => false]; // already has one; only a request by hand replaces it
        }
        $wait = $this->store->throttle('cover_fetch', (string)$user['id'], 30, 600);
        if ($wait > 0) {
            Helpers::fail('Too many title images fetched just now. Try again shortly.', 429);
        }
        try {
            $img = WebCover::fetch($url);
        } catch (RuntimeException $e) {
            Helpers::fail($e->getMessage(), 422);
        }
        if ($img === null) {
            return ['board' => $b, 'found' => false];
        }
        $saved = Uploads::saveBytes($img['bytes'], $boardId, $img['ext']);
        // Re-read: the fetch took a while and the board may have moved on.
        $b = $this->editableBoard($user, $boardId);
        $i = $this->cardIndex($b, $cardId);
        if (!empty($b['cards'][$i]['cover']) && !$replace) {
            Uploads::deleteStored($saved['stored']);
            return ['board' => $b, 'found' => false];
        }
        $attId = Helpers::newId('f_');
        $host = (string)(parse_url($url, PHP_URL_HOST) ?: 'page');
        $b['cards'][$i]['attachments'][] = [
            'id' => $attId,
            'name' => mb_substr('title image · ' . $host . '.' . $img['ext'], 0, 200),
            'stored' => $saved['stored'],
            'mime' => $img['mime'],
            'size' => $saved['size'],
            'url' => 'api/file.php?b=' . urlencode($boardId) . '&f=' . urlencode($saved['stored']),
            'userId' => $user['id'],
            'username' => $user['displayName'] ?? $user['username'],
            'uploadedAt' => Helpers::now(),
        ];
        $b['cards'][$i]['cover'] = $attId;
        $this->logCard($b['cards'][$i], $user, 'added the page\'s title image');
        return ['board' => $this->persist($b, $user), 'found' => true];
    }

    /**
     * For a checklist item that is a web address: read the page's title and
     * site icon (WebCover::linkInfo) and keep them on the item, so every
     * member sees the title as a link with the icon. Stored even when the
     * page names neither, so it is asked once. Not on an end-to-end board:
     * the server would have to learn the address. Shares the cover_fetch
     * budget.
     *
     * @return array{board:array<string,mixed>,found:bool}
     */
    public function fetchItemLink(array $user, string $boardId, string $cardId, string $checklistId, string $itemId): array
    {
        $b = $this->editableBoard($user, $boardId);
        if ($this->encrypted($boardId)) {
            Helpers::fail('Pages are not read for end-to-end encrypted boards.', 400);
        }
        $url = $this->itemText($b, $cardId, $checklistId, $itemId);
        // A bare address, or a titled one, "[Title](https://...)": the link
        // is kept under the item's whole text, the page read at its address.
        $page = preg_match('#^\[[^\]\n]+\]\((https?://\S+)\)$#i', $url, $m) ? $m[1] : $url;
        if (!preg_match('#^https?://\S+$#i', $page)) {
            Helpers::fail('That item is not a web address.');
        }
        if ($this->store->throttle('cover_fetch', (string)$user['id'], 30, 600) > 0) {
            Helpers::fail('Too many pages fetched just now. Try again shortly.', 429);
        }
        try {
            $info = WebCover::linkInfo($page);
        } catch (RuntimeException) {
            $info = ['title' => null, 'icon' => null]; // unreachable: remember that, show the address
        }
        // Re-read: the fetch took a while and the board may have moved on.
        $b = $this->editableBoard($user, $boardId);
        $i = $this->cardIndex($b, $cardId);
        $found = false;
        foreach ($b['cards'][$i]['checklists'] as &$k) {
            if (($k['id'] ?? null) !== $checklistId) {
                continue;
            }
            foreach ($k['items'] as &$t) {
                if (($t['id'] ?? null) === $itemId && trim((string)($t['text'] ?? '')) === $url) {
                    $t['link'] = ['url' => $url, 'title' => $info['title'], 'icon' => $info['icon']];
                    $found = true;
                }
            }
            unset($t);
        }
        unset($k);
        if (!$found) {
            return ['board' => $b, 'found' => false]; // changed or gone meanwhile
        }
        return ['board' => $this->persist($b, $user), 'found' => $info['title'] !== null || $info['icon'] !== null];
    }

    /** A checklist item's text, trimmed; 404 when the item is not there. */
    private function itemText(array $b, string $cardId, string $checklistId, string $itemId): string
    {
        $i = $this->cardIndex($b, $cardId);
        foreach ($b['cards'][$i]['checklists'] ?? [] as $k) {
            if (($k['id'] ?? null) === $checklistId) {
                foreach ($k['items'] ?? [] as $t) {
                    if (($t['id'] ?? null) === $itemId) {
                        return trim((string)($t['text'] ?? ''));
                    }
                }
            }
        }
        Helpers::fail('That item is not on this card.', 404);
        return '';
    }

    /**
     * 404 unless the list is one of this board's. A list id from the request
     * is never trusted: the foreign key would accept another board's list,
     * tying the card to it (and to its deletion).
     */
    private function requireList(array $b, string $listId): void
    {
        foreach ($b['lists'] ?? [] as $l) {
            if (($l['id'] ?? null) === $listId) {
                return;
            }
        }
        Helpers::fail('That list is not on this board.', 404);
    }

    // ---------- share inbox ----------

    /**
     * An inbox item belongs to the user who shared it. Anything else would
     * let one signed-in user pick up another user's incoming share.
     *
     * @return array<string,mixed>|null
     */
    public static function findInboxFor(StorageInterface $store, string $inboxId, array $user): ?array
    {
        return $store->findInboxFor($inboxId, (string)($user['id'] ?? ''));
    }

    /** Turn an inbox item into a card on the chosen board+list. */
    /**
     * Turn a server-held share into a new card in $listId, or, with $cardId,
     * add it to that existing card: its files become attachments and its text
     * and link a comment.
     */
    public function claimInbox(array $user, string $inboxId, string $boardId, string $listId, ?string $title, string $cardId = ''): array
    {
        $b = $this->editableBoard($user, $boardId);
        if ($cardId !== '') {
            return $this->claimInboxToCard($user, $b, $inboxId, $cardId);
        }
        $listOk = false;
        foreach ($b['lists'] as $l) {
            if (($l['id'] ?? null) === $listId) {
                $listOk = true;
                break;
            }
        }
        if (!$listOk) {
            Helpers::fail('List not found.', 404);
        }
        $item = self::findInboxFor($this->store, $inboxId, $user);
        if (!$item) {
            Helpers::fail('Share not found or expired.', 404);
        }
        $t = trim((string)($title ?? $item['title'] ?? ''));
        if ($t === '') {
            $t = 'Shared card';
        }
        $desc = trim((string)($item['text'] ?? ''));
        if (!empty($item['url']) && !str_contains($desc, (string)$item['url'])) {
            $desc = trim($desc . "\n" . (string)$item['url']);
        }
        // A shared page usually arrives as its title and its address. When
        // the title is what the text says besides the address, the
        // description is the address alone, so the card links to the page.
        $rest = (string)preg_replace('/^[\s\-–—:|·]+|[\s\-–—:|·]+$/u', '', str_replace($t, '', $desc));
        if ($rest !== $desc && preg_match('#^https?://\S+$#i', $rest)) {
            $desc = $rest;
        }
        $inList = array_filter($b['cards'], fn($c) => ($c['listId'] ?? null) === $listId);
        $card = [
            'id' => Helpers::newId('c_'),
            'boardId' => $boardId,
            'listId' => $listId,
            'title' => mb_substr($t, 0, 200),
            'description' => mb_substr(Helpers::sanitizeRichText($desc), 0, 20000),
            'dueDate' => null,
            'order' => Helpers::nextOrder($inList),
            'archived' => false,
            'archivedAt' => null,
            'checklists' => [],
            'comments' => [],
            'attachments' => [],
            'activity' => [[
                'id' => Helpers::newId('a_'),
                'userId' => $user['id'],
                'username' => $user['displayName'] ?? $user['username'],
                'text' => 'created this card from a share',
                'createdAt' => Helpers::now(),
            ]],
            'createdAt' => Helpers::now(),
            'updatedAt' => Helpers::now(),
        ];
        foreach ($item['files'] ?? [] as $f) {
            $newStored = Uploads::copyStored((string)($f['stored'] ?? ''), $boardId);
            if (!$newStored) {
                continue;
            }
            $card['attachments'][] = [
                'id' => Helpers::newId('f_'),
                'name' => (string)($f['name'] ?? 'file'),
                'stored' => $newStored,
                'mime' => (string)($f['mime'] ?? 'application/octet-stream'),
                'size' => (int)($f['size'] ?? 0),
                'url' => 'api/file.php?b=' . urlencode($boardId) . '&f=' . urlencode($newStored),
                'userId' => $user['id'],
                'username' => $user['displayName'] ?? $user['username'],
                'uploadedAt' => Helpers::now(),
            ];
        }
        $b['cards'][] = $card;
        // Order matters: write the card first, then consume the inbox item. If
        // the save fails (a 409 conflict, say), the share is still there to try
        // again. Doing it the other way round lost the share and orphaned the
        // copied files.
        $saved = $this->persist($b, $user);
        // claimInboxItem deletes with "WHERE id = ? AND user_id = ?" and reports
        // whether a row actually went. Two concurrent claims: only the one that
        // removed the row keeps its card, so the item is consumed exactly once.
        if (!$this->store->claimInboxItem($inboxId, (string)$user['id'])) {
            Helpers::fail('That share was already claimed.', 409);
        }
        Uploads::deleteDir('inbox_' . $inboxId);
        foreach ($saved['cards'] as $c) {
            if ($c['id'] === $card['id']) {
                return ['board' => $saved, 'card' => $c];
            }
        }
        return ['board' => $saved, 'card' => $card];
    }

    /** The existing-card half of claimInbox(). Same order: save, then consume. */
    private function claimInboxToCard(array $user, array $b, string $inboxId, string $cardId): array
    {
        $boardId = (string)$b['id'];
        $i = $this->cardIndex($b, $cardId);
        $item = self::findInboxFor($this->store, $inboxId, $user);
        if (!$item) {
            Helpers::fail('Share not found or expired.', 404);
        }
        $text = trim((string)($item['text'] ?? ''));
        if (!empty($item['url']) && !str_contains($text, (string)$item['url'])) {
            $text = trim($text . "\n" . (string)$item['url']);
        }
        $who = $user['displayName'] ?? $user['username'];
        if ($text !== '' && count($b['cards'][$i]['comments'] ?? []) < self::MAX_COMMENTS_PER_CARD) {
            $b['cards'][$i]['comments'][] = [
                'id' => Helpers::newId('m_'),
                'userId' => $user['id'],
                'username' => $who,
                'text' => $this->content($text, 2000, $boardId),
                'createdAt' => Helpers::now(),
            ];
        }
        $added = 0;
        foreach ($item['files'] ?? [] as $f) {
            $newStored = Uploads::copyStored((string)($f['stored'] ?? ''), $boardId);
            if (!$newStored) {
                continue;
            }
            $b['cards'][$i]['attachments'][] = [
                'id' => Helpers::newId('f_'),
                'name' => (string)($f['name'] ?? 'file'),
                'stored' => $newStored,
                'mime' => (string)($f['mime'] ?? 'application/octet-stream'),
                'size' => (int)($f['size'] ?? 0),
                'url' => 'api/file.php?b=' . urlencode($boardId) . '&f=' . urlencode($newStored),
                'userId' => $user['id'],
                'username' => $who,
                'uploadedAt' => Helpers::now(),
            ];
            $added++;
        }
        $b['cards'][$i]['updatedAt'] = Helpers::now();
        $this->logCard($b['cards'][$i], $user, $added ? 'added a shared file' : 'added a share');
        $saved = $this->persist($b, $user);
        if (!$this->store->claimInboxItem($inboxId, (string)$user['id'])) {
            Helpers::fail('That share was already claimed.', 409);
        }
        Uploads::deleteDir('inbox_' . $inboxId);
        foreach ($saved['cards'] as $c) {
            if ($c['id'] === $cardId) {
                return ['board' => $saved, 'card' => $c];
            }
        }
        return ['board' => $saved, 'card' => $b['cards'][$i]];
    }

    /**
     * Add a batch of lists and cards to an existing board in one write.
     *
     * The browser parses the export and matches lists by name; on an
     * end-to-end board it has already encrypted every text field, which
     * content() then stores verbatim. One persist instead of a request per
     * card: each request used to save and return the whole growing board, so
     * a 500-card import took minutes and never seemed to finish.
     *
     * $payload = [
     *   'lists' => [['ref' => 'n1', 'title' => '...'], ...],        // lists to create
     *   'cards' => [['list' => '<existing list id>' | 'new:n1', 'title', 'description',
     *                'dueDate' => 'YYYY-MM-DD'|null, 'completed' => bool,
     *                'checklists' => [['title', 'items' => [['text', 'done']]]],
     *                'comments' => ['...'],
     *                'labels' => ['<existing label id>' | 'new:x1', ...]], ...],
     *   'labels' => [['ref' => 'x1', 'name' => '...', 'color' => '#rrggbb'], ...], // labels to add
     * ]
     *
     * The browser matches labels the board already has (by name and colour,
     * which it can read even on an end-to-end board); new ones are added while
     * there is room for them (MAX_LABELS), and the rest are left off.
     *
     * @return array{board:array<string,mixed>,cards:int}
     */
    public function importIntoBoard(array $user, string $boardId, array $payload): array
    {
        $b = $this->editableBoard($user, $boardId);
        $lists = array_slice(is_array($payload['lists'] ?? null) ? $payload['lists'] : [], 0, 200);
        $cards = is_array($payload['cards'] ?? null) ? $payload['cards'] : [];
        if (count($cards) > 5000) {
            Helpers::fail('Too many cards in one import (max 5000).');
        }
        $who = $user['displayName'] ?? $user['username'];
        $now = Helpers::now();

        $known = array_flip(array_map(fn($l) => (string)$l['id'], $b['lists']));
        $refs = [];
        foreach ($lists as $l) {
            $ref = (string)($l['ref'] ?? '');
            if ($ref === '' || isset($refs[$ref])) {
                continue;
            }
            $id = Helpers::newId('l_');
            $b['lists'][] = ['id' => $id, 'title' => $this->content((string)($l['title'] ?? 'List'), 80, $boardId), 'order' => Helpers::nextOrder($b['lists'])];
            $refs[$ref] = $id;
            $known[$id] = true;
        }

        $b['labels'] = $b['labels'] ?? [];
        $knownLabels = array_flip(array_map(fn($l) => (string)$l['id'], $b['labels']));
        $labelRefs = [];
        foreach (is_array($payload['labels'] ?? null) ? $payload['labels'] : [] as $l) {
            $ref = is_array($l) ? (string)($l['ref'] ?? '') : '';
            $color = is_array($l) ? self::labelColor($l['color'] ?? '') : null;
            if ($ref === '' || isset($labelRefs[$ref]) || $color === null || count($b['labels']) >= self::MAX_LABELS) {
                continue;
            }
            $id = Helpers::newId('lb_');
            $b['labels'][] = ['id' => $id, 'name' => $this->content(trim((string)($l['name'] ?? '')), 30, $boardId), 'color' => $color];
            $labelRefs[$ref] = $id;
            $knownLabels[$id] = true;
        }

        // The next free position per list, counted once (not by scanning the
        // whole board for every card).
        $nextPos = [];
        foreach ($b['cards'] as $x) {
            $l = (string)($x['listId'] ?? '');
            $nextPos[$l] = max($nextPos[$l] ?? 0, (int)($x['order'] ?? 0) + 1);
        }
        $imported = 0;
        foreach ($cards as $c) {
            if (!is_array($c)) {
                continue;
            }
            $target = (string)($c['list'] ?? '');
            $listId = str_starts_with($target, 'new:') ? ($refs[substr($target, 4)] ?? null) : (isset($known[$target]) ? $target : null);
            if ($listId === null) {
                continue; // a card must land in a list of this board
            }
            $due = (string)($c['dueDate'] ?? '');
            $checklists = [];
            foreach (array_slice(is_array($c['checklists'] ?? null) ? $c['checklists'] : [], 0, 50) as $k) {
                $items = [];
                foreach (array_slice(is_array($k['items'] ?? null) ? $k['items'] : [], 0, 500) as $t) {
                    $items[] = ['id' => Helpers::newId('t_'), 'text' => $this->content((string)($t['text'] ?? ''), 300, $boardId), 'done' => !empty($t['done'])];
                }
                $checklists[] = ['id' => Helpers::newId('k_'), 'title' => $this->content(trim((string)($k['title'] ?? '')) ?: 'Checklist', 120, $boardId), 'items' => $items];
            }
            $comments = [];
            foreach (array_slice(is_array($c['comments'] ?? null) ? $c['comments'] : [], 0, self::MAX_COMMENTS_PER_CARD) as $m) {
                // A comment is its text, or {text, author, date} to keep who
                // wrote it in Trello and when (the importer and now otherwise).
                $text = is_array($m) ? (string)($m['text'] ?? '') : (is_string($m) ? $m : '');
                if (trim($text) === '') {
                    continue;
                }
                $author = is_array($m) ? trim(mb_substr((string)($m['author'] ?? ''), 0, 80)) : '';
                $date = is_array($m) ? self::importDate($m['date'] ?? null) : null;
                $shown = $author === '' || $author === $who ? $who : mb_substr($author, 0, 68) . ' (imported)';
                $comments[] = ['id' => Helpers::newId('m_'), 'userId' => $user['id'], 'username' => mb_substr($shown, 0, 80),
                    'text' => $this->content($text, 2000, $boardId), 'createdAt' => $date ?? $now];
            }
            $cardLabels = [];
            foreach (is_array($c['labels'] ?? null) ? $c['labels'] : [] as $ref) {
                $ref = (string)$ref;
                $id = str_starts_with($ref, 'new:') ? ($labelRefs[substr($ref, 4)] ?? null) : (isset($knownLabels[$ref]) ? $ref : null);
                if ($id !== null && !in_array($id, $cardLabels, true)) {
                    $cardLabels[] = $id;
                }
            }
            $order = $nextPos[$listId] ?? 0;
            $nextPos[$listId] = $order + 1;
            $b['cards'][] = [
                'id' => Helpers::newId('c_'),
                'boardId' => $boardId,
                'listId' => $listId,
                'labels' => $cardLabels,
                'title' => $this->content(trim((string)($c['title'] ?? '')) ?: 'Card', 200, $boardId),
                'description' => $this->content((string)($c['description'] ?? ''), 20000, $boardId, true),
                // A calendar day, never a timestamp (see AGENTS.md on due dates).
                'dueDate' => preg_match('/^\d{4}-\d{2}-\d{2}$/', $due) ? $due : null,
                'completed' => !empty($c['completed']),
                'order' => $order,
                'archived' => false,
                'archivedAt' => null,
                'checklists' => $checklists,
                'comments' => $comments,
                'attachments' => [],
                'activity' => [['id' => Helpers::newId('a_'), 'userId' => $user['id'], 'username' => $who,
                    'text' => 'imported this card', 'createdAt' => $now]],
                'createdAt' => $now,
                'updatedAt' => $now,
            ];
            $imported++;
        }
        return ['board' => $this->persist($b, $user), 'cards' => $imported];
    }

    // ---------- Trello import ----------

    /**
     * Trello's label colours (its current palette). An export names the
     * colour; this app stores #rrggbb. A label without a colour is grey.
     */
    public const TRELLO_COLORS = [
        'green' => '#4bce97', 'green_dark' => '#1f845a', 'green_light' => '#baf3db',
        'yellow' => '#f5cd47', 'yellow_dark' => '#946f00', 'yellow_light' => '#f8e6a0',
        'orange' => '#fea362', 'orange_dark' => '#c25100', 'orange_light' => '#fedec8',
        'red' => '#f87168', 'red_dark' => '#c9372c', 'red_light' => '#ffd5d2',
        'purple' => '#9f8fef', 'purple_dark' => '#6e5dc6', 'purple_light' => '#dfd8fd',
        'blue' => '#579dff', 'blue_dark' => '#0c66e4', 'blue_light' => '#cce0ff',
        'sky' => '#6cc3e0', 'sky_dark' => '#227d9b', 'sky_light' => '#c6edfb',
        'lime' => '#94c748', 'lime_dark' => '#5b7f24', 'lime_light' => '#d3f1a7',
        'pink' => '#e774bb', 'pink_dark' => '#ae4787', 'pink_light' => '#fdd0ec',
        'black' => '#8590a2', 'black_dark' => '#626f86', 'black_light' => '#dcdfe4',
    ];

    /**
     * A Trello export's labels as this app's: at most MAX_LABELS, the ones
     * cards use most when there are more, in Trello's order, with fresh ids.
     * An export written by this app carries the exact colour as rkColor.
     *
     * @return array{0: array<int,array{id:string,name:string,color:string}>, 1: array<string,string>}
     *         the labels, and Trello label id => new id
     */
    public static function trelloLabels(array $data): array
    {
        $raw = array_values(array_filter(is_array($data['labels'] ?? null) ? $data['labels'] : [], 'is_array'));
        // An older export has no labels list, only the board's colour names.
        if (!$raw && is_array($data['labelNames'] ?? null)) {
            foreach ($data['labelNames'] as $color => $name) {
                if (trim((string)$name) !== '') {
                    $raw[] = ['id' => 'name:' . $color, 'name' => (string)$name, 'color' => (string)$color];
                }
            }
        }
        $uses = [];
        foreach (is_array($data['cards'] ?? null) ? $data['cards'] : [] as $c) {
            if (empty($c['closed'])) {
                foreach (self::trelloCardLabelIds($c) as $id) {
                    $uses[$id] = ($uses[$id] ?? 0) + 1;
                }
            }
        }
        // Every named label comes along, used on a card or not (it may be on
        // archived cards only); an unnamed one only when a card uses it —
        // Trello gives every board six unnamed colours nobody asked for.
        $raw = array_values(array_filter($raw, fn($l) =>
            trim((string)($l['name'] ?? '')) !== '' || isset($uses[(string)($l['id'] ?? '')])));
        if (count($raw) > self::MAX_LABELS) {
            $order = array_keys($raw);
            usort($order, fn($a, $b) => [($uses[(string)($raw[$b]['id'] ?? '')] ?? 0), $a]
                <=> [($uses[(string)($raw[$a]['id'] ?? '')] ?? 0), $b]);
            $pick = array_slice($order, 0, self::MAX_LABELS);
            sort($pick);
            $raw = array_map(fn($i) => $raw[$i], $pick);
        }
        $labels = [];
        $map = [];
        foreach ($raw as $l) {
            $color = self::labelColor($l['rkColor'] ?? '')
                ?? self::TRELLO_COLORS[(string)($l['color'] ?? '')] ?? '#9ca3af';
            $id = Helpers::newId('lb_');
            $map[(string)($l['id'] ?? '')] = $id;
            $labels[] = ['id' => $id, 'name' => mb_substr(trim((string)($l['name'] ?? '')), 0, 30), 'color' => $color];
        }
        return [$labels, $map];
    }

    /**
     * The Trello label ids on a card: idLabels, plus the label objects an
     * export embeds in the card (for an export built from labelNames, the
     * colour stands in for the id).
     *
     * @return array<int,string>
     */
    public static function trelloCardLabelIds(array $c): array
    {
        $ids = array_map('strval', is_array($c['idLabels'] ?? null) ? $c['idLabels'] : []);
        foreach (is_array($c['labels'] ?? null) ? $c['labels'] : [] as $l) {
            if (is_array($l)) {
                $ids[] = isset($l['id']) ? (string)$l['id'] : 'name:' . (string)($l['color'] ?? '');
                if (isset($l['color'])) {
                    $ids[] = 'name:' . (string)$l['color'];
                }
            }
        }
        return array_values(array_unique($ids));
    }

    /** Build a board from Trello-format JSON (also accepts our own export). */
    public function importTrello(array $user, array $data, ?string $title, ?string $color): array
    {
        $boardTitle = trim((string)($title ?? $data['name'] ?? 'Imported board')) ?: 'Imported board';
        $color = Helpers::colorScheme($color);
        $rawLists = $data['lists'] ?? [];
        if (!is_array($rawLists)) {
            $rawLists = [];
        }
        if (count($rawLists) > self::MAX_LISTS) {
            Helpers::fail('That export has too many lists (max ' . self::MAX_LISTS . ').');
        }
        if (is_array($data['cards'] ?? null) && count($data['cards']) > self::MAX_CARDS_PER_BOARD) {
            Helpers::fail('That export has too many cards (max ' . self::MAX_CARDS_PER_BOARD . ').');
        }
        usort($rawLists, fn($a, $b) => ((float)($a['pos'] ?? 0)) <=> ((float)($b['pos'] ?? 0)));
        $listMap = [];
        $newLists = [];
        foreach ($rawLists as $l) {
            if (!empty($l['closed'])) {
                continue; // archived Trello lists stay behind
            }
            $nid = Helpers::newId('l_');
            $listMap[(string)($l['id'] ?? '')] = $nid;
            $newLists[] = ['id' => $nid, 'title' => mb_substr((string)($l['name'] ?? 'List'), 0, 80), 'order' => count($newLists)];
        }
        if (count($newLists) === 0) {
            $nid = Helpers::newId('l_');
            $newLists[] = ['id' => $nid, 'title' => 'To do', 'order' => 0];
        }
        $byList = [];
        foreach ($data['cards'] ?? [] as $c) {
            if (!empty($c['closed'])) {
                continue;
            }
            $lid = $listMap[(string)($c['idList'] ?? '')] ?? $newLists[0]['id'];
            $byList[$lid][] = $c;
        }
        foreach ($byList as &$grp) {
            usort($grp, fn($a, $b) => ((float)($a['pos'] ?? 0)) <=> ((float)($b['pos'] ?? 0)));
        }
        unset($grp);
        $klByCard = [];
        foreach ($data['checklists'] ?? [] as $k) {
            $klByCard[(string)($k['idCard'] ?? '')][] = $k;
        }
        [$labels, $labelMap] = self::trelloLabels($data);
        $commentsByCard = [];
        foreach ($data['actions'] ?? [] as $a) {
            if (($a['type'] ?? '') !== 'commentCard') {
                continue;
            }
            $cid = (string)($a['data']['card']['id'] ?? '');
            if ($cid === '') {
                continue;
            }
            $commentsByCard[$cid][] = [
                'id' => Helpers::newId('m_'),
                'userId' => $user['id'],
                // Who wrote it in Trello (the full name, as Trello shows it) and when.
                'username' => mb_substr(trim((string)($a['memberCreator']['fullName'] ?? '')) ?: (string)($a['memberCreator']['username'] ?? 'import'), 0, 80),
                'text' => mb_substr((string)($a['data']['text'] ?? ''), 0, 2000),
                'createdAt' => self::importDate($a['date'] ?? null) ?? Helpers::now(),
            ];
        }
        $cards = [];
        foreach ($byList as $lid => $grp) {
            foreach ($grp as $ord => $c) {
                $cid = (string)($c['id'] ?? Helpers::newId('c_'));
                $kls = [];
                foreach (array_slice($klByCard[$cid] ?? [], 0, self::MAX_CHECKLISTS_PER_CARD) as $k) {
                    $items = array_slice($k['checkItems'] ?? [], 0, self::MAX_ITEMS_PER_CHECKLIST);
                    usort($items, fn($a, $b) => ((float)($a['pos'] ?? 0)) <=> ((float)($b['pos'] ?? 0)));
                    $mapped = [];
                    foreach ($items as $t) {
                        $mapped[] = [
                            // Fresh ids: an imported document must never be able
                            // to claim an id that already exists in the database.
                            'id' => Helpers::newId('t_'),
                            'text' => mb_substr((string)($t['name'] ?? ''), 0, 300),
                            'done' => (($t['state'] ?? '') === 'complete'),
                        ];
                    }
                    $kls[] = ['id' => Helpers::newId('k_'), 'title' => mb_substr((string)($k['name'] ?? 'Checklist'), 0, 120), 'items' => $mapped];
                }
                $due = $c['due'] ?? null;
                $cards[] = [
                    'id' => Helpers::newId('c_'),
                    'boardId' => '',
                    'listId' => $lid,
                    'title' => mb_substr(trim((string)($c['name'] ?? 'Card')) ?: 'Card', 0, 200),
                    'description' => mb_substr(Helpers::sanitizeRichText((string)($c['desc'] ?? '')), 0, 20000),
                    'dueDate' => $due ? (string)$due : null,
                    'order' => $ord,
                    'archived' => false,
                    'archivedAt' => null,
                    'completed' => !empty($c['dueComplete']),
                    'labels' => array_values(array_unique(array_filter(array_map(
                        fn($id) => $labelMap[$id] ?? null,
                        self::trelloCardLabelIds($c)
                    )))),
                    'checklists' => $kls,
                    'comments' => array_slice($commentsByCard[$cid] ?? [], 0, self::MAX_COMMENTS_PER_CARD),
                    'attachments' => [],
                    'activity' => [[
                        'id' => Helpers::newId('a_'),
                        'userId' => $user['id'],
                        'username' => $user['displayName'] ?? $user['username'],
                        'text' => 'imported from Trello',
                        'createdAt' => Helpers::now(),
                    ]],
                    'createdAt' => Helpers::now(),
                    'updatedAt' => Helpers::now(),
                ];
            }
        }
        $board = [
            'id' => Helpers::newId('b_'),
            'title' => mb_substr($boardTitle, 0, 120),
            'colorScheme' => $color,
            'ownerId' => $user['id'],
            'members' => [],
            'lists' => $newLists,
            'labels' => $labels,
            'cards' => $cards,
            'createdAt' => Helpers::now(),
            'updatedAt' => Helpers::now(),
            'version' => 1,
        ];
        foreach ($board['cards'] as &$cc) {
            $cc['boardId'] = $board['id'];
        }
        unset($cc);
        $this->store->save('boards', $board);
        $this->store->bumpVersion();
        $board['myRole'] = 'admin';
        return $board;
    }
}
