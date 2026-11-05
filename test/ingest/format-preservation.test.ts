/**
 * @file test/ingest/format-preservation.test.ts
 * @description The formats that already worked must come out exactly as before.
 *
 * ## Why this file exists at all
 *
 * `detectSourceType` -> `fetchContent` is the shared seam every format passes
 * through, and the multi-format work edits both sides of it (a new `"docx"`
 * member, a new dispatch case, new refusal branches). Shared code is where
 * unrequested behaviour changes hide: a trim, a normalisation, or a re-wrapped
 * string is invisible in review and breaks every suite that depends on the old
 * bytes.
 *
 * So the two existing file behaviours are pinned literally (S1):
 *
 * 1. A `.md` is returned **byte-identical** to what is on disk. It is already
 *    Markdown; any transformation is a regression, not an improvement.
 * 2. A `.txt` is still wrapped in a fenced block. That wrapping is the existing
 *    contract of the `file` adapter, and it is the branch most likely to be
 *    disturbed by an edit to the extension guard next to it.
 *
 * No normalisation is applied in the assertions themselves: the comparison is a
 * plain `===` against `readFile`, so a leading BOM, a trailing newline count or a
 * line-ending change all show up as failures.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import ingestFile from "../../src/ingest/file.js";
import { fixture } from "./document-fixtures.js";

describe("the file adapter preserves content it already handled", () => {
  it("returns a .md file byte-identical to the file on disk", async () => {
    const path = fixture("probe.md");
    const onDisk = await readFile(path, "utf-8");

    const { title, content } = await ingestFile(path);

    expect(title).toBe("probe");
    expect(content).toBe(onDisk);
    expect(content).toContain("# Multi format probe");
  });

  it("still wraps a .txt file in a fenced block", async () => {
    const path = fixture("probe.txt");
    const onDisk = await readFile(path, "utf-8");

    const { content } = await ingestFile(path);

    // The exact existing contract: fence, newline, raw text, newline, fence.
    expect(content).toBe(`\`\`\`\n${onDisk}\n\`\`\``);
  });
});
