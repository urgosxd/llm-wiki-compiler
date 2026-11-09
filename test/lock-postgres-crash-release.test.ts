/**
 * @file test/lock-postgres-crash-release.test.ts
 * @description What a lock does when it is NOT happily acquired and released: the
 * give-up line must name the real cause, a session-level lock must die with its
 * session, and the facade must release on the success AND the failure path.
 *
 * Three subjects share this file because all three are about the lock's edge, not
 * about ordinary exclusion: an acquisition that ran out of time, a holder that was
 * killed, and a mutation that threw while holding the lock. Ordinary mutual exclusion
 * lives in `lock-postgres.test.ts` / `lock-postgres-integration.test.ts`.
 *
 * ## Why the give-up tests exist
 *
 * `pollForLock` retries with `quiet: true`, which also suppresses
 * `Could not reach the lock database.` — so before this file's fix an unreachable
 * database and a genuinely held lock BOTH ended at the same
 * `lock: gave up after <N>ms waiting for …`. That is precisely the question the
 * observability work exists to answer, answered wrongly, so both causes are pinned
 * here: the give-up output must say which one it was.
 *
 * ## Why the crash test kills a real process
 *
 * `src/utils/lock-postgres.ts` claims a comment that closing the connection drops its
 * advisory locks. A comment is not proof. This spawns a real holder, confirms it
 * genuinely holds the key, `SIGKILL`s it (no chance to run cleanup), and asserts the
 * next acquirer gets the key. The reverse assertion — while the child is ALIVE the
 * acquire returns null — is what keeps the post-kill assertion from being vacuous.
 *
 * The database is this process's OWN (see `test/fixtures/per-run-database.ts`) and
 * every key here is a fresh `randomUUID()`, because the container behind it is
 * long-lived: a session-level lock leaked by a killed probe can outlive the run that
 * leaked it, and a shared key would let that leak masquerade as this file's bug.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireLock, acquireLockBlocking, releaseLock, LockBusyError,
} from "../packages/wiki/src/utils/lock.js";
import { lockRegistry, tryAcquirePostgresLock, type HeldPostgresLock } from "../packages/wiki/src/utils/lock-postgres.js";
import { acquireMutationLock, tryWithOrdinaryMutationLock } from "../packages/wiki/src/utils/mutation-lock.js";
import { JournalUnsafeError } from "../packages/wiki/src/trust/journal-recovery.js";
import { LLMWIKI_DIR } from "../packages/wiki/src/utils/constants.js";
import { perRunDatabase } from "./fixtures/per-run-database.js";

/** This process's own database; provisioning fails loudly rather than skipping. */
const DSN = (await perRunDatabase()).url;

/** Bound on the acquisition that must succeed after the holder dies. */
const POST_KILL_BUDGET_MS = 5_000;
/** Bound generous enough for a loaded box; the waits themselves are ~100ms. */
const BOUND_MS = 5_000;
/** How long to wait for the holder child to report it has the lock (tsx start-up). */
const HOLDER_READY_MS = 60_000;
/** Poll interval short enough that the measured wait stays near the hold. */
const INTERVAL_MS = 10;

let log: ReturnType<typeof vi.spyOn>;
let root = "";
let outside = "";
const children: ChildProcess[] = [];
/** Holder scripts this run wrote into the system temp dir, removed in teardown. */
const scripts: string[] = [];
const savedEnv = { stackId: process.env.AKS_STACK_ID, dsn: process.env.AKS_DATABASE_URL };

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  root = await realpath(await mkdtemp(path.join(tmpdir(), "lock-crash-")));
});

afterEach(async () => {
  // A holder that outlived its test still holds a session-level lock: kill it so the
  // next run cannot inherit it. `ESRCH` means it is already gone.
  for (const child of children.splice(0)) {
    try {
      if (child.pid !== undefined && child.exitCode === null) process.kill(child.pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
  for (const script of scripts.splice(0)) await rm(script, { force: true });
  lockRegistry.clear();
  vi.restoreAllMocks();
  for (const [name, value] of [["AKS_STACK_ID", savedEnv.stackId], ["AKS_DATABASE_URL", savedEnv.dsn]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
  if (outside !== "") await rm(outside, { recursive: true, force: true });
  outside = "";
});

/** Every stdout line emitted so far, joined per `console.log` call. */
function lines(): string[] {
  return log.mock.calls.map((args: unknown[]) => args.join(" "));
}

/** True when any emitted line contains `needle`, ANSI escapes and all. */
function sawLine(needle: string): boolean {
  return lines().some((line) => line.includes(needle));
}

/** A Stack environment with a fresh identity, so a leaked key cannot block us. */
function stackEnv(dsn: string = DSN): { env: NodeJS.ProcessEnv; stackId: string } {
  const stackId = randomUUID();
  return { env: { AKS_STACK_ID: stackId, AKS_DATABASE_URL: dsn } as NodeJS.ProcessEnv, stackId };
}

/** A port nothing listens on: bound, read, released. Refuses instantly, never hangs. */
async function closedPort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Release a directly-held advisory lock without throwing out of a cleanup path. */
async function releaseHeld(holder: HeldPostgresLock | null): Promise<void> {
  await holder?.release().catch(() => {});
}

describe("a give-up reports WHICH lock it could not take", () => {
  it("names the unreachable database instead of reporting a bare give-up", async () => {
    const port = await closedPort();
    const { env } = stackEnv(`postgres://test:test@127.0.0.1:${port}/test`);

    await expect(
      acquireLockBlocking(root, { timeoutMs: 150, intervalMs: INTERVAL_MS, env }),
    ).rejects.toBeInstanceOf(LockBusyError);

    // The cause an investigator needs: the lock database was unreachable.
    expect(sawLine("Could not reach the lock database.")).toBe(true);
    expect(sawLine("lock: gave up after")).toBe(true);
  });

  it("names contention when a live session holds the key", async () => {
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

    // The other cause: somebody else holds it. And NOT the database warning.
    expect(sawLine("Another compilation is running.")).toBe(true);
    expect(sawLine("Could not reach the lock database.")).toBe(false);
    expect(sawLine("lock: gave up after")).toBe(true);
  });

  it("announces the wait, not a give-up, when the last attempt wins the lock", async () => {
    // The final attempt is LOUD but it is still an attempt: a holder that releases
    // just as the deadline passes must produce a normal acquisition, not a throw.
    const { env, stackId } = stackEnv();
    const holder = await tryAcquirePostgresLock(DSN, stackId);
    expect(holder).not.toBeNull();
    const acquire = acquireLockBlocking(root, { timeoutMs: 400, intervalMs: INTERVAL_MS, env });
    setTimeout(() => { void releaseHeld(holder); }, 150);

    await expect(acquire).resolves.toBeUndefined();
    await releaseLock(root, env);

    expect(sawLine("lock: waited")).toBe(true);
    expect(sawLine("lock: gave up after")).toBe(false);
  });
});

describe("a session-level lock dies with its session", () => {
  /**
   * Spawn a real holder for `key` that acquires, reports `ready`, then idles.
   *
   * `process.execPath` runs the script DIRECTLY (no `npx` wrapper), so the pid this
   * test kills is the pid holding the lock — with a wrapper the kill would hit the
   * wrapper and leave the real holder alive, which would make the probe prove nothing.
   */
  function startHolder(key: string): { child: ChildProcess; ready: Promise<void> } {
    const modulePath = fileURLToPath(new URL("../packages/wiki/src/utils/lock-postgres.ts", import.meta.url));
    // Written to a temp file rather than passed to `--eval`: the child needs
    // top-level await, which the eval transform rejects.
    const scriptPath = path.join(tmpdir(), `lock-holder-${randomUUID()}.mts`);
    scripts.push(scriptPath);
    writeFileSync(scriptPath, `
import { tryAcquirePostgresLock } from ${JSON.stringify(modulePath)};
const held = await tryAcquirePostgresLock(process.argv[2], process.argv[3]);
if (held === null) { process.stdout.write("busy\\n"); process.exit(3); }
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`);
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath, DSN, key], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("holder child never reported the lock as taken")),
        HOLDER_READY_MS,
      );
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        const out = chunk.toString();
        if (out.includes("ready")) settle(resolve);
        else if (out.includes("busy")) settle(() => reject(new Error("holder child could not take the key")));
      });
      child.on("error", (error) => settle(() => reject(error)));
      child.on("exit", (code) => settle(() => reject(new Error(`holder child exited early (code ${code})`))));
    });
    return { child, ready };
  }

  /** Try the key until it is free or the budget runs out; `null` means still held. */
  async function acquireWithin(key: string, budgetMs: number): Promise<HeldPostgresLock | null> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const held = await tryAcquirePostgresLock(DSN, key);
      if (held !== null) return held;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Wait for a killed child to be reaped; a hung holder must FAIL, never hang the suite. */
  function exited(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("killed holder never exited")), 10_000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  it("frees the key for the next acquirer when the holder is SIGKILLed", async () => {
    // A unique key, so a lock leaked by an earlier killed probe cannot be mistaken
    // for this one and cannot make this one pass.
    const key = `stack ${randomUUID()}`;
    const { child, ready } = startHolder(key);
    await ready;
    expect(child.pid).toBeDefined();

    // The report's other half: while the holder LIVES the key is genuinely taken, so
    // the release below is the kill's doing and not an empty key space.
    const whileAlive = await tryAcquirePostgresLock(DSN, key);
    expect(whileAlive).toBeNull();

    // Hard kill: no exit handler, no finally, no chance to run `release()`.
    process.kill(child.pid as number, "SIGKILL");
    await exited(child);

    const afterKill = await acquireWithin(key, POST_KILL_BUDGET_MS);
    expect(afterKill).not.toBeNull();
    await releaseHeld(afterKill);
  }, 180_000);
});

describe("the lock is released on success and on failure", () => {
  it("frees the Stack after a successful mutation, so the next acquire is immediate", async () => {
    // The facade's own environment, because `tryWithOrdinaryMutationLock` releases
    // through `releaseLock(root)` with no options — exactly what a request handler
    // does. A lock still held here would block every later run of the Stack.
    const { env, stackId } = stackEnv();
    process.env.AKS_STACK_ID = stackId;
    process.env.AKS_DATABASE_URL = DSN;

    const result = await tryWithOrdinaryMutationLock(root, async () => {
      await writeFile(path.join(root, "mutation.txt"), "done", "utf-8");
      return "done";
    });
    expect(result).toEqual({ busy: false, value: "done" });

    expect(await acquireLock(root, { quiet: true, env })).toBe(true);
    await releaseLock(root, env);
  });

  it("frees the Stack when the mutation gate refuses, so the next acquire is immediate", async () => {
    const { env, stackId } = stackEnv();
    process.env.AKS_STACK_ID = stackId;
    process.env.AKS_DATABASE_URL = DSN;

    // A journal that symlinks OUTSIDE the root is the real refusal path: the gate
    // takes the lock, classifies the journal `unsafe`, releases and throws.
    outside = await mkdtemp(path.join(tmpdir(), "lock-crash-journal-"));
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await symlink(outside, path.join(root, LLMWIKI_DIR, "journal"), "dir");

    await expect(acquireMutationLock(root, "ordinary")).rejects.toBeInstanceOf(JournalUnsafeError);

    // ONLY release is asserted here: what the failed mutation left behind is another
    // task's question. If the gate had leaked the lock this acquire would be false.
    expect(await acquireLock(root, { quiet: true, env })).toBe(true);
    await releaseLock(root, env);
  });
});
