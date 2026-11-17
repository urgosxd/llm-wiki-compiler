/**
 * @file test/stack-authority-masquerade.test.ts
 * @description With a database configured and `AKS_STACK_ID` absent, a run must FAIL
 * by name. It must not produce a working, file-backed result instead.
 *
 * ## The condition this pins
 *
 * A checkout can configure a database and name no Stack. Two systems used to answer
 * "which Stack" for that checkout: the database-backed resolver, which created a
 * default Stack, and the environment-only readers repeated as
 * `if (stackId === "") return undefined` in the compiler's factories and in the
 * page-source seam, which answered "none" — and a seam handed `undefined` is not an
 * error, it is the FILE backend. So one run ingested into rows and compiled into
 * files, and the caller was told nothing. That is the masquerade: a missing Stack id
 * produced a working, file-backed result instead of the row-backed one the
 * configuration asked for.
 *
 * ## What changed, and why this file did NOT go away
 *
 * The first half of that masquerade — implicit provisioning of a default Stack — is
 * deleted by decision (S1 of `odd/tasks/stack-authority-per-request.md`). Its test
 * asserted that the run SUCCEEDED row-backed; that assertion is REVERSED on purpose
 * and not retargeted, because success is no longer the contract. What survives is the
 * observation the file exists for: the outcome of an unnamed run must never be a
 * file-backed one. It now fails loudly instead, and the three assertions below say so
 * from the outside — the refusal reaches the caller, `public.stacks` is untouched, and
 * the state file the file backend would have written is absent.
 *
 * ## Why the per-run database, and what "no database" does here
 *
 * `test/fixtures/per-run-database.ts` gives this file a database of its own, publishes
 * it into `AKS_DATABASE_URL`, and drops it when the process ends; no live or shared
 * database is touched and nothing depends on timing. The database deliberately holds
 * no Stack: that is the state a first-time deployment is in, and creating one
 * implicitly is exactly what the deleted code did.
 *
 * This file FAILS when no database can be obtained, and skips ONLY under the one
 * documented opt-out `LLMWIKI_TEST_ALLOW_NO_DATABASE=1`, with its reason printed: a
 * skip that silently passes would prove nothing about the masquerade.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWiki } from "../packages/wiki/src/sdk/wiki.js";
import { createDimensionsDatabase } from "../packages/wiki/src/dimensions/activation.js";
import { STATE_FILE } from "../packages/wiki/src/utils/constants.js";
import { perRunDatabase } from "./fixtures/per-run-database.js";
import { missingTestDatabase } from "./fixtures/test-database-handoff.js";

/** This file's path, so a "no database" failure points here and not at a fixture. */
const DATABASE_CONTEXT = "test/stack-authority-masquerade.test.ts";

/** Body long enough to clear the minimum source length the ingest enforces. */
const BODY = "Body long enough to clear the minimum source length the ingest enforces.";

/**
 * The state a file-backed run must NOT leave behind, as a path under a project root.
 *
 * `STATE_FILE` rather than the whole `.llmwiki/` directory: a compile legitimately
 * writes other private files there (the lock, the journal), so only the state file
 * itself is evidence about the backend.
 */
const FILE_STATE = (root: string): string => path.join(root, STATE_FILE);

/** True when this run has no usable database and the one opt-out authorized a skip. */
const skipped = await unavailable();

/**
 * Obtain this file's per-run database, or record why it can only skip.
 *
 * The repository's rule for a database-backed suite: FAIL when none can be obtained,
 * because a skip is reported as a pass while asserting nothing. Only
 * `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` reaches the skip, and it still prints the reason.
 *
 * @returns `""` when the database is usable, otherwise the reason the skip reports.
 */
async function unavailable(): Promise<string> {
  try {
    await perRunDatabase();
    return "";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const missing = missingTestDatabase(DATABASE_CONTEXT, detail);
    if (missing.error !== undefined) throw missing.error;
    console.warn(missing.message);
    return missing.message;
  }
}

/** How many rows `public.stacks` holds in the configured database right now. */
async function countStacks(): Promise<number> {
  const handle = createDimensionsDatabase(process.env);
  try {
    const [row] = await handle.db.execute<{ n: number }>("select count(*)::int as n from public.stacks");
    return Number(row?.n);
  } finally {
    await handle.close();
  }
}

/** Project roots this file created, outside the worktree, removed after each test. */
const roots: string[] = [];

/** Environment as it was before the test, restored after it. */
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
});

afterEach(async () => {
  process.env = savedEnv;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(skipped !== "")("a database configured and no AKS_STACK_ID", () => {
  it("refuses by name, leaving no Stack row and no file-backed result", async () => {
    // The condition in one line: a database is configured (the per-run one, published
    // into AKS_DATABASE_URL) and nothing names a Stack.
    delete process.env.AKS_STACK_ID;
    const root = await mkdtemp(path.join(tmpdir(), "stack-masquerade-"));
    roots.push(root);
    const before = await countStacks();
    const wiki = createWiki({ root });

    const outcome = await wiki.ingestText({ title: "Ledger", text: BODY }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // REFUSED, by name: the failure has to reach the caller and say what is missing.
    expect(outcome, "an unnamed run must fail instead of writing somewhere").toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(
      "AKS_DATABASE_URL is configured, so this run must have a Stack",
    );

    // FILE-BACKED: the outcome the masquerade produced is the one that must not happen.
    expect(existsSync(FILE_STATE(root)), "no run may fall back to the file backend").toBe(false);

    // And nothing was created on the way past, which is the whole of S1.
    expect(await countStacks(), "a refused run must create no Stack").toBe(before);
  }, 180_000);
});
