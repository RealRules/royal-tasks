# Credits

Royal Tasks is developed by **Jesper Juul**. © 2026 Jesper Juul.

It stands on the work of many open-source authors. Thank you.

This file lists every third-party component the app ships or uses to build,
with its licence. Where a licence requires its notice to travel with the code,
that notice is shipped beside the files it covers (the last column).

## Shipped with the app

These run in the user's browser. They live in `assets/vendor/`, are copied
there from `node_modules` by `npm run build:vendor`, and load only when they
are needed: never from a CDN.

| Component | Version | What it does here | Licence | Notice |
| --- | --- | --- | --- | --- |
| [libsodium](https://libsodium.org) by Frank Denis, via [libsodium.js](https://github.com/jedisct1/libsodium.js) by Ahmad Ben Mrad, Frank Denis and Ryan Lester | 0.8.4 | End-to-end encryption of boards: XChaCha20-Poly1305 and Argon2id | ISC | `assets/vendor/sodium.LICENSE` |
| [PDF.js](https://mozilla.github.io/pdf.js/) by Mozilla and contributors | 6.3.289 | Shows PDF attachments | Apache-2.0 | `assets/vendor/pdfjs/LICENSE` |
| [mammoth](https://github.com/mwilliamson/mammoth.js) by Michael Williamson | 1.13.0 | Shows Word (.docx) attachments | BSD-2-Clause | `assets/vendor/mammoth/LICENSE` |
| [libheif](https://github.com/strukturag/libheif) by struktur AG, via [libheif-js](https://github.com/catdad-experiments/libheif-js) by Kiril Vatev | 1.23.2 | Shows HEIC/HEIF photos where the browser cannot | LGPL-3.0 | `assets/vendor/libheif/LICENSE` |
| [Tailwind CSS](https://tailwindcss.com) by Tailwind Labs | 4.3.3 | The stylesheet is compiled with it, including its base styles (Preflight) | MIT | Kept in the header of `assets/css/app.css` |

### Inside PDF.js

| Component | What it does | Licence | Notice |
| --- | --- | --- | --- |
| [OpenJPEG](https://www.openjpeg.org) | JPEG 2000 images in PDFs (`wasm/openjpeg.wasm`) | BSD-2-Clause | `assets/vendor/pdfjs/wasm/LICENSE_OPENJPEG` |
| JBIG2 decoder from [PDFium](https://pdfium.googlesource.com/pdfium/), by the PDFium Authors | JBIG2 images in PDFs (`wasm/jbig2.wasm`) | BSD-3-Clause | `assets/vendor/pdfjs/wasm/LICENSE_JBIG2` |
| [qcms](https://github.com/FirefoxGraphics/qcms) by Mozilla Corporation and Marti Maria | Colour management (`wasm/qcms_bg.wasm`) | MIT | `assets/vendor/pdfjs/wasm/LICENSE_QCMS` |
| Adobe CMap resources, © Adobe Systems Incorporated | Character maps for CJK text (`cmaps/`) | BSD-3-Clause | `assets/vendor/pdfjs/cmaps/LICENSE` |
| Foxit standard fonts, © PDFium Authors | Stand-in fonts (`standard_fonts/Foxit*`) | BSD-3-Clause | `assets/vendor/pdfjs/standard_fonts/LICENSE_FOXIT` |
| Liberation Sans, © Red Hat, Inc. | Stand-in fonts (`standard_fonts/Liberation*`) | GPL-2.0 with the font exception | `assets/vendor/pdfjs/standard_fonts/LICENSE_LIBERATION` |

PDF.js's builds of the three decoders are under Apache-2.0
(`assets/vendor/pdfjs/wasm/LICENSE_PDFJS_*`).

### Inside mammoth

`mammoth.browser.min.js` is a bundle with these libraries compiled into it.
Their licence texts are collected in
`assets/vendor/mammoth/THIRD-PARTY-LICENSES.txt`.

| Component | Licence |
| --- | --- |
| [JSZip](https://stuk.github.io/jszip/) by Stuart Knightley and contributors | MIT or GPL-3.0 (used here under MIT) |
| [pako](https://github.com/nodeca/pako) by Vitaly Puzrin and Andrei Tuputcyn | MIT and Zlib |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | MIT |
| [Underscore.js](https://underscorejs.org) by Jeremy Ashkenas | MIT |
| [xmlbuilder](https://github.com/oozcitak/xmlbuilder-js) by Ozgur Ozcitak | MIT |
| [base64-js](https://github.com/beatgammit/base64-js) by T. Jameson Little | MIT |
| [lop](https://github.com/mwilliamson/lop), [option](https://github.com/mwilliamson/node-options), [duck](https://github.com/mwilliamson/duck.js), [dingbat-to-unicode](https://github.com/mwilliamson/dingbat-to-unicode) by Michael Williamson | BSD-2-Clause |
| [lie](https://github.com/calvinmetcalf/lie), [immediate](https://github.com/calvinmetcalf/immediate), [setimmediate](https://github.com/YuzuJS/setImmediate) | MIT |
| [readable-stream](https://github.com/nodejs/readable-stream) and its helpers (core-util-is, inherits, isarray, process-nextick-args, safe-buffer, string_decoder, util-deprecate) | MIT, inherits under ISC |
| Browserify's [buffer](https://github.com/feross/buffer) and [ieee754](https://github.com/feross/ieee754) shims by Feross Aboukhadijeh | MIT, BSD-3-Clause |

### libheif and the LGPL

libheif and the HEVC decoder compiled into it,
[libde265](https://github.com/strukturag/libde265) 1.0.15 by struktur AG,
are licensed under the GNU Lesser General Public License, version 3. Royal
Tasks does not modify them, links them only at run time, and loads them as
separate files (`assets/vendor/libheif/libheif.js` and `libheif.wasm`). You may
replace those two files with your own build. The source is available from the
libheif, libde265 and libheif-js projects linked above.

## Used to build and test (not shipped)

| Tool | Licence | Used for |
| --- | --- | --- |
| [Tailwind CSS CLI](https://tailwindcss.com) (`@tailwindcss/cli`) | MIT | Compiling `styles/app.css` |
| [esbuild](https://esbuild.github.io) by Evan Wallace | MIT | Bundling libsodium.js into `assets/vendor/sodium.js` |
| [Puppeteer](https://pptr.dev) (`puppeteer-core`) by Google | Apache-2.0 | The browser tests, run against an installed Chrome |

## Runs on

[PHP](https://www.php.net) and [MySQL](https://www.mysql.com) or
[MariaDB](https://mariadb.org). They are not part of this repository.

## The rest

Royal Tasks itself is licensed under the Apache License, Version 2.0
([LICENSE](LICENSE), [NOTICE](NOTICE)). Everything else, the PHP backend, the JavaScript app and the S3 backup
script (including its AWS Signature Version 4 signing), was written for
Royal Tasks. The emoji in the interface come from the viewer's own system
fonts; none are bundled.
