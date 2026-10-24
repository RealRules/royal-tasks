# Installing and running Royal Tasks

Royal Tasks is made to run on normal web hosting: the kind of PHP and MySQL
account most hosting companies sell, with no shell access needed. There is
nothing to build on the server and nothing to keep running beside the web
server.

## Requirements

- **PHP 8.4 or newer** with `pdo_mysql`, `dom`, `json`, `session` and `openssl`.
  Optional: `mbstring` and `fileinfo` (recommended), `curl` (reading web
  pages for title images, page titles and site icons, and the S3 backups),
  `gd` (sharper, smaller site icons), `bz2` (smaller backup dumps).
- **A way to send email**, for invitations and forgotten passwords: most hosts
  have PHP's `mail()` working already; otherwise an SMTP account (see
  [Email](#email)). Without one, the app works, but those two features are off.
- **MySQL or MariaDB** (InnoDB, utf8mb4). A table prefix lets the app share a
  database with an existing site, which is often all shared hosting offers.
- **HTTPS** in production: the session cookie gets the `Secure` flag only over
  HTTPS, and installing the app as a PWA needs it.

## What to copy to the server

The whole app is one directory. There is no `public/` split and no data files
to move around: boards, users, comments and the login rate limiter live in the
database, and the only files written are card attachments. It runs equally
well at the root of a site or in a subfolder of an existing one, such as
`https://example.com/kanban/`.

You do **not** upload the whole repository; part of it is for development.
Copy these into the folder the app should be served from (e.g.
`public_html/kanban/`):

| Path | What it is |
| --- | --- |
| `index.html` | the app shell |
| `manifest.json` | PWA manifest |
| `sw.js` | service worker |
| `api/` | everything in it: `index.php`, `file.php`, `avatar.php`, `calendar.php`, `share-target.php` |
| `assets/` | everything: `css/`, `js/`, `icons/`, `vendor/` (with its licence notices) |
| `src/` | the PHP classes (executed by the server, never served) |
| `install.php` | the installer: run it once, then delete it |
| `upgrade.php` | applies database updates after you copy in a newer version |

That is the entire runtime. A release ships `assets/css/app.css` already
built, so nothing needs building on the server; run
`npm install && npm run build` only if you change the styles.

Optional:

| Path | Why |
| --- | --- |
| `config.example.php` | reference for the settings; not read at runtime |
| `router.php` | only for PHP's built-in server (`php -S … -t . router.php`); not needed with Apache or nginx |
| `uploads/` | created automatically if missing |

Do not copy:

| Path | Why not |
| --- | --- |
| `config.php` | holds **this** machine's database connection and master key. The installer writes the server's own. |
| `node_modules/`, `styles/`, `scripts/`, `package.json`, `package-lock.json` | build tooling, not used at runtime |
| `README.md`, `Agents.md`, `CREDITS.md`, `SECURITY.md`, `docs/`, `tests/`, `.gitignore`, `.gitattributes`, `start.bat`, `copyinstall.bat`, `configs3.example.php`, `backups3.php` | documentation and development only (`backups3.php` belongs outside the web root, see below) |
| `deploy/` | example server configuration, for you to read, not to serve |

PowerShell (Windows, to a server share or a local folder):

```powershell
$dest = "\\server\www\kanban"
foreach ($item in "index.html","manifest.json","sw.js","api","assets","src","install.php","upgrade.php") {
    Copy-Item -Path $item -Destination $dest -Recurse -Force
}
```

`rsync` (Linux or macOS, to a server):

```bash
rsync -av --delete \
  --exclude node_modules --exclude config.php --exclude .git \
  --exclude styles --exclude scripts --exclude deploy --exclude docs --exclude tests \
  --exclude package.json --exclude package-lock.json \
  ./ user@server:/var/www/kanban/
```

## Install

1. Create a database and a user for it, for example in your host's control
   panel. The installer can also create the database if its user may.
2. Make the app folder writable by the web server for the install: the
   installer writes `config.php`, `uploads/` and the deny rules.
3. Open `https://example.com/kanban/install.php` and enter the database
   details, a table prefix and a master username. Do it over HTTPS: the
   page shows the master password. The installer:
   - creates the tables (with the prefix, so it can share the database),
   - creates the master account and shows its password **once**, to be
     changed at first sign-in,
   - writes `config.php`, including the master key the boards are encrypted
     with,
   - writes `.htaccess`, `src/.htaccess` and `uploads/.htaccess`, and a blank
     `uploads/index.html` against directory listings.
4. Delete `install.php`. The installer offers a button for it; from the command
   line, `php install.php --self-delete`.
5. Afterwards the folder can be read-only, except `uploads/`.

Once installed, `install.php` does nothing for an anonymous visitor, so
forgetting step 4 does not leave a back door. Delete it anyway.

From the command line, for scripted deploys:

```bash
php install.php --host=127.0.0.1 --database=kanban --user=kanban \
                --password=secret --prefix=rk_ --admin=admin
php install.php --self-delete
```

### If the installer cannot write config.php

The folder is not writable by PHP. Either give the web-server user write
access to the app folder for the install, or run the installer from the
command line as a user who can write there (above).

### First steps after signing in

1. Choose your own password (the one the installer showed works once).
2. Open Preferences → Administration once and save: that records the site's
   address, which the links in emails point to. Users → *Send test email to
   me* checks that mail goes out (it uses the address in your profile).
3. Create accounts under Users, or invite people by email.

### After the install

Keep the files the installer wrote: `config.php`, the `.htaccess` files and
`uploads/index.html`. `src/` and `config.php` sit in the web root but are PHP,
so the server runs them rather than sending them; `uploads/` is denied by its
`.htaccess`, and the app serves attachments only through `api/file.php`.

For extra safety, move `uploads/` out of the web root: set `upload_dir` in
`config.php` to a path outside the site that the web-server user can write.

## Updating an installation

`copyinstall.bat <installation folder>` copies the app's runtime files
(`api/`, `src/`, `assets/` and the root files) there. It never touches the
installation's `config.php`, `uploads/` or hardening files, and it mirrors the
code folders, so files removed here are removed there too. On another system,
copy the same folders with your tool of choice.

Then bring the database up to date, from a shell on that server or in a
browser while signed in as an administrator:

```bash
php upgrade.php
```

`upgrade.php` only adds what is missing and can be run any number of times.
A database that is behind still works; the newer features wait until it has
run.

**Back up `config.php` together with the database.** Every board is encrypted
in the database, and every uploaded file on disk, under the `master_key` in
`config.php` (generated by the installer, or by the first `upgrade.php` on an
older installation). Without that key the boards cannot be read. Keep the copy
somewhere other than the database backups.

## Email

Invitations and "Forgot your password?" send email. Without any setup the
app uses whatever the server offers: PHP's `mail()` where the server has a
mail program (most Linux hosts do), else its `sendmail`. The sender is
`noreply@` your site's domain. For SMTP, or another sender address, fill in
the `mail` section of `config.php` (see `config.example.php`). Users →
*Send test email to me* checks it, and Preferences → Administration says how
mail goes out.

The links in those emails point to the site address saved in Preferences →
Administration. It is taken from an administrator's browser the first time
one saves that page, invites someone or sends a password link; check it if
people reach the site under another name. Until it is known, the sign-in
page does not offer "Forgot your password?".

## Installing it as an app (phones, tablets, computers)

Royal Tasks is a Progressive Web App (PWA): once the site is installed on a
server, everyone can add it to their phone or computer, where it opens in its
own window with its own icon, like any other app. Nothing comes from an app
store; the app is the site, and it updates itself when the site is updated.

It needs the site to be served over **HTTPS** (browsers only install apps
from secure sites; `http://localhost` is the one exception, for testing).

### Android

1. Open the site in **Chrome** and sign in.
2. Tap the **⋮** menu → **Install app** (on some versions **Add to Home
   screen** → **Install**). Chrome may also offer it in a bar at the bottom.
3. Royal Tasks is now on the home screen and in the app drawer.

Installed this way, Royal Tasks also appears in Android's **share sheet**:
share a web page, some text, a photo or a file from another app, choose
Royal Tasks, then pick the board and list for the new card. On an end-to-end
encrypted board the share stays on the phone until it is encrypted.

In **Samsung Internet**: menu → **Add page to** → **Home screen**. In
**Firefox** for Android: menu → **Install** (or **Add to Home screen**).

### iPhone and iPad

1. Open the site in **Safari** and sign in. (Since iOS 16.4, Chrome, Edge and
   Firefox on iOS can do this too, from their own share menu.)
2. Tap the **Share** button (the square with an arrow) → **Add to Home
   Screen** → **Add**.
3. Open Royal Tasks from the home screen icon.

Two things work differently on iOS:

- **Sign in once more in the app.** An app added to the home screen keeps its
  own storage, apart from Safari, so it has its own sign-in, and boards
  remembered on this device are remembered separately too.
- **Sharing into Royal Tasks from other apps is not available**: iOS does not
  let a web app appear in the share sheet. Copy a link or text and paste it
  into a card instead; pictures and files can be added with the card's
  **📎 Attach files** button, which opens the photo library and Files.

### Computers

In **Chrome** or **Edge** on Windows, macOS, Linux or ChromeOS: click the
install icon at the right end of the address bar (a screen with an arrow), or
use the menu → **Cast, save and share** → **Install page as app** (Chrome) /
**Apps** → **Install this site as an app** (Edge). In **Safari** on macOS
Sonoma or later: **File** → **Add to Dock**.

### Updates and removal

The app picks up a new version of the site by itself; if something looks
stale right after an update, close it fully and open it again. To remove it,
uninstall it like any other app (long-press the icon on a phone). This only
removes the app from that device: the boards stay on the server.

## Backups to S3

`backups3.php` backs up the database and the uploaded files to AWS S3 or any
S3-compatible storage (Hetzner, Backblaze B2, Wasabi, Cloudflare R2, MinIO):

```bash
php backups3.php                    # back up (--dry-run, --db-only, --uploads-only, --full)
php backups3.php list               # the backups in the bucket
php backups3.php restore            # the latest; or restore royal-tasks-20260928-031500
php backups3.php delete NAME        # delete a database backup; delete --all empties the prefix
```

Copy `backups3.php` **outside the web root**. Next to it, copy
`configs3.example.php` to `configs3.php` and fill it in: `app_root` is the
installation's folder, then the S3 endpoint, region, bucket and keys. The
example has settings for Hetzner Object Storage and AWS S3, with a minimal IAM
policy. `chmod 600 configs3.php` and run the script from cron. A newer
`backups3.php` can replace the old one without touching the settings.

Each run:

- uploads a consistent, compressed database dump. Dumps are kept for
  `keep_days`, never fewer than `keep_min`, and the first dump of every month
  is kept for good (`keep_monthly`).
- syncs the uploads folder file by file, sending only new or changed files. A
  file deleted in the app leaves the bucket `keep_days` later.
- can mail you when it fails.

`restore` replaces the app's tables with the dump and downloads the files that
are missing or different. It asks first (`--yes` skips that), saves the
current database to `temp_dir` before it starts, and checks afterwards that
the boards open with this installation's master key. `restore NAME --to=FILE`
only downloads the dump.

From a browser the script does nothing (404) unless `web_key` is set in
`configs3.php`. That is for hosts whose scheduled tasks can only call a URL:
`backups3.php?key=THE-KEY`, or the `X-Backup-Key` header, then runs a backup
and nothing else (no restore, list or delete, no options). The reply is the
log as plain text, with HTTP 500 if the backup failed. Use the header when
your scheduler can send one: a key in the address ends up in web server logs.

`config.php` is not in this backup. Keep it separately, never in the same
bucket: the key beside the data would undo the encryption.

## Web server configuration

Apache reads the `.htaccess` files the installer writes. nginx does not; add
these rules to the server block. The installer prints them with your base
path: in a subfolder, each `location` starts with it (`/kanban/src/` and so
on).

```nginx
root /var/www/kanban;

# The app must not be framed by another site (clickjacking).
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "same-origin" always;

location ~ ^/(src|styles|scripts|deploy|node_modules|docs|tests)/ { deny all; }
location ~* ^/(README\.md|Agents\.md|CREDITS\.md|SECURITY\.md|package(-lock)?\.json|configs3\.example\.php)$ { deny all; }
location = /config.php { deny all; }
location = /config.example.php { deny all; }
location ^~ /uploads/ { deny all; }
location ~ /\. { deny all; }
```

An example Apache vhost and php-fpm pool are in `deploy/`.

## Running locally

```powershell
.\start.bat
```

or:

```bash
php -S 127.0.0.1:8080 -t . router.php
```

Open `http://127.0.0.1:8080/install.php` on first run. `router.php` gives the
built-in server the same security headers and deny rules as production.
