/**
 * @file test/commands/ingest-lock.test.ts
 * @description Ingest is a transaction across two systems that share no
 * transaction manager, so the ONLY thing serialising two concurrent runs is the
 * project lock. This suite proves the lock spans the whole dimension transaction
 * and that contention is reported, not waited on.
 *
 * WHY THE LOCK MUST WRAP THE TRANSACTION. `saveSource` and the journal each take
 * the lock around their own file operation. That protects one write, not one run:
 * two ingests could interleave wiki and graph commits and a rollback in one would
 * revert the other's file. Real concurrency here is cross-process — the MCP server
 * is a separate process over the same project — which is why the test contends
 * through the same filesystem lock rather than through an in-process counter.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireLock, releaseLock, LockBusyError } from "../../src/utils/lock.js";
import { ingestTextSource } from "../../src/commands/ingest.js";
import { tryWithOrdinaryMutationLock } from "../../src/utils/mutation-lock.js";

/** A scratch project root the lock can live under. */
async function projectRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "ingest-lock-")));
}

describe("the ingest transaction is serialised by the project lock", () => {
  it("reports busy instead of running when another holder owns the lock", async () => {
    const root = await projectRoot();
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    try {
      let ran = false;
      const result = await tryWithOrdinaryMutationLock(root, async () => {
        ran = true;
        return "ran";
      });
      // Fail-fast: the body must not execute while the lock is held elsewhere.
      expect(result).toEqual({ busy: true });
      expect(ran).toBe(false);
    } finally {
      await releaseLock(root);
    }
  });

  it("runs the body and releases the lock on success", async () => {
    const root = await projectRoot();
    const result = await tryWithOrdinaryMutationLock(root, async () => "done");
    expect(result).toEqual({ busy: false, value: "done" });
    // Released, so the next acquirer succeeds rather than inheriting a stale lock.
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    await releaseLock(root);
  });

  it("releases the lock when the body throws, so one failure does not wedge the project", async () => {
    const root = await projectRoot();
    await expect(
      tryWithOrdinaryMutationLock(root, async () => {
        throw new Error("dimension exploded");
      }),
    ).rejects.toThrow("dimension exploded");
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    await releaseLock(root);
  });
});

describe("a busy lock reaches the caller as the product's own error", () => {
  it("ingestTextSource refuses with LockBusyError instead of waiting", async () => {
    const root = await projectRoot();
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    try {
      // Fail-fast end to end: the real entry point must not park on a held lock.
      await expect(ingestTextSource(root, { title: "T", text: "body" })).rejects.toBeInstanceOf(
        LockBusyError,
      );
    } finally {
      await releaseLock(root);
    }
  });
});
