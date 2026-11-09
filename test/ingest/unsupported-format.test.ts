/**
 * @file test/ingest/unsupported-format.test.ts
 * @description A refused format must say why it was refused, and must leave
 * nothing behind.
 *
 * ## The defect these tests pin
 *
 * `src/ingest/file.ts` answers every extension it does not handle with one
 * sentence: `Unsupported file type ".xyz". Only .md and .txt files are
 * supported.` That sentence is wrong twice over. It hides the follow-up path
 * for a format we deliberately descoped (Excel), and it is simply false about
 * the product — `.pdf`, images, transcripts and web pages all ingest today, so
 * an operator reading it concludes the compiler is narrower than it is and gives
 * up on a format that already works.
 *
 * ## Per-format contract
 *
 * - `.xlsx` — descoped, with the follow-up parser named so the refusal is a
 *   signpost rather than a dead end (S3).
 * - `.doc` — legacy binary Word needs an external office suite; the message must
 *   say so and point at `.docx` (S4). "word" in the original request means
 *   `.docx`.
 * - unknown — must not repeat the false "only .md and .txt" claim, and must
 *   positively name the formats that do work. Ticking the first box alone is not
 *   enough: a message that lists nothing would stop lying and still leave the
 *   operator at a dead end, so the assertion is on the positive list too.
 *
 * ## Why nothing here snapshots a directory
 *
 * Each refusal used to be wrapped in a snapshot of a fresh temporary directory
 * that the refusals never received and could not have written to. The adapter is
 * `ingestFile(sourcePath)`: no destination parameter exists, so "the directory is
 * still empty" asserted a fact about a directory that no line of the code under
 * test can even address — it passed regardless of behaviour.
 *
 * The guarantee that does hold is structural, and it is what these tests now
 * state instead of pretending to measure: a refusal is thrown before the file is
 * read, so no adapter-level side effect can exist, and the single transactional
 * write for a successful ingest lives in `src/dimensions/coordinator.ts`, whose
 * own tests own atomicity (S6).
 */

import { describe, it, expect } from "vitest";
import ingestFile from "../../packages/wiki/src/ingest/file.js";
import { fixture } from "./document-fixtures.js";

/** Return the rejection message of a refused ingest, failing if it resolved. */
async function rejectionOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the ingest to be refused, but it resolved");
}

describe("ingestFile refuses formats it does not handle", () => {
  it("names the refused .xlsx format and the follow-up parser", async () => {
    const message = await rejectionOf(() => ingestFile(fixture("data.xlsx")));

    expect(message).toContain(".xlsx");
    expect(message).toContain("read-excel-file@9.3.14");
  });

  it("explains that .doc is legacy binary Word and points at .docx", async () => {
    const message = await rejectionOf(() => ingestFile(fixture("legacy.doc")));

    expect(message).toMatch(/\.doc\b/);
    expect(message).toMatch(/legacy/i);
    expect(message).toMatch(/binary/i);
    expect(message).toMatch(/unsupported/i);
    expect(message).toMatch(/\.docx/);
  });

  it("names the formats that ARE supported instead of the old false claim", async () => {
    const message = await rejectionOf(() => ingestFile(fixture("unknown.xyz")));

    expect(message).toContain(".xyz");
    // `.pdf`, images and transcripts all ingest today; this sentence told
    // operators otherwise.
    expect(message).not.toMatch(/only \.md and \.txt/i);
    // The positive half is the point. A message that merely stopped lying by
    // listing nothing at all would leave the operator with the same dead end,
    // so the two formats this feature is about have to be named.
    expect(message).toContain(".pdf");
    expect(message).toContain(".docx");
  });
});
