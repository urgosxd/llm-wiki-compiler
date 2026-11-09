/**
 * @file test/ingest/pdf-markers.test.ts
 * @description A PDF must reach the pipeline as its own text: with no page
 * boundary injected by the parser, and with no prose deleted because a line of
 * it resembled one.
 *
 * ## The defect these tests pin
 *
 * `pdf-parse` terminates every page's text with a separator line (`-- N of M --`
 * unless told otherwise). Left in, that separator is cosmetic noise in a
 * document with real text and the ENTIRE extraction of a page that carries no
 * text operators at all — a scan, an image-only export, a broken generator — so
 * the adapter used to return `"-- 1 of 1 --"`, which is non-empty, passed the
 * shared `enforceMinContent` guard, and put a page counter into the wiki as a
 * document (S7).
 *
 * ## Why the fix is a parser option, not a stripper
 *
 * The first fix removed separators by pattern-matching the extracted text after
 * the parse, and that cannot work: the separator is plain ASCII, so prose
 * containing `-- 2 of 2 --` is indistinguishable from a real separator. That
 * stripper removed lines only when the matches formed pdf-parse's complete
 * `1..M` run, so a single lookalike line invalidated the run and EVERY real
 * separator leaked into the stored text; loosening it instead deletes prose.
 * `pageJoiner: ""` tells the parser to emit no boundary at all, which is
 * knowledge only the parser has.
 *
 * ## What these tests pin
 *
 * - Real text survives, single page and multi page, with no separator remnant.
 *   Multi page is the case a naive single-marker `replace` would miss.
 * - `blank.pdf` is pinned at BOTH layers, because that split is the design: the
 *   adapter resolves with `""` and the shared `enforceMinContent` guard rejects
 *   it with the message an operator already knows. The composition test drives
 *   the adapter's own output through the guard, so it cannot pass while the
 *   guard is bypassed.
 * - Every line of a document whose PROSE resembles a separator survives in
 *   order, including when the whole document is a lookalike. This is the
 *   regression pin for the defect above: no prose is ever deleted.
 * - `encrypted.pdf` fails with one actionable sentence — which file, and that it
 *   is password-protected — and never leaks a stack trace; `corrupt.pdf` keeps
 *   the parser's own rejection.
 *
 * ## Why nothing here snapshots a directory
 *
 * The adapter is `ingestPdf(sourcePath)`: it takes a source path and returns
 * text, and it has no destination parameter at all. A temporary directory handed
 * to such a test could never be written to, so "that directory is still empty"
 * would hold no matter what the adapter did — an assertion that cannot fail is
 * not coverage. The write-nothing guarantee that actually holds is structural
 * (adapters return text; the single transactional write lives in
 * `src/dimensions/coordinator.ts`), so these tests pin the rejection and its
 * message, which is the adapter-level half, and leave atomicity to the
 * transaction tests that own it.
 */

import { describe, it, expect } from "vitest";
import ingestPdf from "../../packages/wiki/src/ingest/pdf.js";
import { enforceCharLimit, enforceMinContent } from "../../packages/wiki/src/services/ingest/document.js";
import { fixture } from "./document-fixtures.js";

/** pdf-parse's separator syntax, for any page count. */
const PAGE_SEPARATOR = /--\s*\d+\s+of\s+\d+\s*--/;

/** Documents whose own prose looks like a page separator, with their real lines. */
const LOOKALIKE_DOCUMENTS = [
  {
    fixture: "prose-marker.pdf",
    lines: ["Marker lookalike below", "-- 3 of 7 --", "PDF prose sentinel hotel"],
  },
  {
    fixture: "lookalike-run.pdf",
    lines: ["page one prose", "-- 2 of 2 --", "page two prose"],
  },
  { fixture: "coincident-marker.pdf", lines: ["-- 1 of 1 --"] },
];

/** The non-empty lines of `content`, the unit "no prose was lost" is measured in. */
function contentLines(content: string): string[] {
  return content.split("\n").filter((line) => line.trim().length > 0);
}

describe("PDF page boundaries", () => {
  it("keeps a single page's text and emits no separator", async () => {
    const { content } = await ingestPdf(fixture("probe.pdf"));

    expect(content).toContain("PDF probe sentinel alpha");
    expect(content).not.toMatch(PAGE_SEPARATOR);
  });

  it("keeps both pages' text in order and emits no separator", async () => {
    const { content } = await ingestPdf(fixture("multi.pdf"));

    expect(content.indexOf("PDF page one sentinel delta")).toBeLessThan(
      content.indexOf("PDF page two sentinel echo"),
    );
    // Paragraph separation between pages has to survive the join, or the two
    // pages run together into one line of prose.
    expect(contentLines(content)).toEqual([
      "PDF page one sentinel delta",
      "PDF page two sentinel echo",
    ]);
    expect(content).not.toMatch(PAGE_SEPARATOR);
  });

  it("resolves empty content for a PDF whose pages carry no text at all", async () => {
    // Layer 1: the adapter RESOLVES. Emptiness is not its decision to make.
    const { content } = await ingestPdf(fixture("blank.pdf"));

    expect(content).toBe("");
  });

  it("lets the shared content guard reject the empty extraction", async () => {
    // Layer 2: the same composition the ingest pipeline runs, over the adapter's
    // own output. A text-free PDF must not become a silent zero-triplet ingest.
    const { content } = await ingestPdf(fixture("blank.pdf"));

    expect(() => enforceMinContent(enforceCharLimit(content).content)).toThrow(
      "No readable content could be extracted from the source.",
    );
  });
});

describe("PDF prose that resembles a page separator", () => {
  it.each(LOOKALIKE_DOCUMENTS)("keeps every line of $fixture, in order", async ({ fixture: name, lines }) => {
    const { content } = await ingestPdf(fixture(name));

    expect(contentLines(content)).toEqual(lines);
  });
});

describe("PDF parser failures", () => {
  it("refuses a truncated PDF with the parser's message", async () => {
    await expect(ingestPdf(fixture("corrupt.pdf"))).rejects.toThrow(/Invalid PDF structure\./);
  });

  it("names the file and the cause of a password-protected PDF, without a stack trace", async () => {
    const sourcePath = fixture("encrypted.pdf");

    const error = await ingestPdf(sourcePath).catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/password/i);
    // Which file failed is the first thing an operator needs.
    expect(error.message).toContain(sourcePath);
    // The underlying pdf.js error is a stack-bearing exception; the adapter's
    // message is what reaches the operator and must stay one sentence.
    expect(error.message).not.toMatch(/\n\s+at /);
  });
});
