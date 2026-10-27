/**
 * Integration coverage for log.md journaling through the real call sites:
 * the lint CLI command, the read-only core lint(), the ingest CLI, and the
 * compile pipeline's created-vs-updated classification. The formatter/append
 * helpers themselves are unit-tested in activity-log.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, readFile, writeFile, stat, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { makeLintTempRoot, type LintTempRoot } from "./fixtures/lint-temp-root.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { lint } from "../src/linter/index.js";
import { compileAndReport } from "../src/compiler/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { LOG_FILE } from "../src/utils/constants.js";
import { useStackEnv } from "./fixtures/stack-env.js";
import { withJournalSource } from "../src/dimensions/wiki/activity-log-source.js";
import { renderJournal } from "../src/utils/activity-log.js";


const LONG_BODY = "This page body is comfortably long enough to clear the empty-page threshold.";

/**
 * Read the activity log through the ACTIVE backend.
 *
 * On a Stack the log is a row, so `readFile(log.md)` would throw ENOENT for the
 * right reason and prove nothing. These two helpers ask whichever backend is in
 * play, so a suite can assert "the log says X" without asserting storage.
 */
async function readLog(root: string): Promise<string> {
  const entry = await withJournalSource(process.env, async (source) =>
    source === undefined ? null : renderJournal(await source.read()));
  return entry ?? await readFile(path.join(root, LOG_FILE), "utf-8");
}

/** Whether any backend holds at least one journal entry for this project. */
async function logExists(root: string): Promise<boolean> {
  const rows = await withJournalSource(process.env, (source) => source?.read() ?? Promise.resolve([]));
  if (rows.length > 0) return true;
  try {
    await stat(path.join(root, LOG_FILE));
    return true;
  } catch {
    return false;
  }
}

describe("lint is not journaled", () => {
  let fx: LintTempRoot;
  beforeEach(async () => { fx = await makeLintTempRoot("log-lint-int"); });
  afterEach(async () => { await rm(fx.root, { recursive: true, force: true }); });

  it("CLI `llmwiki lint` does not write log.md", async () => {
    await fx.writeConceptPage("clean", `---\ntitle: Clean\nsummary: ok.\n---\n${LONG_BODY}`);
    expectCLIExit(await runCLI(["lint"], fx.root), 0);
    expect(await logExists(fx.root)).toBe(false);
  }, 30_000);

  it("core lint() does not write log.md (MCP read-only contract)", async () => {
    await fx.writeConceptPage("clean", `---\ntitle: Clean\nsummary: ok.\n---\n${LONG_BODY}`);
    await lint(fx.root);
    expect(await logExists(fx.root)).toBe(false);
  });
});

describe("ingest journaling: CLI", () => {
  // Scoped HERE rather than file-wide: the compile suite below reads its journal off
  // disk and passes without a tenant. Hoisting the Stack to file scope made the shared
  // compile state answer "nothing to compile", turning a green suite red.
  useStackEnv("activity-log-ingest");

  let root: string;
  let srcFile: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "log-ingest-int-"));
    srcFile = path.join(root, "note.md");
    await writeFile(srcFile, "# Note\n\nSome readable content for ingest to store.", "utf-8");
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("CLI `llmwiki ingest <file>` appends an ingest entry with Saved/Chars", async () => {
    expectCLIExit(await runCLI(["ingest", srcFile], root), 0);
    const log = await readLog(root);
    expect(log).toMatch(/^## \[.+Z\] ingest \| /m);
    expect(log).toContain("- Saved: sources/");
    expect(log).toContain("- Chars:");
  }, 30_000);
});

describe("compile journaling: created vs updated", () => {
  const ctx = useCompileProject({ dirSuffix: "log-compile-int" });

  it("logs Created on first compile and Updated on recompile", async () => {
    vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(
      JSON.stringify({ concepts: [{ concept: "Sample Topic", summary: "S.", is_new: true }] }),
    );
    vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(
      "The sample topic is described here. ^[sample.md]",
    );

    await compileAndReport(ctx.dir);
    // Read from AFTER the operation: sibling suites share this Stack, so a whole-log
    // read would match an earlier entry and pass without this compile writing one.
    expect(await readLog(ctx.dir)).toContain("- Created: [[sample-topic]]");

    // Change the source so the next pass recompiles the same concept slug.
    await writeFile(path.join(ctx.dir, "sources", "sample.md"), "# Sample\n\nRevised content.", "utf-8");
    await compileAndReport(ctx.dir);
    expect(await readLog(ctx.dir)).toContain("- Updated: [[sample-topic]]");
  }, 30_000);
});
