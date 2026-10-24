/* Copies the attachment viewers' third-party libraries from node_modules into
   assets/vendor/, where the page loads them on demand (never from a CDN, so
   the strict CSP holds and the app works offline). Run via
   `npm run build:vendor` after `npm install` or an upgrade of these packages.

     assets/vendor/pdfjs/    PDF.js (Mozilla): pdf.min.mjs, its worker, the
                             wasm image decoders, cmaps and standard fonts
     assets/vendor/mammoth/  mammoth: .docx to HTML
     assets/vendor/libheif/  libheif (Emscripten + wasm): HEIC/HEIF decoding */
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (...p) => join(root, "node_modules", ...p);
const out = (...p) => join(root, "assets", "vendor", ...p);

const copies = [
  // PDF.js. quickjs-eval (JavaScript inside PDFs) is left out on purpose:
  // scripting is never enabled.
  [nm("pdfjs-dist", "build", "pdf.min.mjs"), out("pdfjs", "pdf.min.mjs")],
  [nm("pdfjs-dist", "build", "pdf.worker.min.mjs"), out("pdfjs", "pdf.worker.min.mjs")],
  [nm("pdfjs-dist", "wasm", "openjpeg.wasm"), out("pdfjs", "wasm", "openjpeg.wasm")],
  [nm("pdfjs-dist", "wasm", "openjpeg_nowasm_fallback.js"), out("pdfjs", "wasm", "openjpeg_nowasm_fallback.js")],
  [nm("pdfjs-dist", "wasm", "jbig2.wasm"), out("pdfjs", "wasm", "jbig2.wasm")],
  [nm("pdfjs-dist", "wasm", "jbig2_nowasm_fallback.js"), out("pdfjs", "wasm", "jbig2_nowasm_fallback.js")],
  [nm("pdfjs-dist", "wasm", "qcms_bg.wasm"), out("pdfjs", "wasm", "qcms_bg.wasm")],
  [nm("pdfjs-dist", "cmaps"), out("pdfjs", "cmaps")],
  [nm("pdfjs-dist", "standard_fonts"), out("pdfjs", "standard_fonts")],
  [nm("pdfjs-dist", "LICENSE"), out("pdfjs", "LICENSE")],
  // The wasm decoders' own notices (OpenJPEG, PDFium's JBIG2, qcms) and
  // PDF.js's licence for its builds of them.
  ...["JBIG2", "OPENJPEG", "QCMS", "PDFJS_JBIG2", "PDFJS_OPENJPEG", "PDFJS_QCMS"]
    .map((n) => [nm("pdfjs-dist", "wasm", `LICENSE_${n}`), out("pdfjs", "wasm", `LICENSE_${n}`)]),
  // mammoth
  [nm("mammoth", "mammoth.browser.min.js"), out("mammoth", "mammoth.browser.min.js")],
  [nm("mammoth", "LICENSE"), out("mammoth", "LICENSE")],
  // libheif: the loader plus its wasm (the "bundle" inlines the wasm as base64)
  [nm("libheif-js", "libheif-wasm", "libheif.js"), out("libheif", "libheif.js")],
  [nm("libheif-js", "libheif-wasm", "libheif.wasm"), out("libheif", "libheif.wasm")],
  [nm("libheif-js", "LICENSE"), out("libheif", "LICENSE")],
  // libsodium.js: sodium.js itself is built by vendor:sodium (esbuild), whose
  // minified bundle keeps no licence comment, so the ISC notice goes beside it.
  [nm("libsodium-wrappers-sumo", "LICENSE"), out("sodium.LICENSE")],
];

/* mammoth.browser.min.js is a bundle: these libraries are compiled into it,
   so their notices go beside it (mammoth/THIRD-PARTY-LICENSES.txt). Keep the
   list in step with `npm ls --all mammoth` after an upgrade. */
const mammothBundled = [
  "@xmldom/xmldom", "base64-js", "dingbat-to-unicode", "duck", "immediate", "inherits",
  "isarray", "jszip", "lie", "lop", "option", "pako", "process-nextick-args",
  "readable-stream", "safe-buffer", "setimmediate", "string_decoder", "underscore",
  "util-deprecate", "core-util-is", "xmlbuilder",
];

function bundledNotices(packages) {
  const parts = [];
  for (const name of packages) {
    const dir = nm(...name.split("/"));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f));
    const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
    const text = file
      ? readFileSync(join(dir, file), "utf8").trim()
      : `${pkg.license} licence (the package ships no licence file)${author ? `; copyright ${author}` : ""}.`;
    parts.push(`${"=".repeat(72)}\n${name} ${pkg.version} (${pkg.license})\n${"=".repeat(72)}\n\n${text}\n`);
  }
  return parts.join("\n");
}

for (const dir of ["pdfjs", "mammoth", "libheif"]) rmSync(out(dir), { recursive: true, force: true });
for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.error(`missing: ${from} (run npm install)`);
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}
writeFileSync(out("mammoth", "THIRD-PARTY-LICENSES.txt"),
  "Libraries compiled into mammoth.browser.min.js, with their licences.\n\n" + bundledNotices(mammothBundled));
console.log(`vendored ${copies.length} items into assets/vendor/{pdfjs,mammoth,libheif}`);
