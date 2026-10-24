# Security and privacy

Royal Tasks is built to keep a board readable by its members and nobody else,
including, where you ask for it, the server it runs on.

## Who can see what

- **Boards are members-only.** You see the boards you own or were invited to,
  as a viewer or an editor. Every request is checked against that membership
  on the server.
- **A site administrator has no special access to boards.** The administrator
  manages accounts and nothing more, and needs a board's password to read an
  end-to-end encrypted board like anyone else.
- **Only the owner manages a board's members.** A viewer can read and
  comment; an editor can change cards; only the owner can share, delete the
  board, or change its encryption.
- **Deleting a user strands nothing.** Their boards pass to the longest-standing
  editor. For a board with only viewers left, the administrator chooses, after
  seeing a preview: promote a viewer, take the board over, or delete it.

## Encryption

**At rest, always.** Every board's content (titles, descriptions, checklists,
comments, attachment names) is stored in the database as AES-256-GCM
ciphertext, and every uploaded file is encrypted on disk, under the
installation's master key in `config.php`. A copy of the database, or of the
uploads folder, is unreadable without that key.

**End to end, per board.** Give a board a password and its content is
encrypted in the browser (XChaCha20-Poly1305, with the key derived by Argon2id)
before it is sent. The server stores only ciphertext and cannot read it, not
even with the master key. Attachments, shares from your phone, imports and
exports go through the same encryption.

- A **recovery key**, shown once when the password is set, opens the board if
  the password is lost. Keep it somewhere safe.
- **Remember this device** keeps the board's key in the browser's own storage,
  so a returning device does not ask for the password every time.
- A locked board fails closed: the app refuses to save anything rather than
  send plaintext, and does not show the board.
- A new board password must be four different words or 20 characters, because
  anyone holding a copy of the database could try guesses offline.
- Encrypting a board that already has content encrypts all of it, attachments
  included. If that is interrupted, the encryption dialog says what is left
  and finishes it. An encrypted board has no background picture.
- A remembered board key belongs to your account on that browser and is
  forgotten when you sign out.

The board title stays readable, so the board list works without unlocking
every board.

**Shares from your phone.** On a phone where the app is installed (Chrome on
Android, for example), a shared link, text or photo stays on the device until
you choose a board. On an end-to-end board it is then encrypted in the
browser, and the server never sees it, nor fetches the page's title or
picture. On an ordinary board it becomes a card like any other. Where the
browser cannot hand the share to the app directly (Safari on iOS, for
example), it goes to a short-lived inbox on the server first, so the server
sees it before you choose the board.

**The calendar subscription.** Its address is a long random secret: anyone
who has it can see the events it lists, so keep it to yourself, and make a
new one in Preferences if it gets out (the old one stops working at once).
The feed only ever lists boards you are a member of at the moment it is
fetched. On an end-to-end board it never shows a card's title: an event is
called "Deadline", or whatever you enter as that card's Calendar name, which
is stored for you alone and is not end-to-end encrypted.

**Invitations and password links.** A link in such an email works once, and
not for long: an invitation 7 days, a forgotten-password link an hour. The
server keeps only a fingerprint of it, not the link itself. "Forgot your
password?" gives the same answer for every name and address, so it cannot
be used to find out who has an account. Choosing a new password signs out
every other session and remembered device. An administrator can turn
"Forgot your password?" and their own password links off in Preferences.

## How it is protected

| Area | How it works |
| --- | --- |
| Code and config | PHP files are executed, never sent. The installer adds deny rules (`.htaccess`) for the root and `src/`, and prints the rules for nginx. |
| Attachments | Served only through `api/file.php`, which applies the board access check. Stored under random names, never listed, with a deny `.htaccess`; a removed attachment's address stops working at once. `uploads/` can live outside the web root (`upload_dir` in `config.php`). |
| Sessions | `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, scoped to the app's folder. The session id is renewed at sign-in, sign-out and password change. "Stay signed in" uses a per-device token, stored only as a hash, that a password change revokes. |
| CSRF | Every change must be a `POST` carrying the session's token in `X-CSRF-Token`; Origin and Referer are checked as well. |
| Passwords | bcrypt, at least 12 characters, not containing the username. Passwords set by an administrator are temporary and must be changed at the next sign-in. |
| Brute force | 8 attempts per account from one address, 40 per account from anywhere, and 25 per address in 15 minutes, counted in the database. |
| Uploads | An extension allowlist, random stored names, and a size limit. Only images and PDFs are shown inline; everything else downloads. A board background must really be a PNG, JPEG, GIF or WebP (never SVG). |
| Rich text | Rebuilt from an allowlist on the server (`HtmlSanitizer`). The browser renders user text as text, never as markup. |
| Headers | A strict Content Security Policy (`script-src 'self' 'wasm-unsafe-eval'`, no CDN), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, COOP and CORP on every response. |
| Concurrent edits | A change states the board version it was made on; a stale change is refused and the browser takes the current board instead of overwriting it. |
| Fetching web pages | Title images, page titles and site icons are fetched only from public addresses (no private, loopback or metadata ranges), with redirects checked, size and time capped, and only real images kept (never SVG). Never for an end-to-end board. |
| Errors | Never shown in a response; they go to the server's error log. |
| Your email address | Changing it takes your password, and an address belongs to one account only. |

The full list of rules the code keeps, and why, is in
[Agents.md](../Agents.md) under *Security invariants*.

## Known limits

Worth knowing before you rely on it:

- **End-to-end encryption hides content, not structure.** Board titles,
  how many lists, cards and comments there are, who wrote a comment and when,
  finish dates, label colours and calendar names are readable by the server.
- **The board key is not changed when its password is.** Changing the
  password, or removing a member, re-wraps the same key. Someone who once had
  the key (a former member, a device that remembered it) and later gets a copy
  of the database could read what was written after. To shut someone out
  completely, make a new encrypted board and move the cards.
- **Ciphertext is bound to its board, not to its field.** Whoever controls the
  database cannot read an encrypted board, but could swap encrypted values
  between fields of the same board.
- **A remembered board key** is protected by a device key in the same
  browser storage. Anyone using that browser profile while you are signed in
  can open those boards; signing out forgets them.
- **"Forgot your password?"** hides whether an account exists, including in
  its timing, on PHP-FPM. Under other setups the email is sent before the
  answer, so a slow mail server can make an existing account's answer slower.
- **There are no storage quotas per user.** Uploads are limited in size and
  rate, but a member can still fill the disk over time; keep an eye on it.
- **Clickjacking protection** comes from the server's headers: the
  `.htaccess` the installer writes (Apache with mod_headers) or the nginx
  rules it prints. Check that `X-Frame-Options` or `frame-ancestors` arrives
  on the app's page.

## Reporting a vulnerability

Please report security problems privately, as described in
[SECURITY.md](../SECURITY.md), rather than in a public issue.
