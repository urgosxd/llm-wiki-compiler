/**
 * @file test/compiler/compile-busy-signal.test.ts
 * @description `compileAndReport` must say "someone else holds the lock" in a way
 * a transport can BRANCH on, not only in prose.
 *
 * WHY THIS EXISTS. The compile service is shared by the CLI, the MCP server, and
 * (from this change) the HTTP host. When the lock is taken, the handler has to
 * answer 409 Conflict and invite a retry; a genuine compile failure is a different
 * status entirely. Before this, contention surfaced only as an `errors` string,
 * and `errors` is ALSO populated for ordinary failures — so the string's presence
 * could not discriminate, and matching the message text would have been brittle.
 *
 * The lock is contended here through the real filesystem lock, because that is the
 * only contention that matters: the MCP server is a separate process over the same
 * project, so an in-process counter would prove nothing.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { compileAndReport } from "../../src/compiler/index.js";

/** A scratch project root with the sources/ directory compile expects. */
async function projectRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "compile-busy-")));
  await mkdir(path.join(root, "sources"), { recursive: true });
  return root;
}

describe("compile reports lock contention structurally", () => {
  it("sets busy when another holder owns the project lock", async () => {
    const root = await projectRoot();
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    try {
      const result = await compileAndReport(root);
      // A transport reads this flag to answer 409 instead of guessing from text.
      expect(result.busy).toBe(true);
      expect(result.compiled).toBe(0);
      // The human-readable message stays, for the CLI's benefit.
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      await releaseLock(root);
    }
  }, 30_000);

  it("does not set busy on a run that acquired the lock", async () => {
    const root = await projectRoot();
    // An empty project has nothing to compile, but it DID get the lock, so the
    // flag must stay unset — otherwise every successful run would look busy.
    const result = await compileAndReport(root);
    expect(result.busy).toBeUndefined();
  }, 60_000);
});
