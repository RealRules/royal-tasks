<?php
declare(strict_types=1);

/**
 * Sends the app's email: plain text, UTF-8, to one recipient at a time.
 *
 * Configured by the `mail` section of config.php (see config.example.php):
 *
 *   'transport' => 'auto' | 'smtp' | 'mail' | 'sendmail' | 'none'
 *   'from'      => 'noreply@example.com',    the sender address
 *   'from_name' => 'Royal Tasks',
 *   'smtp'      => ['host', 'port', 'secure' => 'tls'|'ssl'|'', 'username',
 *                   'password', 'timeout'],
 *   'sendmail'  => '/usr/sbin/sendmail',     the program, for 'sendmail'
 *   'log_dir'   => '/path',                  for 'log': nothing is sent, each
 *                                            message is written there as a .eml
 *                                            file (testing a site without mail;
 *                                            also ROYAL_KANBAN_MAIL_LOG=/path)
 *
 * 'auto' (the default, also with no mail section at all) takes the first
 * that can work here: SMTP when a host is set, else PHP's mail() when the
 * server has a mail program for it, else a sendmail program run directly,
 * else nothing. Without 'from' the sender is noreply@ the app's own domain.
 *
 * 'mail' hands the message to PHP's mail() (the server's own sendmail);
 * 'sendmail' runs the program itself (sendmail -t -i), for hosts where
 * mail() is switched off; 'smtp' talks to a mail server itself: STARTTLS on
 * 'tls' (port 587), TLS from the start on 'ssl' (465), AUTH PLAIN or LOGIN
 * when a username is set. Certificates are verified. Errors are thrown as
 * RuntimeException with the server's reply, never with the password.
 */
final class Mailer
{
    /**
     * @param array<string,mixed> $cfg
     * @param string $appHost the app's own host name, for the default sender
     */
    public function __construct(private array $cfg, private string $appHost = '')
    {
    }

    public static function fromConfig(string $appHost = ''): self
    {
        return new self(defined('RK_MAIL_CONFIG') && is_array(RK_MAIL_CONFIG) ? RK_MAIL_CONFIG : [], $appHost);
    }

    /** The transport in use: the configured one, or for 'auto' the first that can work here. */
    public function transport(): string
    {
        $t = strtolower((string)($this->cfg['transport'] ?? 'auto'));
        if (in_array($t, ['smtp', 'mail', 'sendmail', 'log', 'none'], true)) {
            return $t;
        }
        if (trim((string)(((array)($this->cfg['smtp'] ?? []))['host'] ?? '')) !== '') {
            return 'smtp';
        }
        if (self::mailWorks()) {
            return 'mail';
        }
        if ($this->sendmailPath() !== null) {
            return 'sendmail';
        }
        return 'none';
    }

    /** Whether PHP's mail() has something to hand mail to on this server. */
    private static function mailWorks(): bool
    {
        if (!function_exists('mail') || self::disabled('mail')) {
            return false;
        }
        if (PHP_OS_FAMILY === 'Windows') {
            // mail() on Windows talks SMTP to ini SMTP/smtp_port; "localhost"
            // is the default and rarely a mail server.
            $host = (string)ini_get('SMTP');
            return $host !== '' && strtolower($host) !== 'localhost';
        }
        $prog = strtok((string)ini_get('sendmail_path'), ' ');
        return $prog !== false && $prog !== '' && @is_executable($prog);
    }

    /** The sendmail program to run directly, or null when there is none (or no way to run it). */
    private function sendmailPath(): ?string
    {
        if (!function_exists('proc_open') || self::disabled('proc_open') || PHP_OS_FAMILY === 'Windows') {
            return null;
        }
        foreach ([(string)($this->cfg['sendmail'] ?? ''), '/usr/sbin/sendmail', '/usr/lib/sendmail'] as $p) {
            if ($p !== '' && @is_executable($p)) {
                return $p;
            }
        }
        return null;
    }

    private static function disabled(string $fn): bool
    {
        return in_array($fn, array_map('trim', explode(',', (string)ini_get('disable_functions'))), true);
    }

    /** The sender: the configured address, else noreply@ the app's domain. */
    private function from(): ?string
    {
        $from = self::cleanAddress((string)($this->cfg['from'] ?? ''));
        if ($from !== null) {
            return $from;
        }
        $host = strtolower(preg_replace('/^www\./i', '', preg_replace('/:\d+$/', '', $this->appHost)) ?? '');
        if ($host === '' || !str_contains($host, '.') || filter_var($host, FILTER_VALIDATE_IP)) {
            return null;
        }
        return self::cleanAddress('noreply@' . $host);
    }

    public function configured(): bool
    {
        return $this->transport() !== 'none' && $this->from() !== null;
    }

    /** One line saying how mail goes out, for an administrator (no secrets). */
    public function describe(): string
    {
        $auto = strtolower((string)($this->cfg['transport'] ?? 'auto')) === 'auto' ? ' (found automatically)' : '';
        if ($this->transport() === 'none') {
            return 'Email is not set up: this server has no way to send it that the app could find (config.php, the "mail" section).';
        }
        if ($this->from() === null) {
            return 'Email needs a sender address: set "from" in the mail section of config.php.';
        }
        $from = $this->from();
        return match ($this->transport()) {
            'mail' => "Sent with PHP mail(){$auto} from {$from}.",
            'sendmail' => "Sent with the server's sendmail{$auto} from {$from}.",
            'log' => "Not sent: written as files to a folder, for testing (log_dir), from {$from}.",
            default => (function () use ($from, $auto) {
                $s = (array)($this->cfg['smtp'] ?? []);
                return 'Sent through ' . ($s['host'] ?? '?') . ':' . (int)($s['port'] ?? 587)
                    . ' (' . (($s['secure'] ?? 'tls') ?: 'no encryption') . "){$auto} from {$from}.";
            })(),
        };
    }

    public function send(string $to, string $subject, string $text): void
    {
        if (!$this->configured()) {
            throw new RuntimeException($this->describe());
        }
        $toAddr = self::cleanAddress($to);
        if ($toAddr === null) {
            throw new RuntimeException('That is not an email address.');
        }
        $from = $this->from();
        $fromName = self::oneLine((string)($this->cfg['from_name'] ?? 'Royal Tasks'));
        $subject = self::oneLine($subject);
        $domain = substr((string)strrchr($from, '@'), 1) ?: 'localhost';
        $headers = [
            'Date' => date(DATE_RFC2822),
            'From' => self::encodeWord($fromName) . ' <' . $from . '>',
            'To' => '<' . $toAddr . '>',
            'Subject' => self::encodeWord($subject),
            'Message-ID' => '<' . bin2hex(random_bytes(12)) . '@' . $domain . '>',
            'MIME-Version' => '1.0',
            'Content-Type' => 'text/plain; charset=UTF-8',
            'Content-Transfer-Encoding' => 'base64',
        ];
        $body = rtrim(chunk_split(base64_encode(str_replace(["\r\n", "\r"], "\n", $text)), 76, "\r\n"));

        if ($this->transport() === 'mail') {
            $extra = [];
            foreach ($headers as $k => $v) {
                if ($k !== 'To' && $k !== 'Subject') {
                    $extra[] = "$k: $v";
                }
            }
            if (!@mail($toAddr, $headers['Subject'], $body, implode("\r\n", $extra), '-f' . $from)) {
                throw new RuntimeException('PHP mail() refused the message.');
            }
            return;
        }

        $lines = [];
        foreach ($headers as $k => $v) {
            $lines[] = "$k: $v";
        }
        $message = implode("\r\n", $lines) . "\r\n\r\n" . $body;
        if ($this->transport() === 'sendmail') {
            $this->sendmail($from, $message);
            return;
        }
        if ($this->transport() === 'log') {
            $dir = rtrim((string)($this->cfg['log_dir'] ?? sys_get_temp_dir()), '/\\');
            if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
                throw new RuntimeException('The mail log folder cannot be made.');
            }
            $name = $dir . DIRECTORY_SEPARATOR . gmdate('Ymd-His') . '-' . bin2hex(random_bytes(4)) . '.eml';
            if (@file_put_contents($name, $message, LOCK_EX) === false) {
                throw new RuntimeException('The mail log folder cannot be written.');
            }
            return;
        }
        $this->smtp($from, $toAddr, $message);
    }

    /** Hand the message to sendmail: -t reads the recipient from the To header, -i keeps lone dots. */
    private function sendmail(string $from, string $message): void
    {
        $prog = $this->sendmailPath();
        if ($prog === null) {
            throw new RuntimeException('No sendmail program was found on this server.');
        }
        $p = proc_open([$prog, '-t', '-i', '-f', $from], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($p)) {
            throw new RuntimeException('Could not run sendmail.');
        }
        fwrite($pipes[0], str_replace("\r\n", "\n", $message));
        fclose($pipes[0]);
        $err = trim((string)stream_get_contents($pipes[2]));
        fclose($pipes[1]);
        fclose($pipes[2]);
        if (proc_close($p) !== 0) {
            throw new RuntimeException('sendmail refused the message' . ($err !== '' ? ': ' . mb_substr($err, 0, 200) : '.'));
        }
    }

    /** An address without names, angle brackets or line breaks, or null. */
    private static function cleanAddress(string $a): ?string
    {
        $a = trim($a);
        if ($a === '' || preg_match('/[\r\n<>]/', $a) || strlen($a) > 254 || filter_var($a, FILTER_VALIDATE_EMAIL) === false) {
            return null;
        }
        return $a;
    }

    /** A header value on one line: line breaks would start a new header. */
    private static function oneLine(string $s): string
    {
        return trim(preg_replace('/[\r\n]+/', ' ', $s));
    }

    /** RFC 2047 when the value is not plain ASCII. */
    private static function encodeWord(string $s): string
    {
        return preg_match('/^[\x20-\x7e]*$/', $s) ? $s : '=?UTF-8?B?' . base64_encode($s) . '?=';
    }

    // ---- SMTP ----------------------------------------------------------

    /** @var resource|null */
    private $sock = null;

    private function smtp(string $from, string $to, string $message): void
    {
        $s = (array)($this->cfg['smtp'] ?? []);
        $host = trim((string)($s['host'] ?? ''));
        if ($host === '') {
            throw new RuntimeException('Set mail.smtp.host in config.php.');
        }
        $secure = strtolower((string)($s['secure'] ?? 'tls'));
        $port = (int)($s['port'] ?? ($secure === 'ssl' ? 465 : 587));
        $timeout = max(5, (int)($s['timeout'] ?? 20));
        $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'SNI_enabled' => true, 'peer_name' => $host]]);
        $errno = 0;
        $errstr = '';
        $sock = @stream_socket_client(($secure === 'ssl' ? 'ssl://' : 'tcp://') . $host . ':' . $port, $errno, $errstr, $timeout, STREAM_CLIENT_CONNECT, $ctx);
        if (!$sock) {
            throw new RuntimeException("Could not reach the mail server $host:$port ($errstr).");
        }
        $this->sock = $sock;
        stream_set_timeout($sock, $timeout);
        try {
            $this->expect([220]);
            $me = preg_replace('/[^A-Za-z0-9.\-]/', '', (string)gethostname()) ?: 'localhost';
            $caps = $this->cmd("EHLO $me", [250]);
            if ($secure === 'tls') {
                $this->cmd('STARTTLS', [220]);
                if (!@stream_socket_enable_crypto($sock, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                    throw new RuntimeException('The TLS handshake with the mail server failed (STARTTLS).');
                }
                $caps = $this->cmd("EHLO $me", [250]);
            }
            $user = (string)($s['username'] ?? '');
            if ($user !== '') {
                $pass = (string)($s['password'] ?? '');
                if (preg_match('/AUTH[ =][^\r\n]*PLAIN/i', $caps)) {
                    $this->cmd('AUTH PLAIN ' . base64_encode("\0$user\0$pass"), [235], 'AUTH PLAIN ***');
                } else {
                    $this->cmd('AUTH LOGIN', [334]);
                    $this->cmd(base64_encode($user), [334], '(username)');
                    $this->cmd(base64_encode($pass), [235], '(password)');
                }
            }
            $this->cmd("MAIL FROM:<$from>", [250]);
            $this->cmd("RCPT TO:<$to>", [250, 251]);
            $this->cmd('DATA', [354]);
            // Dot-stuffing: a line that starts with "." gets another one.
            $data = preg_replace('/^\./m', '..', str_replace(["\r\n", "\r"], "\n", $message));
            $this->cmd(str_replace("\n", "\r\n", $data) . "\r\n.", [250], '(message)');
            $this->cmd('QUIT', [221]);
        } finally {
            @fclose($sock);
            $this->sock = null;
        }
    }

    /** Send a line and check the reply code; `$shown` replaces it in errors. */
    private function cmd(string $line, array $ok, ?string $shown = null): string
    {
        fwrite($this->sock, $line . "\r\n");
        return $this->expect($ok, $shown ?? $line);
    }

    /** Read a (multi-line) reply; throw unless its code is one of $ok. */
    private function expect(array $ok, string $after = 'connecting'): string
    {
        $reply = '';
        while (($l = fgets($this->sock, 2048)) !== false) {
            $reply .= $l;
            if (strlen($l) < 4 || $l[3] !== '-') {
                break;
            }
        }
        $code = (int)substr($reply, 0, 3);
        if (!in_array($code, $ok, true)) {
            $meta = stream_get_meta_data($this->sock);
            $why = $reply === '' ? (!empty($meta['timed_out']) ? 'no answer (timed out)' : 'the connection closed') : trim($reply);
            throw new RuntimeException("The mail server refused {$after}: {$why}");
        }
        return $reply;
    }
}
