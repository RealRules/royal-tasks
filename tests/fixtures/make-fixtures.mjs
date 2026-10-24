// Builds the sample files the viewer tests open: sample.pdf, sample.docx and
// sample.heic, next to this script. The outputs are committed, so the tests
// never need this; run it only to regenerate them:
//   node tests/fixtures/make-fixtures.mjs
// sample.heic needs ffmpeg with libx265 on PATH (for the HEVC image itself);
// the HEIF container around it is written here.
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ---- PDF: two pages of text, hand-written (offsets computed) ----------------
function pdf() {
  const objs = [];
  const page = (text, n) => `BT /F1 28 Tf 72 700 Td (${text}) Tj ET BT /F1 14 Tf 72 660 Td (Page ${n} of 2) Tj ET`;
  const c1 = page('Royal Tasks PDF sample', 1), c2 = page('Second page', 2);
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>');
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>');
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>');
  objs.push(`<< /Length ${c1.length} >>\nstream\n${c1}\nendstream`);
  objs.push(`<< /Length ${c2.length} >>\nstream\n${c2}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---- DOCX: heading, paragraph with bold, a list-ish line and a table -------
async function docx() {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${p('Royal Tasks DOCX sample', 'Heading1')}
<w:p><w:r><w:t xml:space="preserve">A paragraph with </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold text</w:t></w:r><w:r><w:t xml:space="preserve"> in it.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
${p('&lt;script&gt;alert(1)&lt;/script&gt; stays text')}
</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ---- HEIC: an HEVC still in a minimal HEIF container ------------------------
function box(type, ...parts) {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}
const full = (type, version, flags, ...parts) => {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, vf, ...parts);
};
const u8 = (v) => Buffer.from([v]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };

function heic() {
  const tmp = mkdtempSync(join(tmpdir(), 'rkheic-'));
  const raw = join(tmp, 'frame.hevc');
  const W = 96, H = 64;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${W}x${H}:rate=1`,
    '-frames:v', '1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error:repeat-headers=1', '-f', 'hevc', raw]);
  const annexB = readFileSync(raw);
  rmSync(tmp, { recursive: true, force: true });
  // Split Annex B into NAL units.
  const nals = [];
  let i = 0, start = -1;
  while (i + 3 <= annexB.length) {
    const sc3 = annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1;
    const sc4 = annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 0 && annexB[i + 3] === 1;
    if (sc3 || sc4) {
      if (start >= 0) nals.push(annexB.subarray(start, i));
      i += sc4 ? 4 : 3;
      start = i;
    } else i++;
  }
  if (start >= 0) nals.push(annexB.subarray(start));
  const typeOf = (n) => (n[0] >> 1) & 0x3f;
  const ps = { 32: [], 33: [], 34: [] };
  const slices = [];
  for (const n of nals) {
    const t = typeOf(n);
    if (ps[t]) ps[t].push(n);
    else if (t < 32) slices.push(n);
  }
  // hvcC: profile fields are copied from the SPS's profile_tier_level.
  const sps = ps[33][0];
  const ptl = sps.subarray(3, 15); // after 2-byte NAL header + 1 byte (vps id, max_sub_layers, nesting)
  const hvcC = box('hvcC',
    u8(1), ptl.subarray(0, 1), ptl.subarray(1, 5), ptl.subarray(5, 11), ptl.subarray(11, 12),
    u16(0xf000), u8(0xfc), u8(0xfd), u8(0xf8), u8(0xf8), u16(0), u8(0x0f),
    u8(3),
    ...[32, 33, 34].map((t) => Buffer.concat([u8(0x80 | t), u16(ps[t].length), ...ps[t].map((n) => Buffer.concat([u16(n.length), n]))])));
  const data = Buffer.concat(slices.map((n) => Buffer.concat([u32(n.length), n])));
  const ftyp = box('ftyp', 'heic', u32(0), 'mif1', 'heic');
  const build = (offset) => full('meta', 0, 0,
    full('hdlr', 0, 0, u32(0), 'pict', u32(0), u32(0), u32(0), u8(0)),
    full('pitm', 0, 0, u16(1)),
    full('iinf', 0, 0, u16(1), full('infe', 2, 0, u16(1), u16(0), 'hvc1', u8(0))),
    full('iloc', 0, 0, u8(0x44), u8(0x00), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(data.length)),
    box('iprp', box('ipco', hvcC, full('ispe', 0, 0, u32(W), u32(H))), full('ipma', 0, 0, u32(1), u16(1), u8(2), u8(0x81), u8(0x02))));
  const meta0 = build(0);
  const offset = ftyp.length + meta0.length + 8; // mdat header
  return Buffer.concat([ftyp, build(offset), box('mdat', data)]);
}

writeFileSync(join(here, 'sample.pdf'), pdf());
writeFileSync(join(here, 'sample.docx'), await docx());
try {
  writeFileSync(join(here, 'sample.heic'), heic());
} catch (e) {
  console.warn('sample.heic not rebuilt (needs ffmpeg with libx265):', e.message);
}
console.log('fixtures written to', here);
