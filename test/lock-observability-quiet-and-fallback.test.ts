/**
 * @file test/lock-observability-quiet-and-fallback.test.ts
 * @description The two observation claims that no committed test pinned.
 *
 * S2: `quiet` suppresses the PER-ATTEMPT "Another compilation is running." spam, NOT
 * the observation of the wait. A caller who asks for silence about contention still
 * has to be able to answer "was a lock the reason this compile waited" after the run,
 * because that is the one fact the run itself cannot recover.
 *
 * S8: a Stack that is NAMED but has no `AKS_DATABASE_URL` locks a FILE, not the
 * database — `databaseUrlFor` requires both — so its wait must be labelled `path
 * <abs>`. Labelling it `stack <id>` would name a key nobody took and present a
 * checkout-local lock as cross-host cover.
 *
 * Determinism: no test hopes to land inside a contention window. A real holder takes
 * the lock and is released only once a BUSY ATTEMPT has been observed, so the wait is
 * real however slow the box is, and every Stack id is fresh per run because the
 * shared container's advisory keys outlive the run that leaked them.
 */

import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLockBlocking, releaseLock, type BlockingLockOptions } from "../src/utils/lock.js";
import { lockRegistry, tryAcquirePostgresLock, type HeldPostgresLock } from "../src/utils/lock-postgres.js";
import { setVerbose } from "../src/utils/output.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import { perRunDatabase } from "./fixtures/per-run-database.js";

/** Option shape a caller uses when it asks for quiet about contention. */
type QuietCallerOptions = BlockingLockOptions & { quiet: boolean };

/** This process's own database; provisioning fails loudly rather than skipping. */
const DSN = (await perRunDatabase()).url;
/** Bound generous enough for a loaded box; the wait itself is milliseconds. */
const BOUND_MS = 5_000;
/** How long to wait for the SEQUENCING signal (an observed busy attempt). */
const SEQUENCE_MS = 3_000;
/** Poll interval short enough that the measured wait stays near the hold. */
const INTERVAL_MS = 10;

let root = "";
let log: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  setVerbose(false);
  root = await realpath(await mkdtemp(path.join(tmpdir(), "lock-quiet-")));
});

afterEach(async () => {
  lockRegistry.clear();
  setVerbose(false);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** Every stdout line emitted so far, joined per `console.log` call. */
function lines(): string[] {
  return log.mock.calls.map((args: unknown[]) => args.join(" "));
}

/** The lines matching `needle`, in emission order. */
function emitted(needle: string): string[] {
  return lines().filter((line) => line.includes(needle));
}

/**
 * Run one blocking acquire that provably WAITED, releasing the holder of `release`
 * only after a busy attempt has been observed, never on a timer that could fire
 * before the first attempt.
 */
async function acquireWhileHeld(options: QuietCallerOptions, release: () => Promise<void>): Promise<void> {
  // Verbose, so the busy attempt is observable at all. It gates the `lock: busy` line
  // only; the loud "Another compilation is running." warning stays gated on `quiet`.
  setVerbose(true);
  const acquire = acquireLockBlocking(root, options);
  try {
    await vi.waitFor(() => expect(emitted("lock: busy").length).toBeGreaterThan(0), { timeout: SEQUENCE_MS });
  } finally {
    await release();
  }
  await acquire;
}

describe("quiet silences the contention spam, never the wait", () => {
  it("reports the wait for the Stack key even though the caller asked for quiet", async () => {
    const stackId = randomUUID();
    const env = { AKS_STACK_ID: stackId, AKS_DATABASE_URL: DSN } as NodeJS.ProcessEnv;
    const holder = await tryAcquirePostgresLock(DSN, stackId);
    expect(holder).not.toBeNull();

    // `quiet` is not a declared blocking option yet, so it reaches the acquire as a
    // WIDER object: a caller that asks for silence today still gets the observation,
    // and a future quiet plumbed into the wait fails this test instead of landing
    // silently.
    const caller: QuietCallerOptions = { timeoutMs: BOUND_MS, intervalMs: INTERVAL_MS, env, quiet: true };
    await acquireWhileHeld(caller, () => releaseHeld(holder));
    await releaseLock(root, env);

    // The attempts WERE quiet: verbose shows each one happened and lost, while the
    // warning that quiet suppresses never printed.
    expect(emitted("lock: busy").length).toBeGreaterThan(0);
    expect(emitted("Another compilation is running.")).toEqual([]);
    // ...and the wait survived that quiet: exactly one line, naming the Stack identity.
    const waited = emitted("lock: waited");
    expect(waited).toHaveLength(1);
    expect(waited[0]).toContain(`for stack ${stackId} (key=${stackId})`);
    expect(waited[0]).toMatch(/lock: waited \d+ms /);
  });
});

describe("a Stack with no database is labelled by its path, not by its key", () => {
  it("reports the file lock's wait as `path`, never as the Stack's id", async () => {
    // Named Stack, NO `AKS_DATABASE_URL`: `databaseUrlFor` requires both, so this run
    // locks the FILE. The Stack id below is a key nobody takes.
    const stackId = randomUUID();
    const env = { AKS_STACK_ID: stackId } as NodeJS.ProcessEnv;
    const lockPath = path.join(root, LLMWIKI_DIR, "lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, String(process.pid), "utf-8"); // live PID: not stale, so BUSY

    await acquireWhileHeld({ timeoutMs: BOUND_MS, intervalMs: INTERVAL_MS, env, quiet: false }, () =>
      unlink(lockPath).catch(() => {}),
    );
    await releaseLock(root, env);

    // The contention really was on the FILE, and every lost attempt said so...
    const busy = emitted("lock: busy");
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.every((line) => line.includes(`held elsewhere: path ${root} (key=${root})`))).toBe(true);
    // ...so the wait is labelled by the path it locked, and never by the unused Stack id.
    const waited = emitted("lock: waited");
    expect(waited).toHaveLength(1);
    expect(waited[0]).toContain(`for path ${root} (key=${root})`);
    expect(waited[0]).not.toContain(stackId);
  });
});

/** Release a directly-held advisory lock without throwing out of a cleanup path. */
async function releaseHeld(holder: HeldPostgresLock | null): Promise<void> {
  await holder?.release().catch(() => {});
}
