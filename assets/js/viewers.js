/* AttachmentViewers — pluggable renderers for the attachment viewer overlay.

   The card dialog does not know how to show any file type. It asks this
   registry for a renderer by MIME type and file name, and hands the renderer
   a stage element and a source. Adding a type means registering one object:

     viewers.register({
       id: "sheet",                       // unique name
       icon: "📊",                        // shown in the attachment list
       match: (mime, name) => ...,        // true if this renderer can show it
       async render(stage, src, ctx) {    // draw into stage
         const bytes = await src.bytes(); // Uint8Array (decrypted if needed)
         const url = await src.url();     // same-origin URL or blob: URL
         ...
         return () => { ... };            // optional cleanup
       },
     });

   ctx.cancelled() turns true when the user moves on before render finishes,
   and ctx.status(text) shows a line in the stage while a library loads or a
   file decodes. Libraries are loaded with Vendor.script / Vendor.module the
   first time a renderer needs them, never at page load, and only from
   assets/vendor/ (the CSP allows 'self' and 'wasm-unsafe-eval', nothing more).

   Renderers are tried in registration order; the first match wins, so a more
   specific renderer registers before a general one. */

/** Loads vendored libraries once, on demand. */
const Vendor = {
  cache: new Map(),
  /** A classic script that defines a global; resolves to that global. */
  script(src, globalName) {
    const key = "s:" + src;
    if (!this.cache.has(key)) {
      this.cache.set(key, new Promise((resolve, reject) => {
        if (globalName && window[globalName]) { resolve(window[globalName]); return; }
        const el = document.createElement("script");
        el.src = src;
        el.onload = () => resolve(globalName ? window[globalName] : undefined);
        el.onerror = () => { this.cache.delete(key); reject(new Error("Could not load " + src)); };
        document.head.appendChild(el);
      }));
    }
    return this.cache.get(key);
  },
  /** An ES module; resolves to its namespace. */
  module(src) {
    const key = "m:" + src;
    if (!this.cache.has(key)) {
      const url = new URL(src, document.baseURI).href;
      this.cache.set(key, import(url).catch((e) => { this.cache.delete(key); throw e; }));
    }
    return this.cache.get(key);
  },
  /** An absolute URL for a vendored file (workers and wasm need one). */
  url(path) { return new URL(path, document.baseURI).href; },
};

class AttachmentViewers {
  constructor() { this.renderers = []; }

  register(renderer) {
    if (!renderer?.id || typeof renderer.match !== "function" || typeof renderer.render !== "function") {
      throw new Error("A viewer renderer needs id, match() and render().");
    }
    this.renderers = this.renderers.filter((r) => r.id !== renderer.id);
    this.renderers.push(renderer);
    return this;
  }

  /** The renderer for a file, or null when it cannot be shown in the page. */
  find(mime, name) {
    const m = String(mime || "").toLowerCase();
    const n = String(name || "").toLowerCase();
    return this.renderers.find((r) => r.match(m, n)) || null;
  }

  /** Lower-case extension of a file name ("" if none). */
  static ext(name) {
    const m = /\.([a-z0-9]+)$/.exec(String(name || "").toLowerCase());
    return m ? m[1] : "";
  }
}

/* ---------------------------------------------------------------------------
   Built-in renderers
   --------------------------------------------------------------------------- */

const rkViewers = new AttachmentViewers();
const ext = AttachmentViewers.ext;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// Images the browser decodes itself.
rkViewers.register({
  id: "image",
  icon: "🖼",
  match: (mime) => ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon", "image/avif"].includes(mime),
  async render(stage, src) {
    const img = el("img", "viewer-media");
    img.alt = src.name || "";
    img.src = await src.url();
    stage.replaceChildren(img);
  },
});

// HEIC / HEIF (iPhone photos). Safari shows them natively; everywhere else the
// file is decoded with libheif (WebAssembly) and drawn onto a canvas.
rkViewers.register({
  id: "heic",
  icon: "🖼",
  match: (mime, name) => ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"].includes(mime)
    || ["heic", "heif"].includes(ext(name)),
  async render(stage, src, ctx) {
    const url = await src.url();
    const native = await new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve(probe.naturalWidth > 0 ? probe : null);
      probe.onerror = () => resolve(null);
      probe.src = url;
    });
    if (ctx.cancelled()) return;
    if (native) {
      native.className = "viewer-media";
      native.alt = src.name || "";
      stage.replaceChildren(native);
      return;
    }
    ctx.status("Decoding HEIC photo…");
    await Vendor.script("assets/vendor/libheif/libheif.js", "libheif");
    // This libheif build loads its wasm synchronously, which a page cannot;
    // fetch it here and hand it over as wasmBinary.
    const lib = await (AttachmentViewers.libheifReady ??= (async () => {
      const res = await fetch(Vendor.url("assets/vendor/libheif/libheif.wasm"));
      if (!res.ok) throw new Error("Could not load the HEIC decoder.");
      const mod = window.libheif({ wasmBinary: await res.arrayBuffer() });
      return typeof mod?.then === "function" ? await mod : mod;
    })().catch((e) => { AttachmentViewers.libheifReady = null; throw e; }));
    const bytes = await src.bytes();
    if (ctx.cancelled()) return;
    const decoder = new lib.HeifDecoder();
    const images = decoder.decode(bytes);
    if (!images || !images.length) throw new Error("This HEIC file has no image in it.");
    const image = images[0];
    const w = image.get_width(), h = image.get_height();
    const canvas = el("canvas", "viewer-media");
    canvas.width = w;
    canvas.height = h;
    const c2d = canvas.getContext("2d");
    const data = c2d.createImageData(w, h);
    await new Promise((resolve, reject) => {
      image.display(data, (out) => (out ? resolve() : reject(new Error("Could not decode the HEIC photo."))));
    });
    if (ctx.cancelled()) return;
    c2d.putImageData(data, 0, 0);
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", src.name || "HEIC photo");
    stage.replaceChildren(canvas);
    return () => { images.forEach((i) => i.free?.()); decoder.free?.(); };
  },
});

rkViewers.register({
  id: "video",
  icon: "🎬",
  match: (mime) => ["video/mp4", "video/webm", "video/quicktime"].includes(mime),
  async render(stage, src) {
    const v = el("video", "viewer-media");
    v.controls = true;
    v.src = await src.url();
    stage.replaceChildren(v);
    return () => { v.pause(); v.removeAttribute("src"); v.load(); };
  },
});

rkViewers.register({
  id: "audio",
  icon: "🎵",
  match: (mime) => ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"].includes(mime),
  async render(stage, src) {
    const a = el("audio", "viewer-media");
    a.controls = true;
    a.src = await src.url();
    stage.replaceChildren(a);
    return () => { a.pause(); a.removeAttribute("src"); a.load(); };
  },
});

// PDF, rendered page by page onto canvases with PDF.js (Mozilla). Rendering
// here rather than framing the browser's viewer works on phones too, and
// needs no framing: api/file.php forbids it. Scripting and eval stay off.
rkViewers.register({
  id: "pdf",
  icon: "📄",
  match: (mime, name) => mime === "application/pdf" || ext(name) === "pdf",
  async render(stage, src, ctx) {
    ctx.status("Opening PDF…");
    const pdfjs = await Vendor.module("assets/vendor/pdfjs/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = Vendor.url("assets/vendor/pdfjs/pdf.worker.min.mjs");
    const bytes = await src.bytes();
    if (ctx.cancelled()) return;
    const task = pdfjs.getDocument({
      data: bytes.slice(), // PDF.js takes ownership of the buffer
      isEvalSupported: false,
      enableXfa: false,
      cMapUrl: Vendor.url("assets/vendor/pdfjs/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: Vendor.url("assets/vendor/pdfjs/standard_fonts/"),
      wasmUrl: Vendor.url("assets/vendor/pdfjs/wasm/"),
    });
    const doc = await task.promise;
    if (ctx.cancelled()) { doc.destroy(); return; }

    const pages = el("div", "viewer-pdf");
    pages.setAttribute("role", "document");
    stage.replaceChildren(pages);
    // Fit the page width to the stage, at the screen's pixel density.
    const avail = Math.max(240, stage.clientWidth - 24);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const slots = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const slot = el("div", "viewer-pdf-page");
      slot.dataset.page = String(n);
      slot.setAttribute("aria-label", `Page ${n} of ${doc.numPages}`);
      pages.appendChild(slot);
      slots.push(slot);
    }
    // Pages are drawn as they scroll into view, so a long PDF opens at once.
    const drawn = new Set();
    const draw = async (slot) => {
      const n = Number(slot.dataset.page);
      if (drawn.has(n) || ctx.cancelled()) return;
      drawn.add(n);
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = avail / base.width;
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = el("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
      canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
      slot.style.minHeight = "";
      slot.replaceChildren(canvas);
      await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    };
    // Reserve each page's height up front so the scrollbar is right.
    const first = await doc.getPage(1);
    const fv = first.getViewport({ scale: 1 });
    const est = Math.floor((avail / fv.width) * fv.height);
    slots.forEach((s) => { s.style.minHeight = `${est}px`; });
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) draw(e.target).catch(() => {}); });
    }, { root: stage, rootMargin: "600px 0px" });
    slots.forEach((s) => io.observe(s));
    await draw(slots[0]);
    return () => { io.disconnect(); doc.destroy(); };
  },
});

// Word documents (.docx), converted to simple HTML by mammoth: headings,
// paragraphs, emphasis, lists, tables and images. Readable, not a copy of the
// page layout. The HTML is rebuilt from an allowlist before it is shown.
rkViewers.register({
  id: "docx",
  icon: "📄",
  match: (mime, name) => mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext(name) === "docx",
  async render(stage, src, ctx) {
    ctx.status("Opening document…");
    const mammoth = await Vendor.script("assets/vendor/mammoth/mammoth.browser.min.js", "mammoth");
    const bytes = await src.bytes();
    if (ctx.cancelled()) return;
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    if (ctx.cancelled()) return;
    const page = el("div", "viewer-doc");
    page.appendChild(safeFragment(result.value || ""));
    if (!page.textContent.trim() && !page.querySelector("img")) page.appendChild(el("p", "", "This document has no text to show."));
    stage.replaceChildren(page);
  },
});

// Plain text, shown as text: never parsed as markup. Large files are cut short.
rkViewers.register({
  id: "text",
  icon: "📄",
  match: (mime, name) => ["text/plain", "text/csv", "application/json"].includes(mime) || ["txt", "md", "log", "csv", "json"].includes(ext(name)),
  async render(stage, src) {
    const LIMIT = 512 * 1024;
    const bytes = await src.bytes();
    let text = new TextDecoder().decode(bytes.subarray(0, LIMIT));
    if (bytes.length > LIMIT) text += "\n\n… (truncated; download the file to see all of it)";
    stage.replaceChildren(el("pre", "viewer-text", text));
  },
});

/**
 * Rebuild converted document HTML from an allowlist, as new DOM nodes: no
 * attribute or tag outside the list survives, links are http(s)/mailto only
 * and open in a new tab, and images must be embedded data: images.
 */
function safeFragment(html) {
  const ALLOWED = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "STRONG", "B", "EM", "I", "U", "S", "SUB", "SUP",
    "BR", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "A", "IMG", "BLOCKQUOTE", "PRE", "CODE", "SPAN", "HR"]);
  const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE", "LINK", "META", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT"]);
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const out = document.createDocumentFragment();
  const walk = (from, to) => {
    for (const node of [...from.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) { to.appendChild(document.createTextNode(node.nodeValue)); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = node.tagName;
      if (DROP.has(tag)) continue;
      if (!ALLOWED.has(tag)) { walk(node, to); continue; } // unwrap, keep the text
      const copy = document.createElement(tag.toLowerCase());
      if (tag === "A") {
        const href = node.getAttribute("href") || "";
        if (/^(https?:|mailto:)/i.test(href)) {
          copy.setAttribute("href", href);
          copy.setAttribute("target", "_blank");
          copy.setAttribute("rel", "noopener noreferrer");
        }
      } else if (tag === "IMG") {
        const s = node.getAttribute("src") || "";
        if (!/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(s)) continue;
        copy.setAttribute("src", s);
        copy.setAttribute("alt", node.getAttribute("alt") || "");
      } else if (tag === "TD" || tag === "TH") {
        for (const a of ["colspan", "rowspan"]) {
          const v = node.getAttribute(a);
          if (v && /^\d{1,3}$/.test(v)) copy.setAttribute(a, v);
        }
      }
      walk(node, copy);
      to.appendChild(copy);
    }
  };
  walk(doc.body, out);
  return out;
}

window.AttachmentViewers = AttachmentViewers;
window.rkViewers = rkViewers;
window.RKVendor = Vendor;
