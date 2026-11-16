/**
 * @file test/stack-authority-masquerade.test.ts
 * @description With a database configured and `AKS_STACK_ID` absent, the SDK's
 * compile must record its state in the Stack's ROWS. Today it succeeds FILE-backed
 * instead, and nothing reports the downgrade.
 *
 * ## The condition this pins (spec S5 of `odd/tasks/single-stack-authority.md`)
 *
 * A checkout can configure a database and name no Stack. Two systems answer "which
 * Stack" for that checkout: the database-backed resolver (`resolveStackForCommand` →
 * `ensureDefaultStack` by the default domain, already wired into ingest) and the
 * environment-only readers repeated as `if (stackId === "") return undefined` in the
 * compiler's factories and in the page-source seam. The first answers "the default
 * Stack"; the second answers "none", and a seam handed `undefined` is not an error —
 * it is the FILE backend. So one run ingests into rows and compiles into files: the
 * source row and the compile's state disagree about the medium, and the caller is
 * told nothing. That is the masquerade: a missing Stack id produces a working,
 * file-backed result instead of the row-backed one the configuration asked for.
 *
 * ## What is asserted, and why THIS observation
 *
 * The ROW-BACKED outcome is asserted, never a message: after `createWiki({ root })`
 * ingests one source and compiles, that source's state must be readable from the
 * Stack's rows (`readWikiStateFromRows`, the seam's own state reader) and
 * `.llmwiki/state.json` must not exist. Three other candidates were weighed and
 * rejected, and the reasons are why this one is the honest one:
 *
 *  - the compile result carries `compiled/skipped/deleted/concepts/pages/errors` and
 *    no field naming a medium, so it cannot answer the question at all;
 *  - `status().stateStatus` is `"ok"` on BOTH backends once a compile has run — the
 *    file backend's `"ok"` merely comes from the `state.json` it just wrote;
 *  - "a second compile sees the first one's state" is true on BOTH backends, because
 *    each persists its own state and each reads its own back. It proves that a
 *    compile is incremental, not where the state lives.
 *
 * What is left is the one thing a user can see: where the state is. A row-backed run
 * leaves rows and no `state.json`; today's run leaves `state.json` and no rows.
 *
 * ## Why the per-run database, and what "no database" does here
 *
 * `test/fixtures/per-run-database.ts` gives this file a database of its own, publishes
 * it into `AKS_DATABASE_URL`, and drops it when the process ends; no live or shared
 * database is touched and nothing depends on timing. The Stack is deliberately NOT
 * provisioned: the database holds no Stack at all, which is the state a first-time
 * deployment is in, and materializing the default one is precisely what spec S1's
 * precedence 2 requires of the code under test.
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
import { resolveStackForCommand } from "../packages/wiki/src/services/stacks/resolve-stack.js";
import { readWikiStateFromRows } from "../packages/wiki/src/dimensions/wiki/wiki-state-source.js";
import { STATE_FILE } from "../packages/wiki/src/utils/constants.js";
import { perRunDatabase } from "./fixtures/per-run-database.js";
import { missingTestDatabase } from "./fixtures/test-database-handoff.js";
import { keylessly } from "./fixtures/keyless-provider.js";

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
  it("records the compile's state in the Stack's rows, creating no state file", async () => {
    // The condition in one line: a database is configured (the per-run one, published
    // into AKS_DATABASE_URL) and nothing names a Stack.
    delete process.env.AKS_STACK_ID;
    const root = await mkdtemp(path.join(tmpdir(), "stack-masquerade-"));
    roots.push(root);
    const wiki = createWiki({ root });

    await wiki.ingestText({ title: "Ledger", text: BODY });
    await keylessly(() => wiki.compile());

    // ROW-BACKED: the state the run just produced is readable from the rows of the
    // Stack the database-backed resolver names -- the only Stack this database has.
    const handle = createDimensionsDatabase(process.env);
    try {
      const stackId = await resolveStackForCommand(handle.db, {});
      const rows = await readWikiStateFromRows(handle.db, stackId);
      expect(Object.keys(rows.sources)).toHaveLength(1);
    } finally {
      await handle.close();
    }

    // FILE-BACKED: the state file the file backend would have written stayed absent.
    expect(existsSync(FILE_STATE(root))).toBe(false);
  }, 180_000);
});
