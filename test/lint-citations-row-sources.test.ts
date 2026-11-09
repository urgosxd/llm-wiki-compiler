/**
 * @file test/lint-citations-row-sources.test.ts
 * @description Citations must resolve against the Stack's documents, not `sources/`.
 *
 * WHY THIS EXISTS
 *
 * `checkBrokenCitations` joins each cited filename onto `sources/` and tests
 * `existsSync`. A Stack has no such directory: its citation targets are
 * `wiki.source_documents` rows. So on a Stack EVERY citation resolved to a path
 * that cannot exist and the rule reported all of them as broken — the finding that
 * dominates the visible-corpus numbers (196 errors on the Stack where this was
 * measured).
 *
 * The rule also reads each cited document to count lines for claim-level spans. A
 * row already carries its text, so both halves are answerable from the corpus — no
 * disk read, and no second query.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { lintByTier } from "../packages/wiki/src/linter/index.js";
import {
  lintRowCorpus,
  rawPage,
  reportedRuleIds,
  stackProjectRoot,
  writeDiskPage,
} from "./fixtures/lint-row-corpus.js";

let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A three-line document: enough to prove an out-of-bounds span while in-bounds passes. */
const THREE_LINE_SOURCE = "line one\nline two\nline three\n";

/** The stack corpus's one document, as a `wiki.source_documents` row. */
const DOC = { filename: "doc.md", content: THREE_LINE_SOURCE };

describe("citations against a row corpus", () => {
  it("does not report a citation whose document exists as a row", async () => {
    dir = await stackProjectRoot("cites");
    const report = await lintRowCorpus(
      dir,
      [rawPage("cites", { title: "Cites", summary: "s" }, "A claim backed by evidence ^[doc.md].")],
      [DOC],
    );

    // The document is in the corpus, so the citation resolves. Against disk this
    // page would have been reported broken.
    expect(reportedRuleIds(report)).not.toContain("broken-citation");
  });

  it("reports a citation whose document is absent from the corpus", async () => {
    dir = await stackProjectRoot("cites-ghost");
    const report = await lintRowCorpus(
      dir,
      [rawPage("ghost", { title: "Ghost", summary: "s" }, "A claim with no support ^[ghost.md].")],
      [DOC],
    );

    expect(reportedRuleIds(report)).toContain("broken-citation");
  });

  it("counts lines from the row text for a claim-level span", async () => {
    dir = await stackProjectRoot("cites-span");
    const report = await lintRowCorpus(
      dir,
      [rawPage("span", { title: "Span", summary: "s" }, "A precise claim ^[doc.md:1-99].")],
      [DOC],
    );

    // The source has 3 lines; a span to 99 is out of bounds. Proving this needs the
    // document TEXT, not just its existence.
    expect(reportedRuleIds(report)).toContain("broken-citation");
  });

  it("accepts a claim-level span inside the row document's length", async () => {
    dir = await stackProjectRoot("cites-ok");
    const report = await lintRowCorpus(
      dir,
      [rawPage("ok", { title: "Ok", summary: "s" }, "A precise claim ^[doc.md:1-2].")],
      [DOC],
    );

    expect(reportedRuleIds(report)).not.toContain("broken-citation");
  });
});

describe("citations with no Stack configured", () => {
  it("still reads sources/ from disk", async () => {
    dir = await stackProjectRoot("cites-disk");
    await mkdir(path.join(dir, "sources"), { recursive: true });
    await writeFile(path.join(dir, "sources/doc.md"), THREE_LINE_SOURCE);
    await writeDiskPage(dir, "cites", "---\ntitle: Cites\nsummary: s\n---\n\nA claim ^[doc.md].\n");
    // No seams mocked: the real ones yield undefined without a Stack.

    const report = await lintByTier(dir);

    expect(reportedRuleIds(report)).not.toContain("broken-citation");
  });
});
