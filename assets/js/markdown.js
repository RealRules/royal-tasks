/* Markdown → HTML for card descriptions.

   Descriptions come from two places: the WYSIWYG editor, which stores HTML,
   and everything typed or imported as plain text (Trello exports, PWA shares,
   anything written before the editor existed). This converts the second kind
   so it renders as styled text instead of showing its own syntax.

   SECURITY: this is a formatter, not a security boundary. Its output is
   always passed through CardModal.sanitizeToFragment() before it reaches the
   DOM, which is what drops disallowed tags and unsafe hrefs. It deliberately
   does NOT escape its input: stored text has already been through the
   server-side sanitizer, so escaping again would show "&lt;" to the user
   instead of "<". The DOM sanitizer handles whatever survives. */
class Markdown {
  /** Cheap test for "is this already HTML from the editor?" */
  static looksLikeHtml(text) {
    return /<\/?[a-zA-Z][^>]*>/.test(String(text ?? ""));
  }

  /** Only absolute http(s)/mailto links may be generated. */
  static safeHref(url) {
    const v = String(url || "").trim().replace(/[\u0000-\u0020]/g, "");
    return /^(https?:\/\/|mailto:)/i.test(v) ? v : null;
  }

  /**
   * Stored plain text has been through the server-side sanitizer, which
   * escapes &, < and > because its job is to emit HTML. Markdown has to see
   * the original characters — a quote line arrives as "&gt; text" — so decode
   * those before parsing. & is decoded last so "&amp;lt;" stays "&lt;".
   */
  static decodeEntities(text) {
    return String(text ?? "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&(?:#0*39|apos);/g, "'")
      .replace(/&#0*160;|&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  }

  /** Convert a stored plain-text/Markdown description to HTML. */
  static fromStoredText(stored) {
    return Markdown.toHtml(Markdown.decodeEntities(stored));
  }

  static toHtml(src) {
    const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let para = [];
    let quote = [];
    let fence = null;            // { lines: [] } while inside ``` ```
    const lists = [];            // stack of { tag, indent }

    const closeParagraph = () => {
      if (!para.length) return;
      // A single newline inside a paragraph stays a line break: card
      // descriptions are written as lines, not as prose that should reflow.
      out.push(`<p>${para.map((l) => Markdown.inline(l)).join("<br>")}</p>`);
      para = [];
    };
    const closeQuote = () => {
      if (!quote.length) return;
      out.push(`<blockquote>${Markdown.toHtml(quote.join("\n"))}</blockquote>`);
      quote = [];
    };
    const closeLists = (toIndent = -1) => {
      while (lists.length && lists[lists.length - 1].indent > toIndent) {
        out.push(`</li></${lists.pop().tag}>`);
      }
    };
    const closeAll = () => { closeParagraph(); closeQuote(); closeLists(); };

    for (const raw of lines) {
      const line = raw.replace(/\t/g, "    ");

      // ---- fenced code ----------------------------------------------
      const fenceMark = line.match(/^\s*```+\s*([\w-]*)\s*$/);
      if (fence) {
        if (fenceMark) {
          out.push(`<pre><code>${Markdown.escape(fence.lines.join("\n"))}</code></pre>`);
          fence = null;
        } else {
          fence.lines.push(line);
        }
        continue;
      }
      if (fenceMark) { closeAll(); fence = { lines: [] }; continue; }

      // ---- blank line: ends paragraphs and quotes --------------------
      if (!line.trim()) { closeParagraph(); closeQuote(); continue; }

      // ---- blockquote ------------------------------------------------
      const bq = line.match(/^\s{0,3}>\s?(.*)$/);
      if (bq) { closeParagraph(); closeLists(); quote.push(bq[1]); continue; }
      closeQuote();

      // ---- horizontal rule -------------------------------------------
      if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) { closeAll(); out.push("<hr>"); continue; }

      // ---- heading ----------------------------------------------------
      const head = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (head) {
        closeAll();
        // The sanitizer allows h1–h3; deeper levels render as h3.
        const level = Math.min(head[1].length, 3);
        out.push(`<h${level}>${Markdown.inline(head[2])}</h${level}>`);
        continue;
      }

      // ---- list item ---------------------------------------------------
      const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (item) {
        closeParagraph();
        const indent = item[1].length;
        const tag = /^\d/.test(item[2]) ? "ol" : "ul";
        closeLists(indent);
        const top = lists[lists.length - 1];
        if (!top || top.indent < indent) {
          lists.push({ tag, indent });
          out.push(`<${tag}><li>`);
        } else {
          if (top.tag !== tag) {
            // Switching bullet style at the same depth starts a new list.
            out.push(`</li></${lists.pop().tag}>`);
            lists.push({ tag, indent });
            out.push(`<${tag}><li>`);
          } else {
            out.push("</li><li>");
          }
        }
        out.push(Markdown.inline(item[3]));
        continue;
      }

      // A plain line directly under a list item continues that item.
      if (lists.length && /^\s+\S/.test(line)) { out.push("<br>" + Markdown.inline(line.trim())); continue; }
      closeLists();

      // ---- paragraph ----------------------------------------------------
      para.push(line.trim());
    }

    if (fence) out.push(`<pre><code>${Markdown.escape(fence.lines.join("\n"))}</code></pre>`);
    closeAll();
    return out.join("");
  }

  static escape(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  /**
   * Inline spans.
   *
   * The text is escaped first, so the only tags in the result are the ones
   * this function creates: a literal "<tag>" typed by the user stays visible
   * text instead of becoming markup. Code spans are lifted out next so
   * nothing rewrites their contents.
   */
  static inline(text) {
    const code = [];
    let s = Markdown.escape(text).replace(/`([^`]+)`/g, (m, body) => {
      code.push(`<code>${body}</code>`);
      return `\u0000${code.length - 1}\u0000`;
    });

    // [label](url) — the scheme is checked here and again by the sanitizer.
    // The URL may itself contain a balanced pair of parentheses, as plenty
    // of Wikipedia links do: .../Foo_(disambiguation)
    s = s.replace(/\[([^\]]*)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\s*\)/g, (m, label, url) => {
      const href = Markdown.safeHref(url);
      const text = label || url;
      return href ? `<a href="${href}">${text}</a>` : text;
    });

    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>");
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    // Single * / _ only when they hug the word, so a*b and snake_case survive.
    s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");

    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => code[Number(i)]);
  }
}
window.Markdown = Markdown;
