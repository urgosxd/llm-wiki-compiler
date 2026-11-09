/**
 * @file test/ingest/docx-adapter.test.ts
 * @description How a `.docx` document must reach the pipeline: as plain text,
 * whole, with a title, and never as a crash.
 *
 * ## Why a `.docx` needs its own adapter
 *
 * A `.docx` is a zip container holding OOXML parts, so reading it as UTF-8 text
 * yields binary noise and detecting it by content is pointless — the extension
 * is the only cheap signal. That is why the format gets a dispatch entry
 * (`SourceType` gains `"docx"`) and one adapter, `src/ingest/docx.ts`, instead
 * of a new branch inside `src/ingest/file.ts` (S5: one seam, no per-format
 * pipeline fork).
 *
 * ## What these tests pin
 *
 * 1. **Multi-paragraph text survives.** Extraction that keeps only the first
 *    paragraph loses the document while looking successful, so the fixture holds
 *    two sentences and both must arrive, in order.
 * 2. **The title follows the shared contract.** Every adapter derives its title
 *    through `titleFromFilename`, so a `.docx` is named like a `.md`.
 * 3. **A corrupt archive fails with an actionable message.** The underlying
 *    archive library throws "Can't find end of central directory", which tells an
 *    operator nothing about their file. The adapter must wrap it and name the
 *    format (S7: corrupt archives fail cleanly, no stack-trace leak).
 * 4. **A document with no text resolves with empty content and is rejected by the
 *    shared guard.** This is the DOCX half of the empty-extraction rule, and it
 *    is pinned at both layers on purpose: a document that parsed fine and holds
 *    no text is not this adapter's error to raise (it would then own a policy
 *    copy that the PDF, web and transcript paths must match), but it must not
 *    become a silent zero-triplet ingest either.
 *
 * The fixtures are produced by `test/fixtures/documents/make-fixtures.mjs` and
 * are read through absolute paths resolved from `import.meta.url`, never from
 * the working directory. The real parser is exercised — nothing is mocked.
 */

import { describe, it, expect } from "vitest";
import ingestDocx from "../../packages/wiki/src/ingest/docx.js";
import { titleFromFilename } from "../../packages/wiki/src/ingest/shared.js";
import { enforceCharLimit, enforceMinContent } from "../../packages/wiki/src/services/ingest/document.js";
import { fixture, settle } from "./document-fixtures.js";

describe("ingestDocx", () => {
  it("keeps every paragraph of a valid document, in order", async () => {
    const { title, content } = await ingestDocx(fixture("probe.docx"));

    expect(title).toBe("probe");
    expect(content).toContain("DOCX probe sentinel bravo");
    expect(content).toContain("DOCX probe sentinel foxtrot");
    // Order matters: a "join the runs" implementation that reverses paragraphs
    // reads as success while scrambling the document.
    expect(content.indexOf("DOCX probe sentinel bravo")).toBeLessThan(
      content.indexOf("DOCX probe sentinel foxtrot"),
    );
  });

  it("derives the title from the filename like every other adapter", async () => {
    const path = fixture("probe.docx");
    const { title } = await ingestDocx(path);

    expect(title).toBe(titleFromFilename(path));
  });

  it("rejects a file that only claims to be .docx with an actionable message", async () => {
    const { error } = await settle(() => ingestDocx(fixture("corrupt.docx")));

    expect(error).toBeInstanceOf(Error);
    // Actionable means the operator can tell WHICH file and WHICH format the
    // reader choked on; the raw archive-library message names neither.
    expect(error?.message).toMatch(/\.docx/);
    expect(error?.message).toMatch(/not a valid|corrupt|malformed/i);
  });

  it("resolves empty content for a text-free document and lets the guard reject it", async () => {
    const { title, content } = await ingestDocx(fixture("empty.docx"));

    expect(title).toBe("empty");
    expect(content).toBe("");
    expect(() => enforceMinContent(enforceCharLimit(content).content)).toThrow(
      "No readable content could be extracted from the source.",
    );
  });
});
