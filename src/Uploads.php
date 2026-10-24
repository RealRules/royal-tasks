<?php
declare(strict_types=1);

/**
 * File uploads for card attachments and the share-target inbox.
 *
 * Files live outside the document root and are only ever reachable through
 * api/file.php, which applies the board access check. The stored filename is
 * generated here and carries an extension from a fixed allowlist, so nothing
 * the uploader controls can influence how a web server would interpret it.
 */
final class Uploads
{
    public const MAX_BYTES = 12 * 1024 * 1024;
    public const MAX_FILES_PER_REQUEST = 10;

    /** extension => served MIME type. Anything absent here is rejected. */
    private const ALLOWED = [
        'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
        'gif' => 'image/gif', 'webp' => 'image/webp', 'bmp' => 'image/bmp',
        'ico' => 'image/x-icon', 'svg' => 'image/svg+xml', 'avif' => 'image/avif',
        'heic' => 'image/heic', 'heif' => 'image/heif',
        'pdf' => 'application/pdf',
        'txt' => 'text/plain', 'md' => 'text/plain', 'log' => 'text/plain',
        'csv' => 'text/csv', 'json' => 'application/json',
        'mp4' => 'video/mp4', 'webm' => 'video/webm', 'mov' => 'video/quicktime',
        'mp3' => 'audio/mpeg', 'wav' => 'audio/wav', 'ogg' => 'audio/ogg',
        'm4a' => 'audio/mp4',
        'zip' => 'application/zip',
        'doc' => 'application/msword',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls' => 'application/vnd.ms-excel',
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt' => 'application/vnd.ms-powerpoint',
        'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ];

    /**
     * Types safe to render in the browser. Everything else — including SVG
     * and any text/html — is sent as a download so it cannot script our origin.
     */
    private const INLINE_SAFE = [
        'image/png', 'image/jpeg', 'image/gif', 'image/webp',
        'image/bmp', 'image/x-icon', 'image/avif', 'application/pdf',
    ];

    /**
     * Where attachments live. Configurable via RK_UPLOAD_DIR (see
     * src/bootstrap.php); the literal fallback only matters if this class is
     * used without the bootstrap, e.g. from a one-off script.
     */
    public static function baseDir(): string
    {
        return defined('RK_UPLOAD_DIR')
            ? (string)RK_UPLOAD_DIR
            : dirname(__DIR__) . DIRECTORY_SEPARATOR . 'uploads';
    }

    /** The MIME type we serve for a stored file, derived from its extension. */
    public static function mimeForStored(string $stored): string
    {
        $ext = strtolower(pathinfo($stored, PATHINFO_EXTENSION));
        return self::ALLOWED[$ext] ?? 'application/octet-stream';
    }

    public static function isInlineSafe(string $mime): bool
    {
        return in_array($mime, self::INLINE_SAFE, true);
    }

    /** @return array<int,array<string,mixed>> */
    private static function normalize(array $files): array
    {
        $out = [];
        foreach ($files as $f) {
            if (!is_array($f)) {
                continue;
            }
            if (isset($f['name']) && is_array($f['name'])) {
                $n = count($f['name']);
                for ($i = 0; $i < $n; $i++) {
                    $out[] = [
                        'name' => $f['name'][$i] ?? '',
                        'type' => $f['type'][$i] ?? '',
                        'tmp_name' => $f['tmp_name'][$i] ?? '',
                        'error' => $f['error'][$i] ?? UPLOAD_ERR_NO_FILE,
                        'size' => $f['size'][$i] ?? 0,
                    ];
                }
            } elseif (isset($f['tmp_name'])) {
                $out[] = $f;
            }
        }
        return $out;
    }

    /** Display name only — never used to build a path on disk. */
    public static function displayName(string $name): string
    {
        $base = basename(str_replace('\\', '/', $name));
        $base = preg_replace('/[^\w.\- ]/u', '_', $base) ?? 'file';
        $base = trim(trim($base), '. ');
        return $base === '' ? 'file' : mb_substr($base, 0, 120);
    }

    /** The extension we will actually store under, or null when disallowed. */
    /**
     * The extension for a file that came without one, from what it contains:
     * images, PDF, video and audio only (never SVG, HTML or text, whose type
     * a name should state). Null when unknown or when fileinfo is missing.
     */
    private static function extFromContent(string $path): ?string
    {
        if ($path === '' || !is_file($path) || !function_exists('finfo_open')) {
            return null;
        }
        $f = finfo_open(FILEINFO_MIME_TYPE);
        $mime = $f ? (string)finfo_file($f, $path) : '';
        return [
            'image/png' => 'png', 'image/jpeg' => 'jpg', 'image/gif' => 'gif', 'image/webp' => 'webp',
            'image/avif' => 'avif', 'image/heic' => 'heic', 'image/heif' => 'heif', 'application/pdf' => 'pdf',
            'video/mp4' => 'mp4', 'video/quicktime' => 'mov', 'video/webm' => 'webm',
            'audio/mpeg' => 'mp3', 'audio/ogg' => 'ogg', 'audio/x-wav' => 'wav', 'audio/wav' => 'wav',
        ][$mime] ?? null;
    }

    private static function safeExtension(string $originalName): ?string
    {
        $ext = strtolower(pathinfo(str_replace('\\', '/', $originalName), PATHINFO_EXTENSION));
        $ext = preg_replace('/[^a-z0-9]/', '', $ext) ?? '';
        return isset(self::ALLOWED[$ext]) ? $ext : null;
    }

    /**
     * Store uploaded files under uploads/<subdir>/.
     *
     * @param string $subdir caller-supplied, but always an id this app minted
     * @return array<int,array<string,mixed>> records with name/stored/mime/size
     */
    public static function saveFiles(array $files, string $subdir): array
    {
        $items = self::normalize($files);
        if (count($items) > self::MAX_FILES_PER_REQUEST) {
            throw new RuntimeException('Too many files in one upload (max ' . self::MAX_FILES_PER_REQUEST . ').');
        }
        $subdir = self::safeSegment($subdir);
        $dir = self::baseDir() . DIRECTORY_SEPARATOR . $subdir;
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new RuntimeException('Could not create the upload folder.');
        }

        $out = [];
        foreach ($items as $f) {
            $error = (int)($f['error'] ?? UPLOAD_ERR_NO_FILE);
            if ($error === UPLOAD_ERR_NO_FILE) {
                continue;
            }
            if ($error === UPLOAD_ERR_INI_SIZE || $error === UPLOAD_ERR_FORM_SIZE) {
                throw new RuntimeException('File too large (max 12 MB).');
            }
            if ($error !== UPLOAD_ERR_OK) {
                throw new RuntimeException('Upload failed.');
            }
            if ((int)($f['size'] ?? 0) > self::MAX_BYTES) {
                throw new RuntimeException('File too large (max 12 MB).');
            }

            $display = self::displayName((string)($f['name'] ?? 'file'));
            $ext = self::safeExtension((string)($f['name'] ?? ''));
            // Some apps share a photo with no name or no extension. Only then
            // (never for a name with another extension) the content decides,
            // and only among the plain types below.
            if ($ext === null && !preg_match('/\.[A-Za-z0-9]{1,8}$/', (string)($f['name'] ?? ''))) {
                $ext = self::extFromContent((string)($f['tmp_name'] ?? ''));
                if ($ext !== null) {
                    $display = (trim((string)($f['name'] ?? '')) === '' ? 'Shared file' : $display) . '.' . $ext;
                }
            }
            if ($ext === null) {
                throw new RuntimeException('That file type is not allowed.');
            }

            // Name on disk is ours alone: random stem + allowlisted extension.
            $stored = bin2hex(random_bytes(16)) . '.' . $ext;
            $dest = $dir . DIRECTORY_SEPARATOR . $stored;
            $tmp = (string)($f['tmp_name'] ?? '');
            if ($tmp === '' || !is_uploaded_file($tmp)) {
                throw new RuntimeException('Upload failed.');
            }
            if (!move_uploaded_file($tmp, $dest)) {
                throw new RuntimeException('Could not store uploaded file.');
            }
            @chmod($dest, 0600);
            $size = (int)@filesize($dest);
            self::sealFile($dest, true);

            $out[] = [
                'name' => $display,
                'stored' => $subdir . '/' . $stored,
                'mime' => self::ALLOWED[$ext],
                'size' => $size,
            ];
        }
        return $out;
    }

    /**
     * Store a single encrypted attachment.
     *
     * The browser sends ciphertext as application/octet-stream, so there is no
     * meaningful extension and no magic bytes to sniff: the file is written
     * under a random name ending in `.enc`, which is never inline-served. The
     * real MIME type and filename live encrypted in the row, so only a client
     * holding the board key can recover them.
     *
     * @return array<int,array<string,mixed>>
     */
    public static function saveCiphertext(array $files, string $boardId, string $attachmentId, string $encName): array
    {
        $items = self::normalize($files);
        if (count($items) !== 1) {
            throw new RuntimeException('An encrypted attachment must be uploaded on its own.');
        }
        $f = $items[0];
        if ((int)($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            throw new RuntimeException('Upload failed.');
        }
        if ((int)($f['size'] ?? 0) > self::MAX_BYTES + 4096) { // ciphertext + nonce tag
            throw new RuntimeException('File too large (max 12 MB).');
        }
        $dir = self::baseDir() . DIRECTORY_SEPARATOR . self::safeSegment($boardId);
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new RuntimeException('Could not create the upload folder.');
        }
        // Name the file after the attachment id, so the row and the file are
        // obviously the same object. Random stem keeps it unguessable anyway.
        $stored = $attachmentId . '-' . bin2hex(random_bytes(8)) . '.enc';
        $dest = $dir . DIRECTORY_SEPARATOR . $stored;
        $tmp = (string)($f['tmp_name'] ?? '');
        if ($tmp === '' || !is_uploaded_file($tmp)) {
            throw new RuntimeException('Upload failed.');
        }
        if (!move_uploaded_file($tmp, $dest)) {
            throw new RuntimeException('Could not store uploaded file.');
        }
        @chmod($dest, 0600);
        $size = (int)@filesize($dest);
        self::sealFile($dest, true);
        return [[
            'attachmentId' => $attachmentId,
            'name' => self::displayName($encName !== '' ? 'encrypted' : 'encrypted'),
            'encName' => $encName, // ciphertext of the real filename
            'stored' => self::safeSegment($boardId) . '/' . $stored,
            'mime' => 'application/octet-stream',
            'size' => $size,
        ]];
    }

    /** True when a board's stored file decodes as a PNG, JPEG, GIF or WebP image. */
    public static function isRasterImage(string $stored, string $boardId): bool
    {
        $path = self::resolve($stored, $boardId);
        if (!$path) {
            return false;
        }
        try {
            $info = @getimagesizefromstring(self::readStored($path));
        } catch (Throwable) {
            return false;
        }
        return is_array($info) && in_array((string)($info['mime'] ?? ''), ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], true);
    }

    /** Copy a stored file into a board's directory. Returns the new stored path or null. */
    public static function copyStored(string $stored, string $boardId): ?string
    {
        $src = self::resolveAny($stored);
        if (!$src) {
            return null;
        }
        $board = self::safeSegment($boardId);
        $dir = self::baseDir() . DIRECTORY_SEPARATOR . $board;
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            return null;
        }
        $ext = self::safeExtension($stored);
        if ($ext === null) {
            return null;
        }
        $name = bin2hex(random_bytes(16)) . '.' . $ext;
        $dest = $dir . DIRECTORY_SEPARATOR . $name;
        // Encrypted files are bound to their own name, so a copy is decrypted
        // and sealed again under the new one; it is never written in plaintext.
        try {
            $bytes = self::readStored($src);
        } catch (Throwable) {
            return null;
        }
        if (@file_put_contents($dest, AtRest::sealBytes($bytes, self::fileAad($dest)), LOCK_EX) === false) {
            return null;
        }
        @chmod($dest, 0600);
        return $board . '/' . $name;
    }

    /**
     * Store bytes the server produced itself (a fetched title image) as a new
     * file of a board, under a generated name, sealed at rest.
     *
     * @return array{stored:string,size:int}
     */
    public static function saveBytes(string $bytes, string $subdir, string $ext): array
    {
        if (!isset(self::ALLOWED[$ext])) {
            throw new RuntimeException('That file type is not allowed.');
        }
        $subdir = self::safeSegment($subdir);
        $dir = self::baseDir() . DIRECTORY_SEPARATOR . $subdir;
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new RuntimeException('Could not create the upload folder.');
        }
        $stored = bin2hex(random_bytes(16)) . '.' . $ext;
        $dest = $dir . DIRECTORY_SEPARATOR . $stored;
        if (@file_put_contents($dest, AtRest::sealBytes($bytes, self::fileAad($dest)), LOCK_EX) === false) {
            throw new RuntimeException('Could not store the file.');
        }
        @chmod($dest, 0600);
        return ['stored' => $subdir . '/' . $stored, 'size' => strlen($bytes)];
    }

    // -----------------------------------------------------------------
    // Encryption at rest for files (see AtRest)
    // -----------------------------------------------------------------

    /** A stored file's AAD: its name, which is random and never reused. */
    private static function fileAad(string $path): string
    {
        return 'file:' . basename($path);
    }

    /**
     * Encrypt a stored file in place (no-op without a key). `$fresh`: a file
     * just uploaded, always sealed, whatever its first bytes; otherwise (the
     * upgrade's pass over old files) one already sealed is left alone.
     */
    public static function sealFile(string $path, bool $fresh = false): bool
    {
        if (!AtRest::hasKey() || !is_file($path)) {
            return false;
        }
        $data = (string)file_get_contents($path);
        if (!$fresh && str_starts_with($data, AtRest::FILE_MAGIC)) {
            return false;
        }
        // Write beside it and rename, so a crash never leaves half a file.
        $tmp = $path . '.sealing';
        if (@file_put_contents($tmp, AtRest::sealBytes($data, self::fileAad($path)), LOCK_EX) === false) {
            @unlink($tmp);
            throw new RuntimeException('Could not encrypt the stored file.');
        }
        @chmod($tmp, 0600);
        if (!@rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException('Could not encrypt the stored file.');
        }
        return true;
    }

    /** The plaintext bytes of a stored file (decrypted when sealed). */
    public static function readStored(string $path): string
    {
        $data = @file_get_contents($path);
        if ($data === false) {
            throw new RuntimeException('Could not read the stored file.');
        }
        return AtRest::openBytes($data, self::fileAad($path));
    }

    /**
     * Encrypt every file in uploads/ that is not sealed yet: the step
     * upgrade.php runs once a master key exists. The hardening files the app
     * writes (.htaccess, index.html) are left alone. Returns how many files
     * were encrypted; running it again finds none.
     */
    public static function sealAll(): int
    {
        $base = self::baseDir();
        if (!AtRest::hasKey() || !is_dir($base)) {
            return 0;
        }
        $n = 0;
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) {
            $name = $f->getFilename();
            if (!$f->isFile() || in_array($name, ['.htaccess', 'index.html', '.user.ini'], true) || str_ends_with($name, '.sealing')) {
                continue;
            }
            if (self::sealFile($f->getPathname())) {
                $n++;
            }
        }
        return $n;
    }

    public static function deleteStored(string $stored): void
    {
        $p = self::resolveAny($stored);
        if ($p) {
            @unlink($p);
        }
    }

    public static function deleteDir(string $subdir): void
    {
        $dir = self::baseDir() . DIRECTORY_SEPARATOR . self::safeSegment($subdir, true);
        $base = realpath(self::baseDir());
        $real = realpath($dir);
        if (!$real || !$base || !str_starts_with($real, $base . DIRECTORY_SEPARATOR)) {
            return;
        }
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($real, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($it as $f) {
            $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
        }
        @rmdir($real);
    }

    /** Total bytes held by every pending share-inbox folder. */
    public static function inboxBytes(): int
    {
        $total = 0;
        foreach (glob(self::baseDir() . DIRECTORY_SEPARATOR . 'inbox_*', GLOB_ONLYDIR) ?: [] as $dir) {
            $it = new RecursiveIteratorIterator(
                new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)
            );
            foreach ($it as $f) {
                if ($f->isFile()) {
                    $total += (int)$f->getSize();
                }
            }
        }
        return $total;
    }

    /**
     * Reject anything that is not a plain id segment. Path separators, dots
     * and traversal sequences never reach the filesystem.
     */
    private static function safeSegment(string $value, bool $allowNested = false): string
    {
        $value = trim(str_replace('\\', '/', $value), '/');
        if ($allowNested) {
            $parts = array_filter(explode('/', $value), fn($p) => $p !== '');
            $clean = array_map(fn($p) => preg_replace('/[^A-Za-z0-9_\-]/', '', $p) ?? '', $parts);
            $clean = array_filter($clean, fn($p) => $p !== '');
            if (count($clean) === 0) {
                throw new RuntimeException('Invalid storage path.');
            }
            return implode(DIRECTORY_SEPARATOR, $clean);
        }
        $clean = preg_replace('/[^A-Za-z0-9_\-]/', '', $value) ?? '';
        if ($clean === '') {
            throw new RuntimeException('Invalid storage path.');
        }
        return $clean;
    }

    /** Resolve any stored path inside uploads/. Null when invalid. */
    public static function resolveAny(string $stored): ?string
    {
        $stored = str_replace('\\', '/', trim($stored));
        if ($stored === '' || str_contains($stored, '..')) {
            return null;
        }
        // Only the shapes we mint: "<id>/<file>" or "inbox/<id>/<file>", where
        // <file> is a 32-hex stem plus extension (plain uploads) or an
        // attachment id, a random stem and ".enc" (encrypted uploads).
        $plain = '#^(inbox/)?[A-Za-z0-9_\-]+/[a-f0-9]{32}\.[a-z0-9]+$#';
        $sealed = '#^(inbox/)?[A-Za-z0-9_\-]+/f_[A-Za-z0-9]+-[a-f0-9]{16}\.enc$#';
        if (!preg_match($plain, $stored) && !preg_match($sealed, $stored)) {
            return null;
        }
        $base = realpath(self::baseDir());
        $full = realpath(self::baseDir() . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $stored));
        if (!$full || !$base || !str_starts_with($full, $base . DIRECTORY_SEPARATOR)) {
            return null;
        }
        return is_file($full) ? $full : null;
    }

    /** Resolve a board-owned file. Null when invalid or outside the board's dir. */
    public static function resolve(string $stored, string $boardId): ?string
    {
        $stored = str_replace('\\', '/', trim($stored));
        if ($boardId === '' || !str_starts_with($stored, $boardId . '/')) {
            return null;
        }
        return self::resolveAny($stored);
    }
}
