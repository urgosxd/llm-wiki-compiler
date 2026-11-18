/**
 * @file test/ingest-mutation-lock-stack-env.test.ts
 * @description T3 (S4): the ingest mutation lock must be keyed by the REQUEST's Stack.
 *
 * ## Why the Postgres port is stubbed instead of used
 *
 * `test/lock-postgres-*.test.ts` already prove the advisory lock works against a real
 * server. The question here is different and needs no server: WHICH key does the ingest
 * lock helper hand the lock, and is that same key released? A stub that records the key
 * it is called with — and keeps the set of keys it currently holds — answers both
 * deterministically, and the recorded key IS the lock's identity rather than a private
 * map's copy of it. A container here would make a DB-free change need one.
 *
 * ## The contract is split across two files
 *
 * HERE: the helper's key decision, acquire/release symmetry, and the path-keyed
 * behaviour a caller with no environment still gets. In
 * `test/ingest-service-lock-env.test.ts`: the ingest call site actually handing this
 * helper the request's environment. Neither half alone proves the request's Stack
 * reaches the lock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { tryWithOrdinaryMutationLock } from "../packages/wiki/src/utils/mutation-lock.js";
import { AKS_DATABASE_URL_ENV_VAR, AKS_STACK_ID_ENV_VAR } from "../packages/wiki/src/dimensions/activation.js";
import { LOCK_FILE } from "../packages/wiki/src/utils/constants.js";

/** The advisory backend, stubbed: it records the key and tracks what it holds. */
const advisory = vi.hoisted(() => {
  const held = new Set<string>();
  const requested: string[] = [];
  const released: string[] = [];
  const registry = new Map<string, { release(): Promise<void> }>();
  return {
    held,
    requested,
    released,
    registry,
    async tryAcquire(_dsn: string, lockKey: string): Promise<{ release(): Promise<void> } | null> {
      requested.push(lockKey);
      if (held.has(lockKey)) return null;
      held.add(lockKey);
      return {
        async release(): Promise<void> {
          if (held.delete(lockKey)) released.push(lockKey);
        },
      };
    },
  };
});

vi.mock("../packages/wiki/src/utils/lock-postgres.js", () => ({
  lockRegistry: advisory.registry,
  tryAcquirePostgresLock: advisory.tryAcquire,
}));

const STACK = "stack-of-the-request";

/** The environment one request resolved: its Stack, and the database that Stack locks on. */
function stackEnv(): NodeJS.ProcessEnv {
  return {
    [AKS_STACK_ID_ENV_VAR]: STACK,
    [AKS_DATABASE_URL_ENV_VAR]: "postgresql://lock-stub/one-stack",
  };
}

let root = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ingest-lock-stack-env-")));
  advisory.held.clear();
  advisory.requested.length = 0;
  advisory.released.length = 0;
  advisory.registry.clear();
});

afterEach(async () => {
  advisory.held.clear();
  advisory.registry.clear();
  await rm(root, { recursive: true, force: true });
});

/** The path-keyed lock leaf, if a file lock was taken. */
async function lockLeaf(): Promise<string | null> {
  return readFile(path.join(root, LOCK_FILE), "utf-8").catch(() => null);
}

/** Run `fn` with no ambient Stack, so "supplies no environment" means exactly that. */
async function withNoAmbientStack<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env[AKS_STACK_ID_ENV_VAR];
  delete process.env[AKS_STACK_ID_ENV_VAR];
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env[AKS_STACK_ID_ENV_VAR] = saved;
  }
}

describe("the ingest lock is keyed by the request's Stack", () => {
  it("takes the Stack-keyed advisory lock, never the path-keyed file lock", async () => {
    const result = await tryWithOrdinaryMutationLock(root, async () => "ingested", { env: stackEnv() });
    expect(result).toEqual({ busy: false, value: "ingested" });
    // The key, not a boolean: the Stack id is what the lock was contended for.
    expect(advisory.requested).toEqual([STACK]);
    expect(advisory.requested).not.toContain(await realpath(root));
    // The path-keyed lock would have left its leaf behind; the Stack lock never writes one.
    expect(await lockLeaf()).toBeNull();
  });

  it("holds the Stack-keyed lock only while the guarded mutation runs", async () => {
    let heldDuring: string[] = [];
    const result = await tryWithOrdinaryMutationLock(root, async () => {
      heldDuring = [...advisory.held];
      return 7;
    }, { env: stackEnv() });
    expect(result).toEqual({ busy: false, value: 7 });
    expect(heldDuring).toEqual([STACK]);
    expect([...advisory.held]).toEqual([]);
  });
});

describe("the release uses the key the acquire took", () => {
  it("releases the Stack-keyed lock when the guarded mutation THROWS", async () => {
    await expect(tryWithOrdinaryMutationLock(root, async () => {
      throw new Error("boom");
    }, { env: stackEnv() })).rejects.toThrow("boom");
    // A leak here blocks every later request for that Stack until the process dies.
    expect([...advisory.held]).toEqual([]);
    expect(advisory.released).toEqual([STACK]);
    const again = await tryWithOrdinaryMutationLock(root, async () => "again", { env: stackEnv() });
    expect(again).toEqual({ busy: false, value: "again" });
  });

  it("keeps a caller that supplies no environment on the path-keyed file lock", async () => {
    await withNoAmbientStack(async () => {
      let leafDuring: string | null = null;
      const result = await tryWithOrdinaryMutationLock(root, async () => {
        leafDuring = await lockLeaf();
        return "done";
      });
      expect(result).toEqual({ busy: false, value: "done" });
      expect(advisory.requested).toEqual([]);
      expect(leafDuring).toContain(String(process.pid));
      expect(await lockLeaf()).toBeNull();
    });
  });
});
