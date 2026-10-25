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
    rmSync(root, { recursive: true, force: true });
  });

  it("takes the lock through Postgres", async () => {
    const acquired = await acquireLock(root, { quiet: true, env: stackEnv() });

    expect(acquired).toBe(true);
    expect(lockRegistry.size).toBe(1);
    await releaseLock(root);
    expect(lockRegistry.size).toBe(0);
  });

  it("reports busy to a second holder of the same root", async () => {
    //  Two calls share one process, but each reserves its own connection, so this
    // is a real contention check rather than a reentrant one.
    await acquireLock(root, { quiet: true, env: stackEnv() });
    const second = await acquireLock(root, { quiet: true, env: stackEnv() });

    expect(second).toBe(false);
    await releaseLock(root);
  });

  it("falls back to the file when no Stack is configured", async () => {
    const acquired = await acquireLock(root, { quiet: true, env: {} as NodeJS.ProcessEnv });

    expect(acquired).toBe(true);
    expect(lockRegistry.size).toBe(0);
    await releaseLock(root);
  });
});
