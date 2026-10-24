<?php
declare(strict_types=1);

/**
 * Allowlist HTML sanitizer built on a real parser.
 *
 * The previous regex-based guard could be walked past with markup the regex
 * did not model (`<svg/onload=...>` needs no whitespace before the handler).
 * Parsing the document and rebuilding it from an allowlist removes that whole
 * class of bypass: anything not explicitly permitted cannot survive.
 */
final class HtmlSanitizer
{
    /** tag => allowed attributes */
    private const ALLOWED = [
        'a' => ['href', 'title'],
        'b' => [], 'strong' => [], 'i' => [], 'em' => [], 'u' => [],
        's' => [], 'strike' => [], 'del' => [],
        'p' => [], 'br' => [], 'hr' => [],
        'ul' => [], 'ol' => [], 'li' => [],
        'h1' => [], 'h2' => [], 'h3' => [],
        'blockquote' => [], 'pre' => [], 'code' => [],
        'div' => [], 'span' => [],
    ];

    /** Elements dropped with their entire subtree. */
    private const DROP_SUBTREE = [
        'script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
        'button', 'select', 'textarea', 'link', 'meta', 'base', 'svg',
        'math', 'template', 'noscript', 'frame', 'frameset', 'applet',
    ];

    public static function clean(string $html): string
    {
        $html = trim($html);
        if ($html === '') {
            return '';
        }
        if (!class_exists('DOMDocument')) {
            // Without ext-dom we cannot parse safely, so emit text only.
            return htmlspecialchars(strip_tags($html), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        }

        $doc = new DOMDocument('1.0', 'UTF-8');
        $previous = libxml_use_internal_errors(true);
        // The meta charset keeps DOMDocument from mangling UTF-8; the wrapper
        // div gives us a single, predictable root to serialise from.
        $loaded = $doc->loadHTML(
            '<?xml encoding="UTF-8"?><html><body><div id="rk-root">' . $html . '</div></body></html>',
            LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING
        );
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
        if (!$loaded) {
            return '';
        }

        $root = $doc->getElementById('rk-root');
        if (!$root) {
            $divs = $doc->getElementsByTagName('div');
            $root = $divs->length > 0 ? $divs->item(0) : null;
        }
        if (!$root instanceof DOMElement) {
            return '';
        }

        self::cleanNode($root);

        $out = '';
        foreach ($root->childNodes as $child) {
            $out .= $doc->saveHTML($child);
        }
        return trim($out);
    }

    private static function cleanNode(DOMNode $node): void
    {
        // Iterate over a snapshot: we mutate the live child list below.
        $children = [];
        foreach ($node->childNodes as $child) {
            $children[] = $child;
        }

        foreach ($children as $child) {
            if ($child instanceof DOMComment) {
                $child->parentNode?->removeChild($child);
                continue;
            }
            if ($child instanceof DOMText) {
                continue; // text is escaped on serialisation
            }
            if (!$child instanceof DOMElement) {
                $child->parentNode?->removeChild($child); // CDATA, PIs, ...
                continue;
            }

            $tag = strtolower($child->nodeName);

            if (in_array($tag, self::DROP_SUBTREE, true)) {
                $child->parentNode?->removeChild($child);
                continue;
            }

            if (!array_key_exists($tag, self::ALLOWED)) {
                // Unknown but harmless wrapper: keep the text, drop the tag.
                self::cleanNode($child);
                self::unwrap($child);
                continue;
            }

            self::cleanAttributes($child, $tag);
            self::cleanNode($child);
        }
    }

    private static function cleanAttributes(DOMElement $el, string $tag): void
    {
        $allowed = self::ALLOWED[$tag];
        $names = [];
        foreach ($el->attributes as $attr) {
            $names[] = $attr->nodeName;
        }
        foreach ($names as $name) {
            $lower = strtolower($name);
            if (!in_array($lower, $allowed, true)) {
                $el->removeAttribute($name);
                continue;
            }
            if ($lower === 'href') {
                $value = trim($el->getAttribute($name));
                if (!self::isSafeUrl($value)) {
                    $el->removeAttribute($name);
                    continue;
                }
                $el->setAttribute('href', $value);
            }
        }
        if ($tag === 'a' && $el->hasAttribute('href')) {
            // Links open away from the app and cannot reach back via opener.
            $el->setAttribute('target', '_blank');
            $el->setAttribute('rel', 'noopener noreferrer');
        }
    }

    /**
     * Only absolute http(s) and mailto URLs. Rejects javascript:, data:,
     * vbscript: and anything obfuscated with control characters or entities.
     */
    public static function isSafeUrl(string $url): bool
    {
        $normalised = preg_replace('/[\x00-\x20]|&#[xX]?0*(9|10|13|A|D);?/i', '', $url) ?? '';
        return (bool)preg_match('#^(https?://|mailto:)#i', $normalised);
    }

    private static function unwrap(DOMElement $el): void
    {
        $parent = $el->parentNode;
        if (!$parent) {
            return;
        }
        while ($el->firstChild) {
            $parent->insertBefore($el->firstChild, $el);
        }
        $parent->removeChild($el);
    }
}
