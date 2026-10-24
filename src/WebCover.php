<?php
declare(strict_types=1);

/**
 * Finds the title image of a web page, for a card whose title is a URL.
 *
 * The server fetches a URL a user typed, so this is written against SSRF:
 *
 *  - Only http and https, on the default ports or 1024-65535.
 *  - The host is resolved here and every address checked: private, loopback,
 *    link-local (cloud metadata lives at 169.254.169.254), reserved, multicast
 *    and IPv4-mapped forms of those are refused.
 *  - The connection is pinned to the checked address (CURLOPT_RESOLVE), so a
 *    DNS answer that changes between the check and the connect cannot point
 *    it somewhere else.
 *  - Redirects are followed by hand (at most 4), each hop checked again.
 *  - Short timeouts, a byte cap on everything read, and the image must decode
 *    as a PNG, JPEG, GIF or WebP.
 *
 * Needs ext-curl; without it the feature reports that it is unavailable.
 */
final class WebCover
{
    private const MAX_PAGE_BYTES = 1_000_000;
    private const MAX_IMAGE_BYTES = 5_000_000;
    private const MAX_REDIRECTS = 4;
    private const TIMEOUT = 8;

    /** @var array<string,string> MIME => stored extension */
    private const IMAGE_TYPES = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/gif' => 'gif', 'image/webp' => 'webp'];

    public static function available(): bool
    {
        return function_exists('curl_init');
    }

    /**
     * The page's title image as bytes, or null when the page names none.
     *
     * $allowPrivate exists for the test suite only (a local fixture server);
     * no request path sets it.
     *
     * @return array{bytes:string,mime:string,ext:string,source:string}|null
     */
    public static function fetch(string $pageUrl, bool $allowPrivate = false): ?array
    {
        if (!self::available()) {
            throw new RuntimeException('Fetching title images needs the PHP curl extension.');
        }
        [$html, $finalUrl] = self::get($pageUrl, self::MAX_PAGE_BYTES, ['text/html', 'application/xhtml+xml'], $allowPrivate);
        $img = self::imageUrlFrom($html, $finalUrl);
        if ($img === null) {
            return null;
        }
        [$bytes, $source] = self::get($img, self::MAX_IMAGE_BYTES, array_keys(self::IMAGE_TYPES), $allowPrivate);
        $info = @getimagesizefromstring($bytes);
        $mime = is_array($info) ? (string)($info['mime'] ?? '') : '';
        if (!isset(self::IMAGE_TYPES[$mime])) {
            throw new RuntimeException('The page\'s image is not a PNG, JPEG, GIF or WebP.');
        }
        return ['bytes' => $bytes, 'mime' => $mime, 'ext' => self::IMAGE_TYPES[$mime], 'source' => $source];
    }

    /**
     * The page's title: og:title, else twitter:title, else <title>, with
     * whitespace collapsed and cut to a card title's 200 characters. Null
     * when the page names none. Fetched through the same guarded get() as
     * the title image (public addresses only, redirects re-checked).
     */
    public static function pageTitle(string $pageUrl, bool $allowPrivate = false): ?string
    {
        if (!self::available()) {
            throw new RuntimeException('Reading page titles needs the PHP curl extension.');
        }
        [$html] = self::get($pageUrl, self::MAX_PAGE_BYTES, ['text/html', 'application/xhtml+xml'], $allowPrivate);
        return self::titleFrom($html);
    }

    /**
     * A page's title and its site icon, for a checklist item that is a web
     * address. The icon is a data: URI built here from bytes that decode as
     * PNG, JPEG, GIF, WebP or ICO (never SVG), at most ICON_BYTES; scaled to
     * 32 px when GD is there. Either part may be null.
     *
     * @return array{title:?string,icon:?string}
     */
    public static function linkInfo(string $pageUrl, bool $allowPrivate = false): array
    {
        if (!self::available()) {
            throw new RuntimeException('Reading web pages needs the PHP curl extension.');
        }
        [$html, $finalUrl] = self::get($pageUrl, self::MAX_PAGE_BYTES, ['text/html', 'application/xhtml+xml'], $allowPrivate);
        $icon = null;
        $tries = 0;
        foreach (self::iconUrlsFrom($html, $finalUrl) as $src) {
            if (++$tries > 3) {
                break;
            }
            try {
                [$bytes] = self::get($src, self::MAX_ICON_FETCH, ['image/', 'application/octet-stream', 'text/plain'], $allowPrivate);
            } catch (RuntimeException) {
                continue;
            }
            $icon = self::iconData($bytes);
            if ($icon !== null) {
                break;
            }
        }
        return ['title' => self::titleFrom($html), 'icon' => $icon];
    }

    private const MAX_ICON_FETCH = 200_000;
    private const ICON_BYTES = 24_000;

    /**
     * The icons a page names (rel icon / shortcut icon, then apple-touch-icon),
     * smallest declared size first, then /favicon.ico; absolute, http(s) only.
     *
     * @return array<int,string>
     */
    public static function iconUrlsFrom(string $html, string $base): array
    {
        $doc = new DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);
        $found = [];
        foreach ($doc->getElementsByTagName('link') as $n => $l) {
            $rel = ' ' . strtolower(preg_replace('/\s+/', ' ', $l->getAttribute('rel'))) . ' ';
            $href = trim($l->getAttribute('href'));
            $type = strtolower(trim($l->getAttribute('type')));
            if ($href === '' || str_contains($type, 'svg') || preg_match('/\.svgz?(\?|#|$)/i', $href)) {
                continue;
            }
            $rank = str_contains($rel, ' icon ') ? 0 : (str_contains($rel, ' apple-touch-icon') ? 1 : -1);
            if ($rank < 0) {
                continue;
            }
            $size = preg_match('/(\d+)x\d+/i', $l->getAttribute('sizes'), $m) ? (int)$m[1] : 32;
            // Closest to 32 px first, so the bytes stay small.
            $found[] = [$rank, abs($size - 32) + ($size < 16 ? 100 : 0), $n, $href];
        }
        sort($found);
        $urls = [];
        foreach ($found as $f) {
            $abs = self::absolute($f[3], $base);
            if ($abs !== null && !in_array($abs, $urls, true)) {
                $urls[] = $abs;
            }
        }
        $b = parse_url($base);
        if (!empty($b['host'])) {
            $fav = strtolower((string)($b['scheme'] ?? 'https')) . '://' . $b['host'] . (isset($b['port']) ? ':' . $b['port'] : '') . '/favicon.ico';
            if (!in_array($fav, $urls, true)) {
                $urls[] = $fav;
            }
        }
        return $urls;
    }

    /** Bytes that decode as an image become a data: URI (32 px PNG with GD), else null. */
    public static function iconData(string $bytes): ?string
    {
        $info = @getimagesizefromstring($bytes);
        $mime = is_array($info) ? (string)($info['mime'] ?? '') : '';
        $isIco = $mime === 'image/vnd.microsoft.icon' || $mime === 'image/x-icon'
            || (!is_array($info) && strlen($bytes) > 6 && substr($bytes, 0, 4) === "\x00\x00\x01\x00");
        if ($isIco) {
            return strlen($bytes) <= self::ICON_BYTES ? 'data:image/x-icon;base64,' . base64_encode($bytes) : null;
        }
        if (!isset(self::IMAGE_TYPES[$mime])) {
            return null;
        }
        if (function_exists('imagecreatefromstring') && (($info[0] ?? 0) > 32 || strlen($bytes) > self::ICON_BYTES)) {
            $src = @imagecreatefromstring($bytes);
            if ($src !== false) {
                $dst = imagecreatetruecolor(32, 32);
                imagealphablending($dst, false);
                imagesavealpha($dst, true);
                imagefill($dst, 0, 0, imagecolorallocatealpha($dst, 0, 0, 0, 127));
                imagecopyresampled($dst, $src, 0, 0, 0, 0, 32, 32, imagesx($src), imagesy($src));
                ob_start();
                imagepng($dst);
                $png = (string)ob_get_clean();
                if ($png !== '' && strlen($png) <= self::ICON_BYTES) {
                    return 'data:image/png;base64,' . base64_encode($png);
                }
            }
        }
        return strlen($bytes) <= self::ICON_BYTES ? 'data:' . $mime . ';base64,' . base64_encode($bytes) : null;
    }

    /** The title a page declares (see pageTitle), parsed with DOMDocument, never executed. */
    public static function titleFrom(string $html): ?string
    {
        $doc = new DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);
        $found = [];
        foreach ($doc->getElementsByTagName('meta') as $m) {
            $key = strtolower(trim($m->getAttribute('property') ?: $m->getAttribute('name')));
            if (in_array($key, ['og:title', 'twitter:title'], true)) {
                $found[$key] ??= $m->getAttribute('content');
            }
        }
        $t = $doc->getElementsByTagName('title')->item(0);
        if ($t !== null) {
            $found['title'] = $t->textContent;
        }
        foreach (['og:title', 'twitter:title', 'title'] as $k) {
            $v = trim((string)preg_replace('/\s+/u', ' ', (string)($found[$k] ?? '')));
            if ($v !== '') {
                return mb_substr($v, 0, 200);
            }
        }
        return null;
    }

    /**
     * The og:image / twitter:image / image_src the page declares, made
     * absolute against the page's URL. Parsed with DOMDocument, never
     * executed; only http(s) results are returned.
     */
    public static function imageUrlFrom(string $html, string $base): ?string
    {
        $doc = new DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);
        $found = [];
        foreach ($doc->getElementsByTagName('meta') as $m) {
            $key = strtolower(trim($m->getAttribute('property') ?: $m->getAttribute('name')));
            $val = trim($m->getAttribute('content'));
            if ($val !== '' && in_array($key, ['og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image', 'twitter:image:src'], true)) {
                $found[$key] ??= $val;
            }
        }
        foreach ($doc->getElementsByTagName('link') as $l) {
            if (strtolower(trim($l->getAttribute('rel'))) === 'image_src' && trim($l->getAttribute('href')) !== '') {
                $found['image_src'] ??= trim($l->getAttribute('href'));
            }
        }
        foreach (['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image_src'] as $k) {
            if (isset($found[$k])) {
                $abs = self::absolute($found[$k], $base);
                if ($abs !== null) {
                    return $abs;
                }
            }
        }
        return null;
    }

    /**
     * GET a URL safely. Returns [body, final URL].
     *
     * @param array<int,string> $types acceptable Content-Types (prefix match)
     * @return array{0:string,1:string}
     */
    private static function get(string $url, int $maxBytes, array $types, bool $allowPrivate): array
    {
        for ($hop = 0; $hop <= self::MAX_REDIRECTS; $hop++) {
            [$host, $port, $ip] = self::checkUrl($url, $allowPrivate);
            $body = '';
            $tooBig = false;
            $ch = curl_init();
            curl_setopt_array($ch, [
                CURLOPT_URL => $url,
                // Connect to exactly the address that was checked.
                CURLOPT_RESOLVE => ["{$host}:{$port}:" . (str_contains($ip, ':') ? "[{$ip}]" : $ip)],
                CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_CONNECTTIMEOUT => 4,
                CURLOPT_TIMEOUT => self::TIMEOUT,
                CURLOPT_HEADER => false,
                CURLOPT_USERAGENT => 'RoyalTasks/1.0 (+title image)',
                CURLOPT_HTTPHEADER => ['Accept: text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.1'],
                CURLOPT_ENCODING => '',
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$body, &$tooBig, $maxBytes): int {
                    if (strlen($body) + strlen($chunk) > $maxBytes) {
                        $tooBig = true;
                        return 0; // abort the transfer
                    }
                    $body .= $chunk;
                    return strlen($chunk);
                },
            ]);
            $ok = curl_exec($ch);
            $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $type = strtolower((string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE));
            $location = (string)curl_getinfo($ch, CURLINFO_REDIRECT_URL);
            $error = curl_error($ch);
            curl_close($ch);
            if ($tooBig) {
                throw new RuntimeException('The page or its image is too large.');
            }
            if ($ok === false) {
                throw new RuntimeException('Could not load ' . $host . ($error !== '' ? ': ' . $error : '.'));
            }
            if ($status >= 300 && $status < 400 && $location !== '') {
                $url = $location; // checked again at the top of the loop
                continue;
            }
            if ($status !== 200) {
                throw new RuntimeException("{$host} answered {$status}.");
            }
            $match = false;
            foreach ($types as $t) {
                if (str_starts_with($type, $t)) {
                    $match = true;
                    break;
                }
            }
            if (!$match) {
                throw new RuntimeException('Unexpected content from ' . $host . '.');
            }
            return [$body, $url];
        }
        throw new RuntimeException('Too many redirects.');
    }

    /**
     * Validate a URL and resolve its host to one public address.
     *
     * @return array{0:string,1:int,2:string} host, port, IP to connect to
     */
    public static function checkUrl(string $url, bool $allowPrivate = false): array
    {
        $p = parse_url($url);
        $scheme = strtolower((string)($p['scheme'] ?? ''));
        $host = strtolower(trim((string)($p['host'] ?? ''), '[]'));
        if (!in_array($scheme, ['http', 'https'], true) || $host === '' || isset($p['user']) || isset($p['pass'])) {
            throw new RuntimeException('Only plain http(s) web addresses are fetched.');
        }
        $port = (int)($p['port'] ?? ($scheme === 'https' ? 443 : 80));
        if (!in_array($port, [80, 443], true) && ($port < 1024 || $port > 65535)) {
            throw new RuntimeException('That port is not fetched.');
        }
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            $ips = [$host];
        } else {
            $ips = [];
            foreach (@dns_get_record($host, DNS_A | DNS_AAAA) ?: [] as $r) {
                if (isset($r['ip'])) $ips[] = $r['ip'];
                if (isset($r['ipv6'])) $ips[] = $r['ipv6'];
            }
            if (!$ips) {
                $v4 = @gethostbynamel($host);
                $ips = $v4 ?: [];
            }
        }
        if (!$ips) {
            throw new RuntimeException('Could not find ' . $host . '.');
        }
        // Every address the name has must be public, not just the first: an
        // attacker's name can list a public and a private address.
        foreach ($ips as $ip) {
            if (!$allowPrivate && !self::isPublicIp($ip)) {
                throw new RuntimeException('That address is not on the public internet.');
            }
        }
        return [$host, $port, $ips[0]];
    }

    /** True for a globally routable unicast address. */
    public static function isPublicIp(string $ip): bool
    {
        // IPv4-mapped / -compatible IPv6 (::ffff:10.0.0.1) is judged as IPv4.
        if (preg_match('/^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/i', $ip, $m)) {
            $ip = $m[2];
        }
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
            return false;
        }
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $n = ip2long($ip);
            foreach ([['100.64.0.0', 10], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15],
                      ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as [$net, $bits]) {
                $mask = -1 << (32 - $bits);
                if (($n & $mask) === (ip2long($net) & $mask)) {
                    return false;
                }
            }
            return true;
        }
        $bin = inet_pton($ip);
        if ($bin === false) {
            return false;
        }
        $first = ord($bin[0]);
        // Only global unicast (2000::/3); not ULA fc00::/7, link-local fe80::/10,
        // multicast ff00::/8, documentation 2001:db8::/32, 6to4/Teredo relays.
        if (($first & 0xe0) !== 0x20) {
            return false;
        }
        $hex = bin2hex($bin);
        return !str_starts_with($hex, '20010db8') && !str_starts_with($hex, '20010000') && !str_starts_with($hex, '2002');
    }

    /** Resolve a possibly relative URL against a base; http(s) only. */
    private static function absolute(string $ref, string $base): ?string
    {
        $ref = html_entity_decode($ref, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        if (preg_match('#^https?://#i', $ref)) {
            return $ref;
        }
        $b = parse_url($base);
        if (!$b || empty($b['host'])) {
            return null;
        }
        $origin = strtolower((string)$b['scheme']) . '://' . $b['host'] . (isset($b['port']) ? ':' . $b['port'] : '');
        if (str_starts_with($ref, '//')) {
            return strtolower((string)$b['scheme']) . ':' . $ref;
        }
        if (str_starts_with($ref, '/')) {
            return $origin . $ref;
        }
        if (preg_match('#^[a-z][a-z0-9+.-]*:#i', $ref)) {
            return null; // data:, javascript: and the like are never fetched
        }
        $dir = preg_replace('#/[^/]*$#', '/', (string)($b['path'] ?? '/'));
        return $origin . $dir . $ref;
    }
}
