/**
 * @file test/lock-observability.test.ts
 * @description The compile lock must be OBSERVABLE: which key was taken, for which
 * identity, and how long an acquisition waited.
 *
 * A lock that is never observed is indistinguishable from no lock. Every assertion
 * here is about the text a future investigator greps after a compile that hung:
 * `lock: acquired`, `lock: waited <N>ms`, `lock: gave up after <N>ms`.
 *
 * Determinism: no test hopes to land inside a contention window. A real holder takes
 * the lock (an advisory lock on a reserved connection, or a lock leaf naming this live
 * process) and a timer releases it, so the wait is REAL and its length is the only
 * thing measured. Bounds are generous so a slow machine does not flake.
 */

import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { acquireLock, acquireLockBlocking, releaseLock, LockBusyError } from "../packages/wiki/src/utils/lock.js";
import { tryAcquirePostgresLock, type HeldPostgresLock } from "../packages/wiki/src/utils/lock-postgres.js";
import { setVerbose } from "../packages/wiki/src/utils/output.js";
import { LLMWIKI_DIR } from "../packages/wiki/src/utils/constants.js";
import { perRunDatabase } from "./fixtures/per-run-database.js";
import { useLockObservabilitySuite } from "./fixtures/lock-observability-suite.js";

/** This process's own database; provisioning fails loudly rather than skipping. */
const DSN = (await perRunDatabase()).url;

/** Bound generous enough for a loaded CI box; the wait itself is ~60ms. */
const BOUND_MS = 5_000;
/** How long to wait for the SEQUENCING signal (an observed busy attempt) before failing. */
const SEQUENCE_MS = 3_000;
/** Poll interval short enough that the measured wait stays near the hold. */
const INTERVAL_MS = 10;

let root = "";

/** Shared harness: this suite's own temp root, its mock restore and its stdout capture. */
const { lines } = useLockObservabilitySuite("lock-obs-", (assigned) => {
  root = assigned;
});

/** True once a poll attempt has reported the lock as held elsewhere. */
function busySeen(): boolean {
  return lines().some((line) => line.includes("lock: busy"));
}

/** A Stack environment with a fresh identity, so a leaked key cannot block us. */
function stackEnv(): { env: NodeJS.ProcessEnv; stackId: string } {
  const stackId = randomUUID();
  return { env: { AKS_STACK_ID: stackId, AKS_DATABASE_URL: DSN } as NodeJS.ProcessEnv, stackId };
}

/** The file-backed identity: no Stack configured, so the checkout path is the lock. */
const FILE_ENV = {} as NodeJS.ProcessEnv;

/** Plant a lock leaf naming THIS live process, which is not stale, so it BUSY-blocks. */
async function plantLiveLock(): Promise<string> {
  const lockPath = path.join(root, LLMWIKI_DIR, "lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, String(process.pid), "utf-8");
  return lockPath;
}

describe("the lock reports a wait it actually performed", () => {
  it("reports the measured wait against the Stack key", async () => {
    const { env, stackId } = stackEnv();
    const holder = await tryAcquirePostgresLock(DSN, stackId);
    expect(holder).not.toBeNull();
    setVerbose(true);
    const acquire = acquireLockBlocking(root, { timeoutMs: BOUND_MS, intervalMs: INTERVAL_MS, env });
    // SEQUENCED, not timed: the holder is released only once a busy attempt has been
    // observed, so the wait is real however slow the box is.
    try {
      await vi.waitFor(() => expect(busySeen()).toBe(true), { timeout: SEQUENCE_MS });
    } finally {
      await releaseHeld(holder);
    }
    await acquire;
    await releaseLock(root, env);

    const waited = lines().filter((line) => line.includes("lock: waited"));
    expect(waited).toHaveLength(1);
    expect(waited[0]).toContain(`for stack ${stackId} (key=${stackId})`);
    expect(waited[0]).toMatch(/lock: waited \d+ms /);
    expect(Number(/waited (\d+)ms/.exec(waited[0] ?? "")?.[1])).toBeGreaterThan(0);
  });

  it("reports the measured wait against the checkout path", async () => {
    const lockPath = await plantLiveLock();
    setVerbose(true);
    const acquire = acquireLockBlocking(root, { timeoutMs: BOUND_MS, intervalMs: INTERVAL_MS, env: FILE_ENV });
    try {
      await vi.waitFor(() => expect(busySeen()).toBe(true), { timeout: SEQUENCE_MS });
    } finally {
      await unlink(lockPath).catch(() => {});
    }
    await acquire;
    await releaseLock(root, FILE_ENV);

    const waited = lines().filter((line) => line.includes("lock: waited"));
    expect(waited).toHaveLength(1);
    expect(waited[0]).toContain(`for path ${root} (key=${root})`);
    expect(waited[0]).toMatch(/lock: waited \d+ms /);
  });

  it("reports NO wait when the lock was free on the first attempt", async () => {
    await acquireLockBlocking(root, { timeoutMs: BOUND_MS, intervalMs: INTERVAL_MS, env: FILE_ENV });
    await releaseLock(root, FILE_ENV);

    expect(lines().filter((line) => line.includes("lock: waited"))).toEqual([]);
  });
});

describe("the lock reports a wait it could not complete", () => {
  it("reports the exhausted bound for the checkout path and still throws", async () => {
    await plantLiveLock();
    await expect(
      acquireLockBlocking(root, { timeoutMs: 120, intervalMs: INTERVAL_MS, env: FILE_ENV }),
    ).rejects.toBeInstanceOf(LockBusyError);

    const gaveUp = lines().filter((line) => line.includes("lock: gave up after"));
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]).toContain(`waiting for path ${root} (key=${root})`);
    expect(gaveUp[0]).toMatch(/gave up after \d+ms/);
  });

  it("reports the exhausted bound for the Stack key and still throws", async () => {
    const { env, stackId } = stackEnv();
    const holder = await tryAcquirePostgresLock(DSN, stackId);
    expect(holder).not.toBeNull();
    try {
      await expect(
        acquireLockBlocking(root, { timeoutMs: 150, intervalMs: INTERVAL_MS, env }),
      ).rejects.toBeInstanceOf(LockBusyError);
    } finally {
      await releaseHeld(holder);
    }

    const gaveUp = lines().filter((line) => line.includes("lock: gave up after"));
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]).toContain(`waiting for stack ${stackId} (key=${stackId})`);
  });
});

describe("the lock names the key it acquired or lost", () => {
  it("announces the acquired key only under verbose", async () => {
    const { env, stackId } = stackEnv();
    await acquireLock(root, { quiet: true, env });
    await releaseLock(root, env);
    expect(lines().filter((line) => line.includes("lock: acquired"))).toEqual([]);

    setVerbose(true);
    await acquireLock(root, { quiet: true, env });
    await releaseLock(root, env);
    const acquired = lines().filter((line) => line.includes("lock: acquired"));
    expect(acquired).toHaveLength(1);
    expect(acquired[0]).toContain(`lock: acquired stack ${stackId} (key=${stackId})`);
  });

  it("keeps the busy warning and names the holder's key only under verbose", async () => {
    await plantLiveLock();
    expect(await acquireLock(root, { env: FILE_ENV })).toBe(false);
    expect(lines().filter((line) => line.includes("Another compilation is running."))).toHaveLength(1);
    expect(lines().filter((line) => line.includes("lock: busy"))).toEqual([]);

    setVerbose(true);
    expect(await acquireLock(root, { env: FILE_ENV })).toBe(false);
    const busy = lines().filter((line) => line.includes("lock: busy"));
    expect(busy).toHaveLength(1);
    expect(busy[0]).toContain(`lock: busy, held elsewhere: path ${root} (key=${root})`);
  });
});

/** Release a directly-held advisory lock without throwing out of a cleanup path. */
async function releaseHeld(holder: HeldPostgresLock | null): Promise<void> {
  await holder?.release().catch(() => {});
}
