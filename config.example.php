<?php
/**
 * Royal Tasks — configuration.
 *
 * install.php writes `config.php` for you; this file only documents the shape
 * and is kept as a reference. You do not need to copy it by hand.
 *
 * The app is database-backed: boards, users, comments, checklists and the
 * login rate limiter all live in MySQL/MariaDB. The only application data on
 * disk is the card attachments under `uploads/`.
 */

return [
    /*
     * Database connection. Table names are prefixed so the app can share one
     * database with an existing site, which is all shared hosting usually
     * gives you.
     */
    'db' => [
        'host'     => '127.0.0.1',
        'port'     => 3306,
        'database' => 'royal_kanban',
        'username' => 'kanban',
        'password' => 'change-me',
        'prefix'   => 'rk_',

        // The installer applies the schema once. A normal request must never
        // run DDL, so leave this false unless you are developing.
        'auto_migrate' => false,
    ],

    /*
     * Where attachments are stored. Defaults to `uploads/` inside the app
     * folder. The directory gets a deny `.htaccess`, a blank index.html, and
     * files are only ever served through api/file.php — but moving it outside
     * the web root is still the stronger option when you can:
     *
     *     'upload_dir' => '/var/lib/royal-kanban/uploads',
     *
     * Relative paths resolve against the app root. See rk_resolve_dir().
     */
    // 'upload_dir' => 'uploads',

    /*
     * The directory the web server serves. Defaults to the app root (the
     * one-directory install). Set it only when the app is nested inside a
     * larger site, so diagnostics can name the real document root.
     */
    // 'public_dir' => '/home/youruser/public_html',

    /*
     * Set to true only when the app runs behind a trusted reverse proxy that
     * terminates TLS. It makes the app read X-Forwarded-Proto (so the session
     * cookie keeps its Secure flag) and X-Forwarded-For (so the per-IP login
     * limit sees real clients). Off by default: those headers are forged by
     * anyone who can reach the app directly.
     *
     * The client address is taken from the right of X-Forwarded-For, because
     * proxies append and the left is client-supplied. With more than one proxy
     * hop, set trusted_proxies to the number of trusted proxies in front.
     */
    // 'trust_proxy' => true,
    // 'trusted_proxies' => 1,

    /*
     * Email the app sends (src/Mailer.php): invitations, password links, a
     * test mail. Without this section the transport is 'auto': SMTP when a
     * host is set, else PHP's mail() when the server has a mail program, else
     * sendmail run directly; the sender defaults to noreply@ the site's
     * domain. 'log' writes each email to files in 'log_dir' (testing). 'none' sends
     * nothing. 'mail' uses PHP's mail() (the server's own sendmail); 'smtp'
     * talks to a mail server: 'secure' => 'tls' is STARTTLS (usually port
     * 587), 'ssl' is TLS from the start (465). Certificates are verified.
     * An administrator can check it in Users → Send test email to me (it goes
     * to the address in their profile).
     */
    // 'mail' => [
    //     'transport' => 'smtp',              // 'auto' (the default), 'smtp', 'mail', 'sendmail', 'log' or 'none'
    //     'from'      => 'noreply@example.com',
    //     'from_name' => 'Royal Tasks',
    //     'smtp' => [
    //         'host'     => 'smtp.example.com',
    //         'port'     => 587,
    //         'secure'   => 'tls',             // 'tls', 'ssl' or '' (none)
    //         'username' => 'noreply@example.com',
    //         'password' => 'the mailbox password',
    //         'timeout'  => 20,
    //     ],
    // ],
];
