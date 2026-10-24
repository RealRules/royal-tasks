# Developing Royal Tasks

The frontend is plain ES6 classes with no framework and no bundler; the
backend is PHP 8.4 with MySQL or MariaDB. [Agents.md](../Agents.md) is the
design reference: the features, how each one works, and the rules the code
must keep.

## Getting started

```bash
npm install                                # Tailwind, the vendored libraries, test tooling
php -S 127.0.0.1:8080 -t . router.php      # or .\start.bat
```

Open `http://127.0.0.1:8080/install.php` once to create a local database and
the master account.

## Where things live

```
.                        <- the app folder; also the web root
  index.html               the shell: sign-in, board, sidebar, dialogs
  sw.js                    service worker: offline shell, share target
  manifest.json            PWA manifest
  router.php               dev-server router: security headers + deny rules
  install.php              one-time setup; delete when done
  upgrade.php              database migrations
  backups3.php             S3 backup and restore (meant to live outside the web root)
  config.php               written by install.php (git-ignored)
  api/
    index.php                the action router
    file.php                 serves attachments, behind the board access check
    avatar.php               serves profile pictures to people who share a board
    calendar.php             the calendar subscription feed (iCalendar)
    share-target.php         PWA Web Share Target fallback
  assets/
    css/app.css            built by Tailwind: edit styles/app.css, not this
    js/                    ES6 classes: ApiClient, Store, DragDrop, CardModal,
                           KanbanApp, RKE2E (encryption), viewers, plus boot.js
    vendor/                third-party libraries, copied by npm run build:vendor
    icons/
  src/                     PHP classes (executed by the server, never served)
  uploads/                 card attachments (encrypted) + deny file
  styles/app.css           Tailwind source: theme tokens + components
  scripts/                 build helpers (build stamp, vendoring)
  deploy/                  example Apache / php-fpm / nginx configuration
  tests/                   API and browser test suites
  docs/                    this documentation
```

`src/` and `config.php` are inside the web root, but they are PHP, which the
server executes rather than sends. `uploads/` is static, so it gets a deny
`.htaccess`, a blank `index.html` and random file names, and the app only ever
links to `api/file.php`, never to a path under `uploads/`.

## Database

The app stores everything in MySQL or MariaDB. `src/MysqlSchema.php` documents
the normalised tables, sized for about 1000 users: sign-in is one indexed row,
a user's boards come from `board_members`, a board's cards from
`cards (board_id, archived)`, and deleting a board cascades in one statement.

Card and list order is a `DECIMAL` position, so moving a card writes one row
instead of renumbering a list. Timestamps are `DATETIME(3)`, so imported
precision survives. `description` is `MEDIUMTEXT`, because 20 000 characters
of UTF-8 can exceed `TEXT`'s byte limit, where MySQL truncates silently.

A schema change bumps `MysqlSchema::VERSION`, adds its column in
`ensureColumns()`, and is applied by `upgrade.php`. Code that uses a new
column checks the schema version first, so an installation that has not been
upgraded keeps working.

## Styling

Tailwind v4 is compiled to a static stylesheet: no CDN script, so the page
needs no `unsafe-eval`, works offline, and cannot be changed by a third party.

```bash
npm run build      # build stamp + stylesheet: use this for a release
npm run build:css  # stylesheet only
npm run watch:css  # rebuild on save while working
```

The theme lives in `styles/app.css`: design tokens on `:root`, one block per
board colour scheme (Solitaire, indigo, cyan, amber, rose, grey, Dark and
Synthwave; Solitaire, id `palmbeach`, is the default, and a retired scheme maps to the
nearest kept one in `Helpers::colorScheme`), then the components. The app always uses
its light palette and always animates, whatever the system's dark-mode and
reduced-motion settings.

## Vendored libraries

The attachment viewers (PDF.js, mammoth, libheif) and libsodium are copied
from `node_modules` into `assets/vendor/` with their licence notices:

```bash
npm run build:vendor
```

Run it after `npm install` or after upgrading one of them, and update
[CREDITS.md](../CREDITS.md) when the list or a version changes.

## Tests

The suites run against a dev server with an installed database, and clean up
after themselves (throwaway users and boards are deleted at the end):

```bash
npm start                                  # in one terminal
RK_ADMIN_PASS='<admin password>' npm test  # in another
```

- `npm run test:api`: users, boards, cards, checklists, comments, moves,
  sharing and access isolation, CSRF, polling and version conflicts, email
  invitations and password links, over HTTP.
- `npm run test:ui`: headless Chrome (puppeteer-core against the installed
  browser): sign-in, rendering, the card dialog, phone width, and the in-place
  board sync on a remote change.
- `npm run test:share`: sharing into encrypted boards the way the installed
  PWA does it (service-worker share, fresh page load), remembered keys, and
  unlocking in the share dialog.
- `npm run test:cards`: start-up, the header and its menus, the card face and
  dialog, keyboard shortcuts, the PDF/DOCX/HEIC viewers (`tests/fixtures/`,
  rebuilt with `node tests/fixtures/make-fixtures.mjs`), and drag and drop.

Optional settings: `RK_BASE` (default `http://127.0.0.1:8080`),
`RK_ADMIN_USER` (default `admin`), `CHROME_PATH`. To test email without
sending any, start the server with `ROYAL_KANBAN_MAIL_LOG=/some/folder`: every
email is written there as a file instead.

### By hand

1. Fresh install → sign in as master → forced password change.
2. Users → create user `alice` (temporary password, at least 12 characters).
3. Create a board → add lists and cards → drag cards between lists.
4. Open a card → edit the description and finish date → add a checklist and
   items → comment.
5. Share the board with `alice` as viewer → sign in as alice → read-only, but
   she can comment.
6. Share again as editor → move and delete cards as alice; confirm she
   *cannot* invite others or remove members.
7. Delete a card, a board, a user.
8. `GET /uploads/<stored name>` returns 404; `api/file.php?…` serves it.
