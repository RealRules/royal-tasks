<?php
declare(strict_types=1);

/**
 * The one storage backend: MySQL/MariaDB (see MysqlStorage).
 *
 * Kept as an interface because the services are written against it and it
 * documents the operations they are allowed to ask for.
 */
interface StorageInterface
{
    /** @return array<int, mixed> */
    public function all(string $collection): array;
    public function find(string $collection, string $id): ?array;
    /** @param array<string,mixed> $record */
    public function save(string $collection, array $record): array;
    /**
     * Save only if the stored record is still at $expectedVersion, comparing
     * and writing atomically. Null skips the check.
     *
     * @param array<string,mixed> $record
     * @throws VersionConflict when the stored version has moved on
     */
    public function saveIfVersion(string $collection, array $record, ?int $expectedVersion): array;
    public function delete(string $collection, string $id): bool;
    public function getVersion(): int;
    public function bumpVersion(): int;

    /* ---------------------------------------------------------------------
     * Client-side encryption.
     *
     * The values here are opaque to the server: KDF parameters, the board key
     * wrapped under the password-derived key, and optionally the board key
     * wrapped under a recovery key. The server never derives or holds the
     * board key itself.
     * ------------------------------------------------------------------- */

    /** The wrapped-key row for a board, or null when the board is plaintext. */
    public function boardKey(string $boardId): ?array;

    /**
     * Create or replace a board's wrapped-key row.
     *
     * @param array<string,mixed> $data alg, salt, opslimit, memlimit,
     *                                   wrappedKey, recoveryWrappedKey
     */
    public function saveBoardKey(string $boardId, array $data): array;

    /** True when the board's content is encrypted in the client. */
    public function isBoardEncrypted(string $boardId): bool;

    /* ---------------------------------------------------------------------
     * Targeted lookups.
     *
     * These exist because the two operations on every request — signing in
     * and listing your boards — would otherwise load and filter whole
     * collections. That is fine for one team and fatal at a thousand users:
     * every poll would read every board of every account.
     * ------------------------------------------------------------------- */

    /** Exactly one user, matched case-insensitively. Null when absent. */
    public function findUserByUsername(string $username): ?array;

    /**
     * Boards this user may see: the ones they own, plus the ones shared with
     * them. Full board documents, same shape as find('boards').
     *
     * There is deliberately no "is admin, give me everything" flag: an admin
     * is not a member of boards they were not invited to, so membership is the
     * only thing that decides this.
     *
     * @return array<int,array<string,mixed>>
     */
    public function boardsVisibleTo(string $userId): array;

    /**
     * Do these two users share a board (as owner or member)? Answered by the
     * database; it decides who may see whose avatar.
     */
    public function usersShareBoard(string $userA, string $userB): bool;

    /** Number of records, without materialising them. */
    public function count(string $collection): int;

    /** True when an attachment row with this id exists, for any card. */
    public function attachmentExists(string $attachmentId): bool;

    /** True when some attachment row still references this stored file path. */
    public function storedFileInUse(string $stored): bool;

    /**
     * Which of a user's boards a deletion would affect, and how. Changes
     * nothing — the admin sees the consequences before confirming, and picks a
     * policy when a board has only view-only members left.
     *
     * @return array<int,array{boardId:string,title:string,editSuccessors:int,viewers:int}>
     */
    public function previewDetachUser(string $userId): array;

    /**
     * The ids of a user's pending share-inbox items, so their folders can be
     * removed when the account is deleted (the rows cascade; the files do not).
     *
     * @return array<int,string>
     */
    public function findInboxIdsFor(string $userId): array;

    /**
     * Handle a deleted user's boards, so nothing is stranded and the acting
     * admin does not silently inherit private boards.
     *
     * For each board the user owned, ownership passes to the longest-standing
     * member who can **edit** it. A board left with only viewers is resolved by
     * $viewerPolicy:
     *   - 'promote' gives it to the longest-standing viewer;
     *   - 'transfer' gives it to $actingAdminId (the original safe behaviour);
     *   - 'delete' removes it with its files.
     * A board with no members at all is always deleted. The user is removed
     * from every member list either way.
     *
     * Returns the ids of deleted boards so their attachment files can be
     * removed.
     *
     * @param 'promote'|'transfer'|'delete' $viewerPolicy
     * @param string $actingAdminId used only by the 'transfer' policy
     * @return array<int,string> board ids that were deleted
     */
    public function detachUser(string $userId, string $viewerPolicy = 'delete', string $actingAdminId = ''): array;

    /**
     * One inbox item by id, scoped to its owner. Never loads the collection:
     * a lookup must not be able to see (or be slowed by) other users' shares.
     *
     * @return array<string,mixed>|null
     */
    public function findInboxFor(string $inboxId, string $userId): ?array;

    /**
     * Add one share-inbox item and prune that user's older ones in the same
     * operation.
     *
     * Must not be a load-everything-then-rewrite: two users sharing at the same
     * moment would otherwise each write back a list the other's item is missing
     * from, losing one of them. Returns the pruned items so their files can be
     * removed.
     *
     * @param array<string,mixed> $item
     * @return array<int,array<string,mixed>> pruned items (with their files)
     */
    public function addInboxItem(array $item, int $keepPerUser, int $maxAgeSeconds): array;

    /**
     * Delete one inbox item, scoped to its owner. Returns true only when a row
     * was actually removed, so a second concurrent claim of the same item sees
     * false and cannot consume it twice. Another user's item is never touched.
     */
    public function claimInboxItem(string $inboxId, string $userId): bool;

    /**
     * Count one request against a fixed window and return the seconds the
     * caller must wait before trying again (0 to proceed).
     *
     * Lives here rather than in files so nothing under the web root has to be
     * written to, and so a shared host with several app instances shares one
     * limiter. $key is hashed before storage; callers pass a username or IP.
     */
    public function throttle(string $bucket, string $key, int $limit, int $windowSeconds): int;

    /**
     * "Stay signed in" tokens. Only a hash of the validator is stored. Before
     * the v6 schema these are no-ops (and findAuthToken returns null), so an
     * un-upgraded database simply keeps the old session-only sign-in.
     *
     * @return array{userId:string,validatorHash:string,pwStamp:string,expiresAt:int,lastUsedAt:int}|null
     */
    public function findAuthToken(string $selector): ?array;
    public function saveAuthToken(string $selector, string $userId, string $validatorHash, string $pwStamp, int $expiresAt): void;
    public function touchAuthToken(string $selector, int $expiresAt): void;
    public function deleteAuthToken(string $selector): void;

    /**
     * The calendar subscription (schema v13; before that there is none and
     * saving one throws). calendarFeed() is the owner's view, with the token;
     * calendarFeedByHash() is the feed's lookup.
     *
     * @return array{token:string,scope:string,boardIds:array<int,string>,createdAt:string}|null
     */
    public function calendarFeed(string $userId): ?array;
    /** @return array{userId:string,scope:string,boardIds:array<int,string>}|null */
    public function calendarFeedByHash(string $tokenHash): ?array;
    /** @param array<int,string> $boardIds empty for every board */
    public function saveCalendarFeed(string $userId, string $token, string $scope, array $boardIds): void;
    public function deleteCalendarFeed(string $userId): void;
    /**
     * A user's calendar names for cards on end-to-end boards.
     *
     * @param array<int,string> $cardIds
     * @return array<string,string> card id => name
     */
    public function calendarNames(string $userId, array $cardIds): array;
    /** Set ('' removes) one card's calendar name for one user. */
    public function setCalendarName(string $userId, string $cardId, string $name): void;
    /** True once the database has the calendar tables. */
    public function hasCalendar(): bool;

    /**
     * Accounts by email (schema v14): settings, one-time email links and the
     * lookup of a user by profile address. Before v14 there are none:
     * hasAccounts() is false, reads come back empty, writes throw.
     */
    public function hasAccounts(): bool;
    public function findUserByEmail(string $email): ?array;
    /** @return array<string,string> */
    public function settings(): array;
    public function saveSetting(string $name, string $value): void;
    public function saveEmailLink(string $tokenHash, string $kind, ?string $userId, string $email, string $name, string $role, ?string $createdBy, int $expiresAt): void;
    /** @return array{tokenHash:string,kind:string,userId:?string,email:string,name:string,role:string,createdAt:string,expiresAt:int,usedAt:?string}|null */
    public function findEmailLink(string $tokenHash): ?array;
    /** Spend a link: true once, for a link that is unused and not expired. */
    public function useEmailLink(string $tokenHash): bool;
    public function deleteEmailLink(string $tokenHash): void;
    /** Unused password links for a user go when one is used or another is sent. */
    public function deleteResetLinksFor(string $userId): void;
    /** @return array<int,array{tokenHash:string,email:string,name:string,role:string,createdAt:string,expiresAt:int}> unused, unexpired invitations */
    public function pendingInvites(): array;
    /** Fill users.email_hash for every user with an address (upgrade.php). */
    public function backfillEmailHashes(): int;

    /** Forget the window for one bucket+key (e.g. after a successful sign-in). */
    public function clearThrottle(string $bucket, string $key): void;

    /**
     * What this backend is, for diagnostics.
     *
     * @return array{driver:string,label:string,detail:string}
     *   driver is a stable key; label and detail are for humans.
     */
    public function describe(): array;
}
