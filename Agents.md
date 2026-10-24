# Royal Tasks

This is a modern, pleasant and responsive Kanban app, in the family of Trello, Asana, Jira and Microsoft Planner, that runs on normal web hosting (PHP and MySQL/MariaDB, no build step or background process on the server) and offers optional end-to-end encryption per board. It is easy to use, allows for checklists on cards, user management and board sharing, with an HTML/ES6 classes frontend and a PHP backend.

## Design
Clean Utility" aesthetic—functional, high-contrast, and professional. Lively UI with feedback and the sense that cards and lists are physical objects.

## Key Features
Real-time Collaboration: clients poll `?action=poll&since=v` every 10 seconds
(every 30 seconds while idle: the window out of focus, or no mouse or keyboard
input for 5 minutes; every 5 minutes while the page is not visible; input, or
the page coming back into view, polls at once and goes back to 10). The current
rate sits left of the list and card counts, invisible until clicked (the
choice is kept per device). When a request cannot reach the server, or the
browser goes offline, a red bar under the top bar says so (with "Try again")
and polls come every 5 seconds until it is back; then it turns green for a
moment and goes (`KanbanApp.setConnection`, `ApiClient.onNetwork`).
Any mutation bumps a change counter, so a card move, a checklist item or a
board rename appears on other members' screens within a few seconds.

Intuitive Drag & Drop, allowing seamless movement of cards between columns and reordering. While a card is dragged, a dashed marker of its own height shows where it will land, without any resizing or bounce; on drop the card settles into place (`.card-settle`: it comes down a few pixels with its shadow, never resized, so the list and the cards around it keep their size). A long list scrolls while a card is dragged near its top or bottom edge, the edges of the part one can see: with a phone's keyboard up, the list runs on under it (`DragDrop.startAutoScroll`). A card just added scrolls into view with the field below it, above a phone's keyboard, also when the keyboard opens or changes height (`KanbanApp.revealRange`).

The app should be installable as a PWA. It should accept images and other data. When accepting data, it should allow the user to decide which board and list the new card should be placed on. When a service worker can intercept the share, it stays on the device (as it is, in IndexedDB, deleted once the page reads it) until a board is chosen, and on an end-to-end board it is encrypted in the browser and its content never reaches the server; on an ordinary board it becomes a card the server can read, like any other. Otherwise it falls back to a short-lived server inbox (sealed at rest, but readable by the server before a board is chosen).

The app should allow import and export of Kanban boards, in Trello's JSON format.

End-to-end encryption: a board can be given a password, after which its content
(title, description, lists, checklists, comments, attachments) is encrypted in
the browser and the server stores only ciphertext. The board title stays
plaintext so the sidebar can list boards without unlocking each one.

## Detailed Card Management:
Checklists: Add, track, and complete sub-tasks within any card. A progress indicator provides quick visibility on task completion. When adding a checklist, it gets added immediately and can be renamed later When adding a checklist item, enter adds it, moving to the next item to enter.
Cards have a main description, comments, and optional finish date. A card on the board is compact: the tick, the title, the 🌐 of a card that links somewhere and the finish date share the first line; labels, badges (description, checklist, comments, attachments) and people share one line under it (`buildCardEl`), wrapping only when they must.
Cards can be archived and deleted with confirmations. Every board has an archive button showing previous archived cards, and the archive can be emptied in one go (`empty_archive`, after two confirmations). A list's ⋯ menu archives all its cards, and deleting a list asks twice.
Minimize repaint when added or moving cards: add and move update the DOM in place (optimistic), the server call confirms silently, and a failure rolls back. Checklist items the same: adding, moving and deleting one is an op (`CardModal.queueItemOp`) shown at once and applied over every newer copy of the board until the server has it (`applyItemOps`); the ops go to the server one at a time, in order, each with the item's id as it is by then (a new item's real id, a moved item's new one); a poll does not replace a board with ops on their way (`Store.heldBoards`); a failed op reloads the boards. A new item not yet saved is shown faint and cannot be ticked or edited. A new item scrolls into view with the field below it, measured against the visible part of the screen, so on a phone it stays above the keyboard, also when the keyboard opens or changes height (`CardModal.revealNewItem`). An item emptied and confirmed (Enter or its ✓) is deleted; one left empty by clicking elsewhere keeps its text. A dragged item is held like a card: a lifted copy (not tilted) follows the pointer from where it was grabbed (`.item-drag-layer`), its row stays in the list as a dashed gap where it would land, the cursor is a closed hand throughout, and on release the copy glides into the gap. The drag takes the row as it is on screen when it starts (found again by the item's id): a hold or the first pixels of a mouse drag take a moment, and a redraw in between (a save, a poll) left the pressed row off the page, which showed the copy in the top left corner one word per line and dropped a second row for the item into the list.
An open card keeps the keyboard focus: when the window comes back (or the dialog is redrawn) and the element that had it is gone, the card takes it (`CardModal.reclaimFocus`); a field that still has it keeps it.
A text box being edited in the card dialog (title, description, a comment, a checklist item or title, the calendar name) has a ✓ (`CardModal.attachDone`): it saves as leaving the box would, takes the focus away, and the box flashes green with a ✓ badge.
Descriptions: Rich descriptions to capture all necessary context for a task.
Activity History: A feed showing when tasks were created.
User Management: Administrator board creating users. For now there is no public signup, only user assignment by the administrator. Only the administrator can create or delete users.
Every user can have several boards.
Every board can have custom colors scheme from a predefined selection.
Board Sharing: Boards are restricted to members only. The app uses a Master Gate security rule pattern to ensure only authorized users can read or modify board content.
Users can invite other use to either view or edit a board.
Polished Interface: A clean design using Tailwind CSS, with CSS transitions for feedback. Responsive from phone to desktop. Always the light palette (it does not follow the system's dark mode), and it always animates, whatever the system's reduced-motion setting. Board colour schemes (`Helpers::COLOR_SCHEMES`): Solitaire (the default; its id is still `palmbeach`, its first name), indigo, cyan, amber, rose, grey, Dark and Synthwave. Dark and Synthwave darken only the board, its lists and cards; the header, menus and dialogs stay light. A retired scheme (forest, emerald, teal, slate, violet, sand) reads as the nearest kept one (`Helpers::colorScheme`).

## Technical implementation
The backend uses PHP (8.4+) with MySQL/MariaDB storage (`MysqlStorage`,
schema in `src/MysqlSchema.php`). There is no file storage: boards, users,
comments, the share inbox and the login rate limiter all live in the database.
The only application files written to disk are card attachments.

The app is a single directory: upload it where it should be served and run
`install.php` once. It creates the schema, the master account and `config.php`,
and writes the hardening files. Nothing is moved outside the folder.

`MysqlSchema::VERSION` gates column-level migrations; `upgrade.php` (CLI, or
in a browser as an administrator) applies them, as do `install.php --migrate`
and the installer's "Apply database updates" button. A database that is behind
on schema keeps working: encryption paths stay dormant until the `board_keys`
table exists, "Mark complete" is not stored before v6, and sign-in stays
session-only until the `auth_tokens` table exists; board content is stored
encrypted only from v7 on (the columns are too narrow before), a card's title
image (`cover_id`) is stored from v8, labels (the `labels` table and
`cards.label_ids`) from v9, the profile (`users.email`, `users.avatar`)
from v10, assignments (`cards.assignee_ids`, `checklist_items.assignee_id`)
from v11, when a comment was edited (`comments.edited_at`) from v12 (an
edit before v12 is saved but not marked), and the calendar subscription
(`calendar_feeds`, `calendar_names`) from v13, and accounts by email
(`settings`, `email_links`, `users.email_hash`) from v14, and a checklist
item's page title and icon (`checklist_items.link_meta`) from v15. Current version: 15.

`copyinstall.bat <folder>` copies the runtime files to an installation and
never touches its `config.php`, `uploads/` or hardening files.

The frontend is designed with Javascript ES6 classes. For now it is browser-based, but consider future Desktop and Mobile versions.

Styling is Tailwind CSS v4, compiled to a static file (`npm run build:css`)
rather than loaded from a CDN, so the page keeps a strict CSP and works
offline. Theme tokens and components live in `styles/app.css`.

## Encryption at rest
Every board is encrypted in the database by default (`src/AtRest.php`): board,
list and card titles, descriptions, checklists, comments, attachment names and
pending shares are stored as AES-256-GCM ciphertext (`rk1:` + base64 of
iv || tag || ciphertext) under the installation's master key, bound with AAD
`board:<id>` / `inbox:<userId>`. The server encrypts in `MysqlStorage` on
write and decrypts on read, so everything above the storage layer sees
plaintext. The key is `master_key` in `config.php` (or the
`ROYAL_KANBAN_MASTER_KEY` environment variable): install.php generates it, and
upgrade.php adds one to an older installation and re-encrypts what is stored
(`Upgrade::run`, `resealAll`). A value without the prefix is plaintext from
before the key and is read as it is.

Files in `uploads/` (attachments, board backgrounds, shared files) are sealed
too: `Uploads` encrypts each file as it is written (`RKF1` + iv || tag ||
ciphertext, AAD `file:<stored name>`), `copyStored` opens and re-seals under
the new name (never writing plaintext), and `api/file.php` decrypts as it
serves, with the plaintext's Content-Length. upgrade.php encrypts the files
already on disk (`Uploads::sealAll`). An end-to-end board's `.enc` files get
the same outer layer. Never serve a stored file with `readfile()`: go through
`Uploads::readStored()`.

- The key never goes into the database, the repo or a response. Losing it makes
  the boards unreadable: back up `config.php` with the database.
- A sealed value that will not open is an error, never passed on as ciphertext.
- `AtRest::seal()` always encrypts, even a value that already starts with
  `rk1:`: user text can (a comment "rk1:AAAA"), and storing it as it was made
  every read of its board fail. Code that re-seals stored data opens it first
  (`resealAll`). Likewise `sealBytes` always seals, and `Uploads::sealFile`
  skips an already sealed file only on the upgrade's pass over old files.
- This is under end-to-end encryption, not instead of it: on a board with its
  own password the browser sends ciphertext and the master key wraps it again.
  The server can read an ordinary board, never an end-to-end board.
- Do not add a query that filters or sorts on an encrypted column (titles,
  descriptions, text); the database only holds ciphertext there.

## Title images
A card may have a title image: `cover`, the id of one of its own image
attachments, shown across the top of the card and of the card dialog. It is
set from the card's ⋯ menu (choose a picture or upload one) and cleared there
or by deleting that attachment. A card links to a web address (the 🌐 on
the card and in the dialog) when its title is one, or when its description
is nothing but one, which is what sharing a page from a phone produces
(`KanbanApp.cardUrl`). When a card links somewhere and it has no title image, the app asks the server to fetch one (`fetch_cover`):
`src/WebCover.php` reads the page's og:image / twitter:image / image_src and
stores the image as an attachment (sealed at rest like any file). This happens
when such a card is created, when its title or description is changed to a
URL, and when it is opened; "Fetch card image from URL" in the menu does it on request and
replaces an existing one. Never on an end-to-end board: the server would have
to learn the title.

A shared page becomes a card titled after the page (`KanbanApp.shareParts`):
the title the sharing app sent, else the words that came with the link, else
the page's own title, read by the server (`page_title`, `WebCover::pageTitle`:
og:title, twitter:title, then <title>). That read happens only when the card
is made, and only for an ordinary board: never while the share dialog is open,
which would send the address to the server before the board is chosen (a
service-worker share must not reach the server at all, and an end-to-end
board's must not either). Without it, the title is the address. When the title
is what the text said besides the link, the description is the link alone, so
the card links to the page and fetches its picture.

A checklist item that is nothing but a web address shows as a link: the
site's icon and the page's title, the address as its tooltip
(`CardModal.decorateItemLink`). The server reads them once
(`fetch_item_link`, `WebCover::linkInfo`: the title as for a shared page,
the icon from the page's rel=icon / apple-touch-icon, else /favicon.ico;
PNG, JPEG, GIF, WebP or ICO by content, never SVG, at most 24 KB, scaled to
32 px when GD is there) and keeps them on the item as `link` {url, title,
icon as a data: URI}, sealed at rest; an empty result is kept too, so a page
is asked about once. The dialog asks, one item at a time, when someone who
can edit opens a card with such an item or adds or changes one; renaming an
item drops a link made for its old text. Never on an end-to-end board, where
the item shows the address with a globe. Clicking the link opens the page in
a new tab; clicking beside it edits the address.

A link that carries its own title when it is pasted or dropped into an
item's field (a link copied from a page's text, Edge's address bar, a link
dragged from a page: HTML holding one <a>, or Firefox's text/x-moz-url) goes
in as `[Title](url)` (Trello's form; `KanbanApp.linkFromTransfer`,
`titledLink`, `CardModal.takeTitledLinks`), and the item shows that title
(`KanbanApp.itemLink`, `itemLabel`, also in My tasks). It is read in the
browser, so it works on an end-to-end board, where the title is encrypted
like the rest of the item and nothing is fetched. Only when the link is the
whole item (the field empty or all selected); a sentence with a link in it,
two links, or a bare address are pasted as they are. On an ordinary board
the server still fetches the icon, and the item's own title wins over the
page's. The pasted HTML is parsed into an inert document and only its text
read; only http(s) addresses are taken.

## Labels
Every board has up to 10 labels (`BoardService::MAX_LABELS`), each a name
(optional) and a colour (`#rrggbb`). They are edited under Manage → Labels
(`save_labels` replaces the whole set; an id the board already has keeps its
label and its cards, anything else gets a fresh server-minted id; a label left
out is taken off every card). A card holds label ids (`set_card_labels`,
filtered to its board's labels). On the board a label is a strip of its
colour with the name as tooltip; in the card dialog it is a chip with the
name on the colour, removable with ✕, and the Labels menu toggles them. With a
card open, keys 1–9 and 0 toggle the board's first to tenth label (not while
typing in a field). Names are content: sealed at rest, and encrypted in the
browser on an end-to-end board (`RKE2E.sealLabels`, `sealImport`); colours
are not, like the colour scheme. Trello import maps Trello's colour names
(`TRELLO_COLORS`) and `idLabels` (or, in an older export, `labelNames` and the
labels inside each card). Every named label comes along, and an unnamed one
only when a card uses it; when there are more than 10, the most used win; importing into an existing board reuses a label with the same name and
colour. The export writes Trello's colour name plus the exact colour as
`rkColor`. Backups need nothing extra: the labels are tables like the rest.

## People and My tasks
A card can be assigned to people of its board (`set_card_assignees`), and a
checklist item to one (`set_item_assignee`): the owner and the members, which
the board document carries as `people` (id, name, whether there is a picture
and its version). The server takes only people of the board; someone who
leaves drops out of its assignments when it is read. The board shows a card's
people (its own and its items') as small pictures; the dialog has a People
row and an assign button on each item. "My tasks" sits on the left of the top
bar (its number is what is still to do) and lists, computed in the browser
from the boards it has, the signed-in user's cards and checklist items on
every board, with their picture: first those without a finish date, by name;
then those with one, soonest first (an item has its card's date). Done ones
come last in each part; archived cards are left out. A third part lists the
other finish dates on every board, not the user's (neither the card nor one
of its items), soonest first, without a picture. Every row names its board.
An end-to-end board that is not unlocked is counted apart, not read.

## Accounts by email
An administrator invites people by email (Users → Invite by email): the link
lets them make their own account (username, name, password; the address is
the invited one). "Forgot your password?" on the sign-in page emails a link
to sign in and choose a new password, found by username or email. An
administrator can email a user such a link (Users → ✉ Password link). The
administrator's settings (Preferences → Administration, `settings` table)
turn the last two on or off (both on by default) and hold the site address
the links point to. `src/Accounts.php` does the work.

Email (`src/Mailer.php`) goes out however the server can: with no mail
section, or `'transport' => 'auto'`, it takes SMTP when a host is set, else
PHP's mail() when the server has a mail program, else sendmail run directly,
else nothing; the sender defaults to noreply@ the site's domain. `'log'`
(or ROYAL_KANBAN_MAIL_LOG=/folder) writes each email to a file instead, for
testing.

## Preferences and the calendar subscription
Preferences (in the user menu at the top right) holds the calendar
subscription: an address a calendar app subscribes to, listing deadlines as
all-day events (`api/calendar.php`, `src/Calendar.php`, RFC 5545). The user
chooses their own deadlines (cards and checklist items assigned to them) or
all, and which boards (or all, including new ones). An event is a card with a
finish date, not archived or complete, titled after the card, with the board's
name (and, where readable, the list's) in the description. On an end-to-end
board the server cannot read the title: the event takes the card's "Calendar
name", which each user sets for themselves in the card dialog (shown when
the card has a date, with ⧉ to copy the title in, and saying it is not
encrypted), else "Deadline". The address is built in the browser from the
token; "New address" revokes the old one; "Turn off" deletes it.

## Attachment viewers
`assets/js/viewers.js` is a registry of renderers (`window.rkViewers`). The card
dialog asks it for a renderer by MIME type and file name and hands that
renderer a stage element and a source (`bytes()` and `url()`, decrypted when
the board is end-to-end); it knows nothing about file types itself. A new type
is one `rkViewers.register({ id, icon, match, render })`. Built in: image,
HEIC (native where the browser can, else libheif/wasm onto a canvas), video,
audio, PDF (PDF.js, pages drawn onto canvases as they scroll into view, eval
and scripting off), DOCX (mammoth, then rebuilt from an allowlist as DOM
nodes) and text. Libraries load on first use from `assets/vendor/` (copied by
`npm run build:vendor`, never a CDN), which is what keeps the CSP at 'self' +
'wasm-unsafe-eval'. A renderer must never put file content into markup as
HTML; converted HTML goes through the allowlist.

## End-to-end encryption
Optional per board, off by default. `assets/js/crypto.js` wraps the vendored
libsodium (`assets/vendor/sodium.js`, rebuilt with `npm run build:vendor`);
`assets/js/e2e.js` hooks `ApiClient.beforeSend`/`afterReceive` so no call site
handles encryption itself.

- A random board key encrypts content (XChaCha20-Poly1305). The key is wrapped
  under a key derived from the user's board password (Argon2id). The server
  stores only the KDF parameters and the wrapped key (`board_keys` table).
- A new board password (setup or change) is at least four different words of
  three or more letters, or 20+ characters with at least 8 different ones
  (a password manager's string) (`KanbanApp.boardPasswordProblem`). Whoever holds the
  database can guess offline; Argon2id stays at libsodium's "interactive"
  level (about 70 ms on a desktop, 64 MiB), because "moderate" needs 256 MiB
  per unlock and fails on low-memory phones. The word count is what makes
  the difference. An existing board still unlocks with the password it has.
- A **recovery key**, shown once at setup, is a second wrap of the same board
  key held owner-only.
- Values are `base64(nonce || ciphertext)`, bound with AAD: `board:<id>` for
  content, `key:<id>` for the key, `file:<boardId>:<attachmentId>` for
  attachments, so a value cannot be moved to another board or row.
- Encrypting a board that already has content seals all of it: after the
  password is set (and the recovery key shown), the owner's browser encrypts
  every list and label name, card title and description, checklist, item and
  comment and sends them in one write (`seal_board_content`, owner only, only
  on an encrypted board), uploads each readable attachment again encrypted
  (moving the title image to it) and deletes the readable one, and removes a
  background picture (`RKE2E.sealExisting`). The browser counts what still
  does not decrypt on an encrypted board (`plainCount`, from an interrupted
  run or a board encrypted by an older version) and the encryption dialog
  offers to finish it. An end-to-end board has no background picture (refused
  by the server, disabled in the menu): it would not be encrypted.
- The browser pins the encrypted state: a board it holds a key for is
  encrypted whatever the server's flag says (`RKE2E.isEncrypted`), so a
  server or database that stops saying so cannot make it send text readable.
- "Remember this device" wraps the board key under a device key in IndexedDB;
  a returning visitor is unlocked without re-entering the password. The key
  is kept per user (`board:<userId>:<boardId>`, `RKE2E.deviceSlot`) and
  signing out forgets that user's keys (`forgetDevice`), so the next person
  on the same browser does not find those boards unlocked.
- Attachments are encrypted client-side and stored as `.enc`; `api/file.php`
  serves them as `application/octet-stream`.
- A locked board is fail-closed: mutations throw rather than send plaintext,
  and the board is not rendered. Export is refused while locked.
- The server cannot read encrypted content, so on an encrypted board it must
  not sanitize or truncate those fields — `BoardService::content()` stores them
  verbatim (the client enforces the real limits and sanitizes).

## Security invariants
These hold today and must not regress:

- The app is one directory. `src/` and `config.php` sit in the web root but are
  PHP, so the server executes them rather than sending them; a deny `.htaccess`
  is written as a second layer, and install.php prints the nginx rules for
  servers that ignore it. `uploads/` is static and the only thing that is not
  PHP: it is served only through `api/file.php` (board access check), stored
  under random names, never listed, and carries a deny `.htaccess`.
- `install.php` is the only way the master account and the database connection
  are created. The generated password is shown once and nothing sensitive is
  written to disk. Requests answer `installed:false` / 503 until it has run.
- State-changing API actions are POST + `X-CSRF-Token`; read-only actions are
  GET. `Security::enforce()` decides, from the lists at the top of that class —
  a new mutating action is protected by default.
- User HTML is rebuilt from an allowlist server-side (`HtmlSanitizer`). On the
  client, rendered text goes through DOM nodes: never interpolate user text
  into an HTML string, especially not into an attribute.
- Uploads use an extension allowlist and are stored under generated names.
  Only images and PDFs may be served inline. A board background is PNG, JPEG,
  GIF or WebP, checked by name and by content (`BoardService::BACKGROUND_TYPES`,
  `Uploads::isRasterImage`), and `api/file.php` serves it with a sandbox CSP;
  any other stored type goes as a download. An SVG on our origin is a page
  that runs script: never serve one inline. Encrypted attachments are the one
  exception: they arrive as `application/octet-stream` and are stored as `.enc`
  because there is nothing to sniff; only an existing encrypted board may take
  that path (`isBoardEncrypted` is the gate).
- The client-side CSP allows `'wasm-unsafe-eval'` and nothing more. libsodium is
  a WebAssembly module, so compiling it needs that source; it does **not**
  permit `eval`, so the XSS protection is unchanged. Do not widen `script-src`
  further.
- Passwords are bcrypt, min 12 chars; the master password generated by
  install.php is random and must be changed at first sign-in.
- Board mutations go through `BoardService::persist()`, which refuses the write
  if the stored version has moved on from the one this request loaded, and
  also when the version the client claims is not that one (a client cannot
  name a future version and slip a stale document past a concurrent change).
  A list id from a request must be one of the board's (`requireList`). The client stamps the version it last saw
  and `ApiClient` learns versions from responses, so call sites cannot forget.
  The check is inside the database transaction that performs the write.
  The client never goes back a version: `Store.setBoards` keeps a board it
  already holds in a newer version, because a poll sent just before one of
  our own changes can arrive after it and would otherwise undo it on screen.
- Storage is chosen by `rk_storage()` in `src/bootstrap.php`; entry points must
  call it rather than building a backend directly, or the configuration is
  silently ignored. It throws when the app is not installed.
- A site admin has **no special access to boards**. Administering users is the
  admin's job; board content belongs to its members. Account management is
  the only privileged area, and an admin still needs a board password to read
  an encrypted board like anyone else. Do not let `boardRole()` or
  `boardsVisibleTo()` grant a board to a non-member: `visibleBoards()` and
  `boardsVisibleTo()` take no "admin sees all" flag on purpose. `detachUser()`
  runs **before** the account row is deleted (the foreign keys would otherwise
  cascade memberships away and null ownership first). A deleted owner's board
  passes to its longest-standing **editor**; a board left with only viewers is
  resolved by the admin's chosen policy — `previewDetachUser()` shows the
  consequences first, and the policy must be an exact `promote` / `transfer` /
  `delete`. An unstated policy is refused (400) when viewer-only boards exist,
  so no caller can silently delete them. 'promote' promotes the longest-standing
  viewer (and upgrades them to edit); 'transfer' hands the board to the acting
  admin; the default deletes. A viewer must never silently inherit owner powers
  (sharing, deletion, replacing the encryption key, the recovery copy).
- Changing the profile email takes the current password (it is where
  password links go, so a stolen session must not be able to move it), and an
  address belongs to one account only. Sign-in is limited per account and
  address (8 in 15 minutes) and per account from anywhere (40), so a stranger
  cannot lock the owner out with a few tries. "Forgot your password?" sends its
  email after the answer has gone (fastcgi_finish_request), so the time it
  takes does not tell whether the account exists. Imported comments keep their
  author's name marked "(imported)".
- The service worker takes a share only as a top-level navigation (not from
  a frame another site posts into), at most 64 MB, and keeps at most a few
  pending shares for an hour.
- The client must not replay a pending action after the session identity
  changes. A response for another account than the page's is not adopted:
  `ApiClient.send()` checks the user before taking a token, then refuses
  every further write until the page reloads. `ApiClient.ensureCsrfToken()` compares the user id from `me` with the
  one it started with and throws `sessionChanged` instead of adopting the new
  token; `onSessionChanged` reloads the page. Without it, a token rotated by
  another tab signing in would run the first user's move/delete/share as the
  second user.
- Claiming a share persists the card first and consumes the inbox item second,
  and treats a delete that changed no rows as "already claimed". The other
  order lost the share if the board save failed (a 409 conflict), and let two
  concurrent claims both succeed.
- Never answer "this user's boards" or "the user with this name" by loading a
  whole collection and filtering in PHP. `StorageInterface` has
  `boardsVisibleTo()`, `findUserByUsername()`, `count()` and `detachUser()`
  precisely so a database can answer them with an index.
- The card that follows the cursor while dragging is our own element
  (`.drag-layer`), not the browser's drag image. Chromium paints that image at
  a fixed alpha that no CSS and no `setDragImage` argument can change, so the
  native one is suppressed with a 1x1 transparent GIF. Do not try to style the
  browser's drag image; it cannot be done.
- A due date is a calendar day. Never parse it with `strtotime()` and reformat
  with `gmdate()`: that applies the server timezone and walks the date back a
  day on every save.
- Timestamps keep milliseconds: `Helpers::now()` is ISO 8601 with `.v`, as
  the `DATETIME(3)` columns store it. With whole seconds, two comments (or
  activity entries) written in the same second tied and came back in either
  order.
- All text length limits are in characters. `Helpers`' `mb_substr` fallback
  (used when ext-mbstring is absent) splits on character boundaries; a
  byte-based cut produces invalid UTF-8, which is what triggered the above.
- `ApiClient.upload()` must run the same `afterReceive` hook as `call()`. It
  returns a whole board document, and skipping the hook left encrypted fields
  as ciphertext in the client store.
- A retried request (the CSRF retry in `ApiClient.send()`) starts from the
  caller's parameters, never from what `beforeSend` returned: retrying the
  encrypted ones sealed the text twice, and every client showed ciphertext.
  A phone back after a while hits that retry routinely (its parallel first
  requests each rebuild a session from the remember cookie). `tryText` peels
  up to three layers, so text already stored that way reads correctly.
- Child rows are owned by their parent, and ids are global. Every upsert into
  `lists`, `cards`, `checklists`, `checklist_items`, `comments`, `activity` and
  `attachments` is guarded by the parent id
  (`IF(parent_col = VALUES(parent_col), ...)`), so a document can never take
  over a row another board/card owns. `lists` in particular must never update
  `board_id`, or an id collision would move a list to another board. `cards`
  also gets a hard `idsOwnedBy()` precondition at the top of `syncCards`: the
  guard alone would spare the foreign card row but still run its child syncs,
  whose `deleteMissing()` would wipe the real card's checklists, comments,
  attachments and activity. The Trello import mints fresh checklist and item
  ids for the same reason, and an encrypted upload only accepts an attachment id
  the server issued to that user for that board (kept in the session). IDs are
  server-minted today, so this is a guard against a future path that accepts a
  client id — do not remove it.
- Deleting a card or list removes its attachment files; the rows go first, so
  the file stops being reachable immediately, then the bytes are unlinked when
  no other row still references them. `api/file.php` serves a file only while a
  live attachment row points at it — a removed attachment's URL 404s.
- `api/share-target.php` is POST only. A GET fallback would let any site plant
  inbox items for a signed-in user, because the SameSite=Lax session cookie is
  sent on a top-level cross-site GET.
- The share inbox is inserted and pruned in one indexed operation
  (`addInboxItem`); it must never be a load-everything-then-rewrite, which two
  concurrent sharers would use to drop each other's items. Claiming uses
  `findInboxFor`/`claimInboxItem`, both scoped to `user_id`, so one user cannot
  read or delete another's share. `StorageInterface` no longer has
  `replaceAll`, on purpose: do not reintroduce a whole-collection rewrite.
- Socket-level settings follow the deployment, not the caller. `isHttps()` and
  `clientIp()` read X-Forwarded-Proto/-For **only** when `RK_TRUST_PROXY` is
  set (config `trust_proxy` / env `ROYAL_KANBAN_TRUST_PROXY`); otherwise a
  forged header would control the cookie's Secure flag and the login limiter.
  `clientIp()` takes the **rightmost** X-Forwarded-For entry (the address the
  nearest proxy observed), not the leftmost — proxies append, so the first
  entry is client-supplied and would let a spammer rotate fake IPs past the
  per-IP limit. `RK_TRUSTED_PROXIES` counts the trusted hops.
- `upgrade.php` carries the same rule: from the web it applies nothing unless
  the request is from a signed-in administrator **and** passes the same-origin
  + CSRF check. To anyone else it answers one fixed 403 page that reveals
  nothing: not the schema version, not whether the app is installed or the
  database answers.
- `WebCover` fetches URLs users type, so it is the SSRF surface: http(s) only,
  ports 80/443/1024+, every resolved address must be public unicast (no
  private, loopback, link-local/metadata, CGNAT, reserved, multicast, ULA or
  IPv4-mapped forms), the connection is pinned to the checked address
  (`CURLOPT_RESOLVE`), redirects are followed by hand and re-checked (max 4),
  size and time are capped, and the result must decode as PNG/JPEG/GIF/WebP.
  TLS verification stays on. The `$allowPrivate` flag is for the test suite
  only; no request path may set it. `page_title` (a page's title, for a
  shared link) and `fetch_item_link` (a checklist item's page title and
  icon) go through the same `get()`, are POST with the CSRF check like
  every action that makes the server fetch something, and share the
  `cover_fetch` throttle. An icon is stored only as a data: URI the server
  builds from bytes that decode as a raster image; the client shows only a
  `data:image/(png|jpeg|gif|webp|x-icon);base64,` value (`CardModal.ICON_RE`).
- Imports go in one request (`import_into_board`), saved by one persist. A
  request per card made the server save and return the whole growing board
  each time; a 500-card import never finished. On an end-to-end board
  `RKE2E.sealImport` encrypts every field of the nested payload first.
- `backups3.php` answers a web request with a bare 404 and does nothing,
  unless `web_key` (32+ characters) is set in its `configs3.php` and the
  request carries it (`?key=` or `X-Backup-Key`, compared with
  `hash_equals`); then it runs a plain `backup` only (no restore, list or
  delete, no options from the request). Nothing is printed before that check
  and PHP's error display is off. Its settings live in `configs3.php` next
  to it (git-ignored; `configs3.example.php` documents them). It is meant to live
  outside the web root and loads the app through `app_root/src/bootstrap.php`,
  so it follows the same configuration. The first dump of every calendar
  month is kept for good (`keep_monthly`, on by default), beside the last
  `keep_days`; it is the first, never the latest, so a later run in the
  same month cannot replace it. It uploads the dump and the files as
  they are stored (board content and files stay ciphertext) and never
  `config.php`: the master key must not sit in the same bucket as the data.
  The S3 requests are signed by the script itself (SigV4, checked against
  AWS's published examples); TLS verification stays on. `restore` and
  `delete` ask for confirmation (`--yes` for scripts, and a run without a
  terminal refuses rather than assumes); `restore` saves the current database
  first, refuses a dump made under another table prefix, never writes a file
  whose name from the bucket would leave `uploads/`, and afterwards moves the
  change counter and every board version past what open browsers saw, so they
  reload the restored boards instead of having their next write refused.
- Staying signed in rests on `auth_tokens`, not on the PHP session (session
  files are collected after ~24 minutes idle, on Debian by a cron job that
  ignores the app's settings). The `rk_remember` cookie is
  `selector.validator`; only SHA-256 of the validator is stored, compared with
  `hash_equals`. A token is tied to the password stamp it was issued under, so
  a password change (own or by the admin) retires every remembered device except
  the one that made the change; logout deletes the device's token; a mismatch
  deletes the token. Deleting a user cascades their tokens. The cookie is
  HttpOnly, SameSite=Lax, Secure on HTTPS, scoped by `Security::cookiePath()`,
  and renewed for 400 days (the browser maximum) on use.
- Once installed, `install.php` does nothing for an anonymous visitor: migrate
  and self-delete require a signed-in administrator, **and** carry the same
  same-origin + CSRF check as the API (an admin on another site must not be able
  to make the installer run). Database errors are logged rather than printed. Do
  not relax that back to "trust people to delete the file".
- `Security::cookiePath()` scopes the session cookie to the app folder, not the
  host. `install.php` and `api/index.php` sit at different depths, so the path
  is the entry point's directory with a trailing `api` segment stripped — never
  two bare dirnames, which once scoped the cookie to `/` in a subfolder install
  and shared it with every other app on the host.

- A user's avatar is served only by `api/avatar.php`, to that user or to
  someone who shares a board with them (`usersShareBoard()`); anyone else,
  and a user without one, gets the same 404. The stored file name never
  leaves the server (`sanitizeUser` sends `hasAvatar` and a version). The
  picture is cropped to 256 px in the browser, and the server accepts only
  PNG, JPEG, WebP or GIF by content (never SVG). A profile email is sealed at
  rest (AAD `user:<id>`).
- Email goes out through `Mailer` only, set up in config.php's `mail`
  section ('auto' by default: SMTP, mail() or sendmail, whichever the server
  has). SMTP verifies certificates; headers are built
  from single-line values, so no text can add a header. Errors never contain
  the password.
- The calendar feed (`api/calendar.php?t=`) has no session: the token in the
  address is the only key. It is 32 random bytes, looked up by SHA-256
  (`token_hash`, unique) and kept sealed at rest (AAD `calendar:<user>`) so the
  preferences can show it again; anything else, a malformed token included,
  gets the same bare 404, and only GET/HEAD are answered. The feed is built
  per fetch from `boardsVisibleTo()`, so it lists only boards the user is a
  member of now, filtered to the chosen ones (the saved choice is cut to
  boards the user is on). It never carries an end-to-end card's title, only
  that user's calendar name (per user, sealed at rest with AAD
  `calname:<user>`, plain to the server by design) or "Deadline", and no list
  names from such a board. Fetches are throttled per token. Deleting the user
  or the card cascades the rows. `set_calendar_name` needs view access to the
  board and the card on it, and moves no board version.
- Email links (invitations, new passwords) carry a 32-byte random token in
  the address's fragment (`#invite=`, `#reset=`), which the browser never
  sends to a server or in a Referer; the page takes it out of the address bar
  and posts it. The server keeps only its SHA-256, the address sealed (AAD
  `link:<hash>`), an expiry (an invitation 7 days, a forgotten password 1
  hour, an administrator's link 24 hours) and a used mark set by one guarded
  UPDATE (`useEmailLink`), so a link works once even when two requests race.
  Spent or expired links are deleted. A new password link replaces any
  earlier one for the account. The link's site address comes from the saved
  setting (from an administrator's browser), never from the request: a forged
  Host must not be able to send someone a link to another site.
  "Forgot your password?" answers the same whatever is asked, so it reveals
  nothing about which names or addresses exist; it is throttled per address
  (10 in 15 minutes) and per account (3 links an hour). An account is found by
  email through `users.email_hash`, an HMAC of the address under the master
  key: an indexed lookup without the address being readable, and a copy of
  the database alone cannot test guesses. Setting a new password changes the
  password stamp, so every other session and remembered device is signed out;
  the link signs in (`AuthService::signIn`, a new session id and CSRF token).
  These actions need a session's CSRF token like every POST, which a visitor
  who is not signed in has from `me`.
- The server does not report its database (name, server or version) to the
  browser: `me` and `login` carry no `storage`, and a `PDOException` (which
  names tables and constraints) is logged, never returned, although it is a
  RuntimeException. The console line names the
  app, its build and the copyright only.
- A comment is deleted only by its author (a viewer can comment, so can take
  it back) or by the board's owner (`deleteComment`); an editor cannot delete
  someone else's comment. The dialog shows ✕ only where the server allows it.
  A comment is edited only by its author (`editComment`, `edit_comment`),
  never by the owner: removing someone's words is allowed, rewriting them is
  not. An edited comment says so ("edited", with the time).

Ensure that no data is available to users other than the owner.

## Testing
[] Create users.
[] Create Board
[] Edit cards
[] Edit todo list
[] Move Cards
[] Delete cards
[] Share boards with another user

Encryption paths are covered by headless Chrome (puppeteer-core against the
installed browser): setup/unlock, wrong-password and recovery-key handling,
fail-closed on a locked board, encrypted attachments round-tripping through
`api/file.php`, and the service-worker share. Run the dev server with
`php -S 127.0.0.1:8080 -t . router.php` first.








