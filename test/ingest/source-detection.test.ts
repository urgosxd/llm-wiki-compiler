/**
 * @file test/ingest/source-detection.test.ts
 * @description Which adapter each document extension is routed to.
 *
 * ## The seam
 *
 * `detectSourceType` is the first step of every ingest: it reads a path or URL
 * and returns a `SourceType`, which `fetchContent` then turns into exactly one
 * adapter call. A format that gains an adapter but no dispatch entry is
 * unreachable, and an extension that falls through to `"file"` gets refused by
 * the `.md`/`.txt` guard no matter how good its adapter is.
 *
 * ## What is pinned
 *
 * - `.pdf` routes to `"pdf"` and `.docx` routes to `"docx"` (S2). The `"docx"`
 *   assertion is the dispatch half of the format's support: it fails until the
 *   `SourceType` union and the detector gain the member.
 * - `.md` and `.txt` still route to `"file"` (S1). `.txt` is the one extension
 *   resolved by CONTENT rather than by name, so the fixture prose is chosen to
 *   carry no transcript signal and land on `"file"`.
 * - `.doc` and an unknown extension still route to `"file"`, where the refusal
 *   message lives. They must not be mis-detected into a real adapter: detection
 *   says what kind of thing a path *is*, and the actionable refusal is a
 *   separate, later decision (S4).
 */

import { describe, it, expect } from "vitest";
import { detectSourceType } from "../../src/services/ingest/source-detection.js";
import { fixture } from "./document-fixtures.js";

describe("detectSourceType", () => {
  it("routes .pdf to the pdf adapter", async () => {
    expect(await detectSourceType(fixture("probe.pdf"))).toBe("pdf");
  });

  it("routes .docx to the docx adapter", async () => {
    expect(await detectSourceType(fixture("probe.docx"))).toBe("docx");
  });

  it("keeps .md and .txt on the generic file adapter", async () => {
    expect(await detectSourceType(fixture("probe.md"))).toBe("file");
    expect(await detectSourceType(fixture("probe.txt"))).toBe("file");
  });

  it("leaves .doc and unknown extensions on the generic file adapter", async () => {
    expect(await detectSourceType(fixture("legacy.doc"))).toBe("file");
    expect(await detectSourceType(fixture("unknown.xyz"))).toBe("file");
  });
});
