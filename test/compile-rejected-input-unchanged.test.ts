/**
 * @file test/compile-rejected-input-unchanged.test.ts
 * @description S6: "Rejected or failed input leaves stored data unchanged."
 *
 * ## The rejection path this pins
 *
 * `compileRecompiling` (`src/compiler/index.ts:313`) is documented as refusing "a page
 * name that no stored page matches" with "an error and no writes at all". The claim was
 * checked in the source before this file was written, not assumed: the refusal is
 * produced by `planRecompile` (`src/compiler/version-report.ts:302`) and returned by
 * `resolveRunScope` BEFORE `markUnchangedPendingSources`, extraction, page generation
 * and the state flush, so nothing downstream of the refusal can run. `compileRecompiling`
 * carries the request through `AsyncLocalStorage`, so no option or env can smuggle it
 * past that point.
 *
 * This file measures that claim instead of repeating it, on BOTH stores the compiler
 * writes to:
 *
 *  - the FILE-backed wiki (`wiki/` + `.llmwiki/state.json`), through the on-disk tree's
 *    fingerprint, which is where the documentation's "no writes at all" lives; and
 *  - the ROW-backed Stack, through production readers (`listStoredPagesUnfiltered`,
 *    `readWikiStateFromRows`, `readJournalEntries`), because rows are the store a
 *    Stack-backed compile actually writes.
 *
 * ## What "unchanged" has to mean to be evidence
 *
 * `changedPaths(before, after)` is `[]` for a comparison of two EMPTY fingerprints, so
 * each case first proves its `before` snapshot is non-empty. Without that, a compile
 * that wrote nothing because it never ran would pass this whole file.
 *
 * ## Why the lock is asserted too
 *
 * A failure that leaves the project locked is a stored-data change of its own: the next
 * compile cannot even start. Both cases therefore take the lock immediately after the
 * refusal, which is only possible if the refused run released what it acquired.
 *
 * ## Why every Stack key is a fresh `randomUUID()`
 *
 * The container behind the test database is long-lived. A session-level advisory lock
 * leaked by an earlier probe outlives the run that leaked it, and a shared key would let
 * that leak look like this file's subject.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import compileCommand from "../packages/wiki/src/commands/compile.js";
import { compileAndReport, compileRecompiling } from "../packages/wiki/src/compiler/index.js";
import { readJournalEntries } from "../packages/wiki/src/dimensions/wiki/activity-log-store.js";
import { listStoredPagesUnfiltered } from "../packages/wiki/src/dimensions/wiki/page-store.js";
import { saveSourceDocument } from "../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { readWikiStateFromRows } from "../packages/wiki/src/dimensions/wiki/wiki-state-source.js";
import { AnthropicProvider } from "../packages/wiki/src/providers/anthropic.js";
import { acquireLock, releaseLock } from "../packages/wiki/src/utils/lock.js";
import { lockRegistry } from "../packages/wiki/src/utils/lock-postgres.js";
import { perRunDatabase } from "./fixtures/per-run-database.js";
import { listConceptPages, readConceptPage } from "./fixtures/concept-page.js";
import { scratchProjectRoot } from "./fixtures/host-scratch.js";
import { captureProcessIo, type CapturedProcessIo } from "./fixtures/process-io.js";
import { provisionStack, type ProvisionedStack } from "./fixtures/stack-harness.js";
import { changedPaths, fingerprintTree } from "./fixtures/tree-fingerprint.js";

/** This process's own database; provisioning fails loudly rather than skipping. */
const DSN = (await perRunDatabase()).url;

/** The page a refusal names: no stored page has this slug, in either store. */
const UNKNOWN_PAGE = "concepts/missing";

/** The refusal `planRecompile` produces for {@link UNKNOWN_PAGE}, verbatim. */
const UNKNOWN_PAGE_REFUSAL = `Cannot recompile: no page named "${UNKNOWN_PAGE}" exists in this wiki.`;

/** The source the row-backed compile turns into one page. */
const STACK_SOURCE = {
  title: "Sample Topic",
  source: "https://rejected-input.test/sample",
  document: "# Sample Topic\n\nSome source content about a topic.\n",
};

/** Stub the provider boundary only: extraction and the generated page body. */
function stubProvider(): void {
  vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-key");
  vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(
    JSON.stringify({ concepts: [{ concept: "Sample Topic", summary: "S.", is_new: true }] }),
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(
    "Body content for the topic. ^[sample.md]",
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
}

/** Run `llmwiki compile --recompile` the way the CLI does: from the project root. */
async function runRecompileCommand(
  root: string,
  pages: readonly string[],
): Promise<{ code: number; io: CapturedProcessIo }> {
  const original = process.cwd();
  process.chdir(root);
  const io = captureProcessIo();
  try {
    return { code: await compileCommand({}, pages), io };
  } finally {
    process.chdir(original);
  }
}

/** True when the lock for `root` can be taken right now; leaves it as it found it. */
async function lockIsFree(root: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const acquired = await acquireLock(root, { quiet: true, env });
  if (acquired) await releaseLock(root, env);
  return acquired;
}

afterEach(() => {
  // A leaked entry is a live reserved connection holding a session-level lock: unlock
  // it before dropping the handle, or it stays held for the life of the process.
  for (const held of lockRegistry.values()) void held.release().catch(() => {});
  lockRegistry.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a file-backed wiki refuses an unknown page and keeps every byte", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rejected-file-"));
    await mkdir(path.join(root, "sources"), { recursive: true });
    await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, "sources", "sample.md"), STACK_SOURCE.document, "utf-8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports the exact refusal, writes nothing, and frees the lock", async () => {
    stubProvider();
    // A previous successful compile, so "unchanged" is a comparison of a REAL wiki
    // rather than of two empty directories.
    const first = await compileAndReport(root, { embeddings: false });
    expect(first.errors).toEqual([]);
    const pagesBefore = await listConceptPages(root);
    expect(pagesBefore.length).toBeGreaterThan(0);
    const pageTextBefore = await readConceptPage(root, "sample-topic");
    const before = await fingerprintTree(root);
    expect(before.size).toBeGreaterThan(0);

    // The returned shape a programmatic caller branches on...
    const result = await compileRecompiling(root, [UNKNOWN_PAGE]);
    expect(result.errors).toEqual([UNKNOWN_PAGE_REFUSAL]);
    // ...and the shape an operator sees: exit 1 and the same sentence, printed.
    const { code, io } = await runRecompileCommand(root, [UNKNOWN_PAGE]);
    expect(code).toBe(1);
    expect(io.out()).toContain(UNKNOWN_PAGE_REFUSAL);

    expect(changedPaths(before, await fingerprintTree(root))).toEqual([]);
    expect(await readConceptPage(root, "sample-topic")).toBe(pageTextBefore);
    expect(await listConceptPages(root)).toEqual(pagesBefore);
    // Nothing new appears: the lock the refused runs took is gone, not left behind.
    expect(existsSync(path.join(root, ".llmwiki", "lock"))).toBe(false);
    // ...and the same project can be locked again immediately.
    expect(await lockIsFree(root, {} as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("a row-backed Stack refuses an unknown page and keeps every row", () => {
  let stack: ProvisionedStack;
  let root = "";
  let env: NodeJS.ProcessEnv;
  const savedEnv = { stackId: process.env.AKS_STACK_ID, dsn: process.env.AKS_DATABASE_URL };

  beforeEach(async () => {
    stack = await provisionStack("rejected-input");
    root = await scratchProjectRoot("rejected-rows-");
    // A Stack of this run's own: a leaked advisory lock on a REUSED stack would make
    // the post-refusal acquire below fail for a reason that is not this test's.
    env = { AKS_STACK_ID: stack.harness.stackId, AKS_DATABASE_URL: DSN } as NodeJS.ProcessEnv;
    process.env.AKS_STACK_ID = env.AKS_STACK_ID;
    process.env.AKS_DATABASE_URL = DSN;
  });

  afterEach(async () => {
    for (const [name, value] of [["AKS_STACK_ID", savedEnv.stackId], ["AKS_DATABASE_URL", savedEnv.dsn]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await stack.release();
    await rm(root, { recursive: true, force: true });
  });

  it("reports the exact refusal, writes no page, state or journal row, and frees the lock", async () => {
    if (!stack.harness.reachable) return;
    const { db, stackId } = stack.harness;
    stubProvider();
    await saveSourceDocument(db, stackId, STACK_SOURCE);

    const first = await compileAndReport(root, { embeddings: false });
    expect(first).toMatchObject({ compiled: 1, errors: [] });

    const pagesBefore = await listStoredPagesUnfiltered(db, stackId);
    expect(pagesBefore.length).toBeGreaterThan(0);
    const stateBefore = await readWikiStateFromRows(db, stackId);
    expect(Object.keys(stateBefore.sources).length).toBeGreaterThan(0);
    const journalBefore = await readJournalEntries(db, stackId);

    const result = await compileRecompiling(root, [UNKNOWN_PAGE]);

    expect(result.errors).toEqual([UNKNOWN_PAGE_REFUSAL]);
    expect(await listStoredPagesUnfiltered(db, stackId)).toEqual(pagesBefore);
    expect(await readWikiStateFromRows(db, stackId)).toEqual(stateBefore);
    expect(await readJournalEntries(db, stackId)).toEqual(journalBefore);
    expect(existsSync(path.join(root, ".llmwiki", "lock"))).toBe(false);
    expect(await lockIsFree(root, env)).toBe(true);
  });
});
