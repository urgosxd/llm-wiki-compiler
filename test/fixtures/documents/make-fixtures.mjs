/**
 * @file test/fixtures/documents/make-fixtures.mjs
 * @description Regenerate every binary/plain document fixture the multi-format
 * ingest tests read.
 *
 * ## Why a generator instead of committed binaries
 *
 * A committed PDF is opaque: nobody can review a diff of it, and a fixture that
 * silently drifts from what the test believes it contains is worse than no
 * fixture at all. Every file here is therefore DERIVED from visible source in
 * this script, small enough to stay under a few kilobytes, and reproducible.
 *
 * ## Layout rules
 *
 * - Paths resolve from `import.meta.url`, never from `process.cwd()`, so the
 *   script writes into its own directory no matter where it is invoked from.
 * - Output is idempotent: the .docx entries carry a FIXED modification time
 *   (`FIXTURE_MTIME`) and a fixed compression level, so re-running the script
 *   rewrites byte-identical files. Without a pinned timestamp JSZip stamps the
 *   current clock into the zip central directory and every run churns the
 *   fixture.
 * - Each fixture is a few hundred bytes to a few kilobytes. Nothing here is a
 *   multi-megabyte binary, and nothing here needs a network call.
 *
 * ## The PDFs
 *
 * `probe.pdf`, `multi.pdf` and `blank.pdf` are hand-built rather than produced
 * by a PDF library: the aim is the smallest file that a real parser
 * (`pdf-parse` -> `pdfjs-dist`) accepts while containing exactly the text each
 * test asserts on. The builder writes uncompressed objects, records the byte
 * offset of every object, and emits a correct `xref` table plus `trailer` and
 * `startxref`. `blank.pdf` is the zero-text case: a valid document whose content
 * stream holds no text operator at all, and `encrypted.pdf` adds a Standard
 * security handler so the password branch is exercised by a real parser rather
 * than mocked.
 *
 * Three fixtures exist to prove no prose is ever deleted: `prose-marker.pdf`
 * carries a lookalike outside any marker position, `lookalike-run.pdf` carries
 * one that sits exactly where a real separator would, and `coincident-marker.pdf`
 * is nothing but a lookalike. The last two are the regression pin for the
 * post-processing stripper this feature removed: any implementation that infers
 * page boundaries from the text itself eventually deletes one of them.
 *
 * Usage: `node test/fixtures/documents/make-fixtures.mjs`
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Fixed zip entry timestamp: keeps regenerated .docx bytes identical. */
const FIXTURE_MTIME = new Date(2026, 0, 1, 0, 0, 0);

/** Page geometry shared by every generated PDF (US Letter, in points). */
const MEDIA_BOX = "0 0 612 792";
/** Base font size for generated text. */
const FONT_SIZE = 18;
/** Left margin of the generated text block, in points. */
const PAGE_MARGIN_X = 72;
/** Baseline of the first generated line, in points from the page bottom. */
const PAGE_TOP_Y = 700;
/** Leading between generated lines, in points. */
const LINE_HEIGHT = 28;

/**
 * 32-byte `/O` entry (hex) of the encrypted fixture's Standard security handler.
 *
 * Revision 2 of the handler requires both `/O` and `/U` to be exactly 32 bytes;
 * pdf.js rejects the document with a FormatError instead of a PasswordException
 * when they are not, which would test the wrong branch. The bytes are pinned
 * constants rather than random so regenerating the fixture stays idempotent.
 */
const ENCRYPT_O_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

/** 32-byte `/U` entry (hex) of the same security handler. */
const ENCRYPT_U_HEX = "f0e0d0c0b0a090807060504030201000f1e1d1c1b1a191817161514131211100";

/** Escape a JavaScript string for use inside a PDF literal string object. */
function pdfString(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Build one page content stream that draws `lines` top to bottom.
 *
 * An empty `lines` array yields an empty stream: the document is still a valid
 * single page, it simply has no text operator, which is exactly the zero-text
 * case the empty-extraction rule has to reject.
 *
 * @param {string[]} lines - Text lines to draw.
 * @returns {string} Content stream body.
 */
function contentStream(lines) {
  if (lines.length === 0) return "";
  const ops = [
    "BT",
    `/F1 ${FONT_SIZE} Tf`,
    `${LINE_HEIGHT} TL`,
    `${PAGE_MARGIN_X} ${PAGE_TOP_Y} Td`,
  ];
  for (const line of lines) {
    ops.push(`(${pdfString(line)}) Tj`, "T*");
  }
  ops.push("ET");
  return ops.join("\n");
}

/**
 * Number the indirect objects of a document: catalog, page tree, then a
 * page/content pair per page, then the shared font, the info dictionary and,
 * for an encrypted document, the Standard security handler.
 *
 * @param {{pages: string[][], title: string, encrypted?: boolean}} doc - Pages
 *   (each a list of lines), the document title and whether to encrypt.
 * @returns {{objs: Map<number, string>, total: number, infoRef: number, encryptRef: number|undefined}}
 *   Object bodies keyed by object number, the highest object number, the info
 *   dictionary reference and the security-handler reference when encrypted.
 */
function pdfObjects({ pages, title, encrypted = false }) {
  const fontRef = 3 + pages.length * 2;
  const infoRef = fontRef + 1;
  const encryptRef = encrypted ? infoRef + 1 : undefined;
  const total = encryptRef ?? infoRef;
  const objs = new Map();
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objs.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objs.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);

  pages.forEach((lines, index) => {
    const contentRef = 4 + index * 2;
    objs.set(
      3 + index * 2,
      `<< /Type /Page /Parent 2 0 R /MediaBox [${MEDIA_BOX}] /Contents ${contentRef} 0 R ` +
        `/Resources << /Font << /F1 ${fontRef} 0 R >> >> >>`,
    );
    const stream = contentStream(lines);
    objs.set(
      contentRef,
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  });

  objs.set(fontRef, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.set(infoRef, `<< /Title (${pdfString(title)}) /Producer (llmwiki fixture generator) >>`);
  if (encryptRef !== undefined) {
    objs.set(
      encryptRef,
      `<< /Filter /Standard /V 1 /R 2 /O <${ENCRYPT_O_HEX}> /U <${ENCRYPT_U_HEX}> /P -1 >>`,
    );
  }
  return { objs, total, infoRef, encryptRef };
}

/**
 * Serialize numbered object bodies into a complete PDF with a correct xref
 * table, counting real byte offsets as each object is appended.
 *
 * The `/Encrypt` entry belongs in the trailer, not in the catalog, so a document
 * with a security handler is still assembled by this one function.
 *
 * @param {ReturnType<typeof pdfObjects>} doc - Numbered object bodies.
 * @returns {Buffer} The finished single-cross-reference-section PDF.
 */
function assemblePdf({ objs, total, infoRef, encryptRef }) {
  const parts = ["%PDF-1.4\n"];
  const offsets = new Map();
  let offset = Buffer.byteLength(parts[0], "latin1");

  for (let num = 1; num <= total; num++) {
    offsets.set(num, offset);
    const body = `${num} 0 obj\n${objs.get(num)}\nendobj\n`;
    parts.push(body);
    offset += Buffer.byteLength(body, "latin1");
  }

  const xref = [`xref\n0 ${total + 1}\n`, "0000000000 65535 f \n"];
  for (let num = 1; num <= total; num++) {
    xref.push(`${String(offsets.get(num)).padStart(10, "0")} 00000 n \n`);
  }
  parts.push(...xref);
  const encryptEntry = encryptRef === undefined ? "" : ` /Encrypt ${encryptRef} 0 R`;
  parts.push(
    `trailer\n<< /Size ${total + 1} /Root 1 0 R /Info ${infoRef} 0 R${encryptEntry} >>\n` +
      `startxref\n${offset}\n%%EOF\n`,
  );
  return Buffer.from(parts.join(""), "latin1");
}

/** Build a minimal single- or multi-page PDF from plain text lines. */
function buildPdf({ pages, title }) {
  return assemblePdf(pdfObjects({ pages, title }));
}

/**
 * Build the password-protected fixture the encrypted-PDF branch is tested with.
 *
 * The document is a structurally ordinary one-page PDF whose trailer points at a
 * Standard security handler (`/V 1` `/R 2`, the 40-bit revision pdf.js still
 * supports), so the parser reaches the password check instead of failing on the
 * structure. No password is supplied anywhere: the point of the fixture is the
 * refusal, not a decryption round trip.
 */
function encryptedPdf() {
  return assemblePdf(
    pdfObjects({
      pages: [["Encrypted probe sentinel golf"]],
      title: "Encrypted Probe",
      encrypted: true,
    }),
  );
}

/** Escape text for an OOXML `<w:t>` element. */
function xmlText(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** OOXML part declaring the content types of the parts we write. */
const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

/** Package-level relationships pointing at the main document part. */
const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

/**
 * Build `word/document.xml` with one `<w:p>` per paragraph.
 *
 * Paragraph boundaries matter to the tests: mammoth turns each `<w:p>` into its
 * own line, so a two-paragraph fixture is what makes "multi-paragraph text is
 * preserved" observable rather than assumed.
 *
 * @param {string[]} paragraphs - Paragraph texts, in document order.
 * @returns {string} The document part XML.
 */
function documentXml(paragraphs) {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${xmlText(text)}</w:t></w:r></w:p>`)
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}<w:sectPr/></w:body></w:document>`
  );
}

/**
 * Write a minimal but valid .docx archive.
 *
 * `createFolders: false` keeps JSZip from adding directory entries for
 * `_rels/` and `word/`. Directory entries are not part of the OOXML contract we
 * need and JSZip stamps them with the current clock, which would make the
 * regenerated archive differ from the committed one on every run.
 *
 * @param {string} filePath - Destination path.
 * @param {string[]} paragraphs - Paragraph texts, in document order.
 */
async function writeDocx(filePath, paragraphs) {
  const zip = new JSZip();
  const entry = { date: FIXTURE_MTIME, createFolders: false };
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML, entry);
  zip.file("_rels/.rels", ROOT_RELS_XML, entry);
  zip.file("word/document.xml", documentXml(paragraphs), entry);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await writeFile(filePath, buffer);
}

/** Prose body reused by the Markdown fixture, with a heading in front. */
const PROSE = [
  "A knowledge base is only as useful as the material that reaches it, and the",
  "material rarely arrives in one shape. Notes live in text files, reports arrive",
  "as PDFs, and the person who wrote the specification probably used Word. A",
  "compiler that accepts a single extension quietly narrows the corpus it was",
  "built to reason over, and the narrowing is invisible until a question is asked",
  "about a document that never made it in. The fixtures in this directory exist to",
  "keep that failure observable: each one holds a sentence whose exact wording the",
  "suite asserts on, so extraction can be checked without depending on a parser's",
  "formatting choices. They are deliberately small, generated by this script, and",
  "safe to regenerate at any time without touching the assertions that read them.",
].join(" ");

/** Markdown fixture: a heading plus prose. */
const PROBE_MD = `# Multi format probe\n\n${PROSE}\n`;

/** Plain-text fixture: prose only, no Markdown syntax. */
const PROBE_TXT = `${PROSE}\n`;

/** Arbitrary non-text bytes for the legacy binary Word (.doc) fixture. */
const LEGACY_DOC_BYTES = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00,
  0xde, 0xad, 0xbe, 0xef, 0x57, 0x4f, 0x52, 0x44, 0x00, 0x01, 0x02, 0x03,
]);

/** Arbitrary bytes carrying an extension nothing in the pipeline recognises. */
const UNKNOWN_XYZ_BYTES = Buffer.from("not a document any adapter understands\n", "utf-8");

/** Arbitrary bytes with an .xlsx extension: Excel is refused, never parsed. */
const DATA_XLSX_BYTES = Buffer.from([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x08, 0x78, 0x6c, 0x73, 0x78,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
]);

/** Bytes that are not a zip archive, saved with a .docx extension. */
const CORRUPT_DOCX_BYTES = Buffer.from(
  "this file claims to be a .docx but has no zip structure at all\n".repeat(3),
  "utf-8",
);

/** A truncated PDF: the magic header followed by garbage, about 45 bytes. */
const CORRUPT_PDF_BYTES = Buffer.from("%PDF-1.4\ntrailing garbage, no objects, no xref\n%%EO", "latin1");

/** Write every fixture, resolving each path next to this script. */
async function main() {
  const written = [];
  const write = async (name, data) => {
    await writeFile(path.join(HERE, name), data);
    written.push(name);
  };
  // Registering the .docx names through this wrapper is what keeps the reported
  // count derived: every fixture reaches `written` exactly once, from the one
  // call that wrote it, instead of being re-pushed by hand afterwards.
  const writeDocxFixture = async (name, paragraphs) => {
    await writeDocx(path.join(HERE, name), paragraphs);
    written.push(name);
  };
  await write("probe.md", PROBE_MD);
  await write("probe.txt", PROBE_TXT);
  await write(
    "probe.pdf",
    buildPdf({
      pages: [["PDF probe sentinel alpha"]],
      title: "Probe Doc Title",
    }),
  );
  await write(
    "multi.pdf",
    buildPdf({
      pages: [["PDF page one sentinel delta"], ["PDF page two sentinel echo"]],
      title: "Multi Page Probe",
    }),
  );
  await write("blank.pdf", buildPdf({ pages: [[]], title: "Blank Probe" }));
  await write(
    "prose-marker.pdf",
    buildPdf({
      pages: [["Marker lookalike below", "-- 3 of 7 --", "PDF prose sentinel hotel"]],
      title: "Prose Marker Probe",
    }),
  );
  // A lookalike where a real separator would sit: last line of page one, and it
  // reports the final page number of the same page count. No text-driven stripper
  // can tell this from a separator without also being able to delete prose.
  await write(
    "lookalike-run.pdf",
    buildPdf({
      pages: [["page one prose", "-- 2 of 2 --"], ["page two prose"]],
      title: "Lookalike Run Probe",
    }),
  );
  // Every byte of this document is a lookalike. It must survive verbatim: the
  // text is the document, and the adapter has no evidence it is anything else.
  await write(
    "coincident-marker.pdf",
    buildPdf({ pages: [["-- 1 of 1 --"]], title: "Coincident Marker Probe" }),
  );
  await write("encrypted.pdf", encryptedPdf());
  await write("corrupt.pdf", CORRUPT_PDF_BYTES);
  await writeDocxFixture("probe.docx", [
    "DOCX probe sentinel bravo",
    "DOCX probe sentinel foxtrot",
  ]);
  // A valid archive whose main document part holds no text at all: the shape a
  // blank Word export has, and the DOCX half of the empty-extraction rule.
  await writeDocxFixture("empty.docx", []);
  await write("corrupt.docx", CORRUPT_DOCX_BYTES);
  await write("legacy.doc", LEGACY_DOC_BYTES);
  await write("unknown.xyz", UNKNOWN_XYZ_BYTES);
  await write("data.xlsx", DATA_XLSX_BYTES);
  console.log(`wrote ${written.length} fixtures into ${HERE}`);
}

await main();
