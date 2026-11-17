/**
 * @file test/compile-advisory-lock-signature.test.ts
 * @description T6 / S16 — a compile that resolves its Stack from the DATABASE must hold
 * that STACK's advisory lock, not the per-root path lock.
 *
 * ## The defect this pins
 *
 * `compileAndReport` takes the mutation lock BEFORE the Stack authority is resolved, so
 * the lock key is derived from an environment that names no Stack:
 * `utils/lock.ts`'s `stackIdOf` answers `undefined`, the key falls back to
 * `realpath(root)`, and `databaseUrlFor` refuses a DSN without a Stack — which makes
 * `acquireDatabaseLock` return before attempting `pg_try_advisory_lock` at all. A
 * database-resolved compile therefore excludes only its own checkout, so two compiles
 * of two DIFFERENT roots on ONE Stack run concurrently, and crash-release differs from
 * every entry point that names the id. "A lock that silently does not happen reads
 * exactly like a lock held."
 *
 * ## The discriminating property
 *
 * The environment CONFIGURES the database and NAMES NO STACK — the operator's scenario
 * after `AKS_STACK_ID` is removed from `.env` — because that is the only shape in which
 * a lock keyed on the environment and a lock keyed on the RESOLVED Stack differ. Nothing
 * in this file writes the id into the environment of the run under test: the Stack is
 * whatever the resolver the code under test calls answers, one Stack per per-run
 * database.
 *
 * ## How the Stack is held, without a second compile
 *
 * The holder stands in for ANOTHER HOST serving the same Stack: a host that serves one
 * Stack knows its id, and takes the advisory lock from a DIFFERENT checkout root through
 * the public `acquireLock`. That is the same contention a concurrent compile on another
 * host creates, without a stalled pipeline or a race to schedule — and the assertion is
 * the public result (`busy`), never an internal registry.
 *
 * ## The file-mode pins
 *
 * File mode must not change: with no database configured the run still takes the PATH
 * lock, so a compile of the SAME root is refused; and two DIFFERENT roots do NOT
 * serialise, because there is no Stack to key on. Both are pinned by name, which is the
 * evidence that the fix keys on the resolved Stack and did not replace the file lock.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { compileAndReport } from "../packages/wiki/src/compiler/index.js";
import { LOCK_FILE } from "../packages/wiki/src/utils/constants.js";
import { acquireLock, releaseLock } from "../packages/wiki/src/utils/lock.js";
import { extractionAnswer, stubCompileProvider } from "./fixtures/compile-provider.js";
import { usePerCaseFileMode, withFileMode } from "./fixtures/file-mode.js";
import { useResolvedStackSuite } from "./fixtures/resolved-stack-suite.js";

// This file has BOTH modes — a row-backed case and two file-backed pins — so the mode is
// declared per case. The file-wide hook would strip the database from the row case.
usePerCaseFileMode();

/** The one concept the stub provider extracts, for any case that reaches a source. */
const TITLE = "Locked Stack Topic";

/**
 * The scenario, from the fixture both lock-and-publish suites share: a per-run database,
 * an environment that NAMES NO STACK, and this file's own stub provider.
 *
 * `runEnv` is read from `process.env` rather than captured, so the same helper serves the
 * row case (a database is published there) and the file-mode pins (it is blanked inside
 * `withFileMode`).
 */
const { skipped, runEnv, suiteHandle, tempRoot, stackId } = await useResolvedStackSuite({
  context: "test/compile-advisory-lock-signature.test.ts",
  beforeEach: () => {
    stubCompileProvider({ extraction: () => extractionAnswer([TITLE]), body: () => "Body.\n" });
  },
});

/**
 * The environment ANOTHER HOST serving one Stack would hold: the DSN, and the id.
 *
 * The id is never in the run under test — it is the OTHER side of the contention, whose
 * whole premise is that a host serving a Stack knows which Stack that is.
 *
 * @param stackId - The Stack both sides share.
 * @returns The holder's environment.
 */
function holderEnv(stackId: string): NodeJS.ProcessEnv {
  return { ...process.env, AKS_STACK_ID: stackId };
}

describe.skipIf(skipped !== "")("a compile whose Stack the run names", () => {
  it("is refused while another host holds that Stack's advisory lock, and names no Stack itself", async () => {
    const handle = suiteHandle();
    const holderRoot = await tempRoot("advisory-holder-");
    const runnerRoot = await tempRoot("advisory-runner-");
    const held = holderEnv(stackId);
    try {
      // Held for the WHOLE case: nothing releases it before the compile below tries.
      expect(await acquireLock(holderRoot, { quiet: true, env: held })).toBe(true);
      try {
        const result = await compileAndReport(runnerRoot, { embeddings: false, env: runEnv() });
        // `busy` is the machine-readable counterpart of the refusal: the run never
        // started. The message is deliberately not asserted — the defect is that no
        // advisory lock was ATTEMPTED, and a prose assertion would pin wording instead.
        expect(result.busy).toBe(true);
        // A refused run takes nothing, not even the path lock it used to fall back to.
        expect(existsSync(path.join(runnerRoot, LOCK_FILE))).toBe(false);
      } finally {
        await releaseLock(holderRoot, held);
      }
    } finally {
      await handle.close();
    }
  });
});

describe("file mode takes the path lock and no advisory lock", () => {
  it("refuses a compile of the SAME root while that root's path lock is held", async () => {
    await withFileMode(async () => {
      const env = runEnv();
      const root = await tempRoot("path-lock-same-");
      expect(await acquireLock(root, { quiet: true, env })).toBe(true);
      try {
        expect((await compileAndReport(root, { embeddings: false, env })).busy).toBe(true);
      } finally {
        await releaseLock(root, env);
      }
    });
  });

  it("does NOT serialise two DIFFERENT roots, having no Stack to key on", async () => {
    await withFileMode(async () => {
      const env = runEnv();
      const holderRoot = await tempRoot("path-lock-holder-");
      const runnerRoot = await tempRoot("path-lock-runner-");
      expect(await acquireLock(holderRoot, { quiet: true, env })).toBe(true);
      try {
        const result = await compileAndReport(runnerRoot, { embeddings: false, env });
        expect(result.busy).toBeUndefined();
        expect(result.errors).toEqual([]);
      } finally {
        await releaseLock(holderRoot, env);
      }
    });
  });
});
