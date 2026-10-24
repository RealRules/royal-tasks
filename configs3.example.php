<?php
/**
 * Settings for backups3.php. Copy this file to configs3.php, next to
 * backups3.php, and fill it in. Keep configs3.php private (chmod 600): it
 * holds the S3 secret key. Anything left out keeps the default shown here.
 *
 * (Royal Tasks never loads this file; it is only for backups3.php.)
 */
return [
    // The Royal Tasks installation: the folder with index.html and src/.
    'app_root' => '/var/www/html/rkbn',

    's3' => [
        // AWS: https://s3.<region>.amazonaws.com. Others: the provider's
        // endpoint, e.g. https://fsn1.your-objectstorage.com (Hetzner),
        // https://<account>.r2.cloudflarestorage.com (R2).
        'endpoint'      => 'https://s3.eu-central-1.amazonaws.com',
        'region'        => 'eu-central-1',   // R2: 'auto'
        'bucket'        => 'my-backups',
        // Can also come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
        'access_key'    => '',
        'secret_key'    => '',
        'prefix'        => 'royal-tasks/',   // folder inside the bucket
        // true: https://endpoint/bucket/key (MinIO and most self-hosted).
        // false: https://bucket.endpoint/key (AWS, Hetzner, Wasabi).
        'path_style'    => false,
        // Optional, e.g. 'STANDARD_IA' on AWS (cheaper per GB, but it bills
        // every object as at least 128 KB and 30 days). Leave empty elsewhere.
        'storage_class' => '',
        // Attempts per request when the service is busy (HTTP 5xx / 429),
        // waiting 2, 4, 8, 16, 32 s between them (or what it asks for).
        'retries'       => 6,
    ],

    // Database dumps older than this are deleted, but the newest keep_min
    // always stay. Files deleted in the app leave the bucket after keep_days.
    'keep_days' => 30,
    'keep_min'  => 7,

    // Keep the first database dump of every month for good (true), so there
    // is one backup per month however far back. Attachments deleted in the
    // app still leave the bucket after keep_days, so an old monthly dump
    // restores every board, card and comment, but not those files.
    'keep_monthly' => true,

    // Where the dump is written before it is sent. Empty: the system temp dir.
    'temp_dir' => '',

    // A mail when a backup fails (and, if on_success, when it succeeds).
    // Sent with PHP's mail(). Empty 'to': no mail.
    'notify' => [
        'to'         => '',
        'from'       => '',
        'on_success' => false,
    ],

    // Only for hosts whose scheduled tasks can only call a URL. Empty (the
    // default): a web request gets a 404 and nothing runs. Otherwise a random
    // secret of at least 32 characters, e.g. from
    //   php -r "echo bin2hex(random_bytes(24));"
    // which the request must send: ?key=... or the X-Backup-Key header.
    'web_key' => '',
];

/*
 * Example: Hetzner Object Storage (endpoint by location: fsn1, nbg1, hel1).
 * Create the bucket and an S3 key pair in the Hetzner Console (Object
 * Storage, then Security, S3 credentials):
 *
 *     's3' => [
 *         'endpoint'   => 'https://fsn1.your-objectstorage.com',
 *         'region'     => 'fsn1',
 *         'bucket'     => 'royal-tasks-backup',
 *         'access_key' => 'XXXXXXXXXXXXXXXXXXXX',
 *         'secret_key' => 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
 *         'prefix'     => 'rkbn/',
 *         'path_style' => false,
 *     ],
 *
 * Example: AWS S3. Create the bucket (Block Public Access on, versioning
 * optional) and an IAM user with only this policy:
 *
 *     {"Version": "2012-10-17", "Statement": [
 *       {"Effect": "Allow", "Action": "s3:ListBucket",
 *        "Resource": "arn:aws:s3:::royal-tasks-backup"},
 *       {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
 *        "Resource": "arn:aws:s3:::royal-tasks-backup/*"}]}
 *
 *     's3' => [
 *         'endpoint'   => 'https://s3.eu-central-1.amazonaws.com',
 *         'region'     => 'eu-central-1',
 *         'bucket'     => 'royal-tasks-backup',
 *         'access_key' => 'AKIAXXXXXXXXXXXXXXXX',
 *         'secret_key' => 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
 *         'prefix'     => 'rkbn/',
 *         'path_style' => false,
 *     ],
 */
