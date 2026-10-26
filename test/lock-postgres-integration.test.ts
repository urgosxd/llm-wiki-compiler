/**
 * The lock facade choosing Postgres over the file, and releasing on the right session.
 *
 * These assert the seam, not the advisory lock itself: with a Stack configured the
 * database decides, and `releaseLock(root)` still takes only the root.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { lockRegistry } from "../src/utils/lock-postgres.js";

const DSN = process.env.LLMWIKI_TEST_DATABASE_URL ?? "";
const suite = DSN === "" ? describe.skip : describe;

/** Environment naming a Stack, so the facade consults the database. */
function stackEnv(): NodeJS.ProcessEnv {
  return { AKS_STACK_ID: randomUUID(), AKS_DATABASE_URL: DSN } as NodeJS.ProcessEnv;
}

suite("the lock facade with a Stack", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pglock-"));
  });

  afterEach(() => {
    // The registry is process-global. A leaked entry makes the NEXT test's size
    // assertion lie, which is a test bug that looks exactly like a product bug.
    lockRegistry.clear();
    rmSync(root, { recursive: true, force: true });
  });

  it("takes the lock through Postgres", async () => {
    const env = stackEnv();
    const acquired = await acquireLock(root, { quiet: true, env });

    expect(acquired).toBe(true);
    expect(lockRegistry.size).toBe(1);
    await releaseLock(root, env);
    expect(lockRegistry.size).toBe(0);
  });

  it("reports busy to a second holder of the same root", async () => {
    //  Two calls share one process, but each reserves its own connection, so this
    // is a real contention check rather than a reentrant one.
    const env = stackEnv();
    await acquireLock(root, { quiet: true, env });
    // The SAME Stack through a second call: the key is the Stack id, so it contends.
    const second = await acquireLock(root, { quiet: true, env });

    expect(second).toBe(false);
    await releaseLock(root, env);
  });

  it("falls back to the file when no Stack is configured", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const acquired = await acquireLock(root, { quiet: true, env });

    expect(acquired).toBe(true);
    expect(lockRegistry.size).toBe(0); // the file path registers nothing
    await releaseLock(root, env);
  });

  it("excludes two DIFFERENT paths that name the SAME Stack", async () => {
    // The defect this closes. Before the fix the key was the resolved PATH, so two
    // hosts serving one Stack had different keys, both acquired, and both compiled
    // the same corpus -- precisely the collision the advisory lock exists to stop.
    const other = mkdtempSync(join(tmpdir(), "pglock-other-"));
    const env = stackEnv();
    try {
      await acquireLock(root, { quiet: true, env });
      expect(await acquireLock(other, { quiet: true, env })).toBe(false);
    } finally {
      await releaseLock(root, env);
      rmSync(other, { recursive: true, force: true });
    }
  });
});
