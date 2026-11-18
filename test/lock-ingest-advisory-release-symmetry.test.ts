/**
 * @file test/lock-ingest-advisory-release-symmetry.test.ts
 * @description T3 (S4): the ingest lock a request acquires is released under the SAME
 * Stack key, against a REAL advisory lock.
 *
 * ## Why this file exists
 *
 * `test/ingest-mutation-lock-stack-env.test.ts` stubs the Postgres port, so it proves
 * which key the helper ASKS for but not what the database did with it. The counterfactual
 * a verifier ran against this code is the reason a real lock is pinned here: with
 * `releaseLock(root)` instead of `releaseLock(root, options.env)` in the `finally`,
 * `pg_locks` still held the Stack's key — `locks=[…] sessions=1` — after BOTH a normal
 * return and a throw, and every later writer on that Stack got `{"busy":true}` until the
 * process exited. A release keyed on the process's own environment instead of the
 * request's therefore does not fail loudly; it wedges one tenant, silently, forever.
 *
 * These three cases pin the three facts that wedge depends on: the key really is the
 * request's Stack (a), the key is really GONE once the guard ends however it ends (b),
 * and while it is held it excludes that Stack and nothing else (c).
 *
 * ## Why every Stack id and every probe is explicit
 *
 * The container is long-lived, so a session-level lock leaked by an earlier killed probe
 * can outlive the run that leaked it; every Stack id is a fresh `randomUUID()` and every
 * observation asks for THAT key. Sessions are counted by the statement they last ran
 * (`pg_try_advisory_lock`) rather than by total connections, so an unrelated pool from a
 * sibling suite cannot make the leak assertion pass or fail on its behalf.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { acquireMutationLock, tryWithOrdinaryMutationLock } from "../packages/wiki/src/utils/mutation-lock.js";
import { releaseLock } from "../packages/wiki/src/utils/lock.js";
import { lockRegistry } from "../packages/wiki/src/utils/lock-postgres.js";
import { AKS_DATABASE_URL_ENV_VAR, AKS_STACK_ID_ENV_VAR } from "../packages/wiki/src/dimensions/activation.js";
import { LOCK_FILE } from "../packages/wiki/src/utils/constants.js";
import { perRunDatabase } from "./fixtures/per-run-database.js";

/** This process's own database; provisioning fails loudly rather than skipping. */
const DSN = (await perRunDatabase()).url;

/** Fail-fast bound for the probe's own connection handshake. */
const CONNECT_TIMEOUT_SECONDS = 10;

/** The namespace `lock-postgres.ts` takes its advisory locks in (`0x4c57`). */
const LOCK_NAMESPACE = "19543";

/**
 * `classid`s granted in THIS database for keys derived from `$1`.
 *
 * Filtered to this database because `pg_locks` is cluster-wide; the object id is a 32-bit
 * hash, so another database's key could otherwise be counted as this one's.
 */
const GRANTED_FOR_KEY = `
  select distinct l.classid::int4::text as classid
    from pg_locks l
   where l.locktype = 'advisory'
     and l.granted
     and l.database = (select oid from pg_database where datname = current_database())
     and l.objid::int4 = hashtext($1)::int
`;

/** How many advisory locks THIS database holds for keys derived from `$1`. */
const HELD_FOR_KEY = `
  select count(*)::int as held
    from pg_locks l
   where l.locktype = 'advisory'
     and l.granted
     and l.database = (select oid from pg_database where datname = current_database())
     and l.objid::int4 = hashtext($1)::int
`;

/** Sessions in this database whose last statement was an advisory-lock acquire. */
const ADVISORY_SESSIONS = `
  select count(*)::int as sessions
    from pg_stat_activity
   where datname = current_database()
     and pid <> pg_backend_pid()
     and query like '%pg_try_advisory_lock%'
`;

type Probe = ReturnType<typeof postgres>;

let root = "";
let probe: Probe;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ingest-advisory-symmetry-")));
  // `postgres` is the driver itself, taken directly: a test may not cross the dimension
  // boundary into `@repo/kg`, whose factory is the same library one wrapper up.
  probe = postgres(DSN, { max: 1, connect_timeout: CONNECT_TIMEOUT_SECONDS, onnotice: () => undefined });
});

afterEach(async () => {
  // Process-global: a leaked entry makes the NEXT test's acquisition fail for a reason
  // that reads exactly like a product bug.
  lockRegistry.clear();
  await probe.end({ timeout: 0 }).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

/** Environment naming ONE Stack, with the database that Stack locks on. */
function stackEnv(stackId: string): NodeJS.ProcessEnv {
  return {
    [AKS_STACK_ID_ENV_VAR]: stackId,
    [AKS_DATABASE_URL_ENV_VAR]: DSN,
  } as NodeJS.ProcessEnv;
}

/** The `classid`s granted for `stackId`'s key, as the database reports them. */
async function grantedClassids(stackId: string): Promise<string[]> {
  const rows = (await probe.unsafe(GRANTED_FOR_KEY, [stackId])) as Array<{ classid: string }>;
  return rows.map((row) => row.classid);
}

/** Locks this database still holds for `stackId`'s key. */
async function heldFor(stackId: string): Promise<number> {
  const rows = (await probe.unsafe(HELD_FOR_KEY, [stackId])) as Array<{ held: number }>;
  return Number(rows[0]?.held ?? 0);
}

/** Sessions left sitting on an advisory-lock acquire in this database. */
async function advisorySessions(): Promise<number> {
  const rows = (await probe.unsafe(ADVISORY_SESSIONS)) as Array<{ sessions: number }>;
  return Number(rows[0]?.sessions ?? 0);
}

/** The path-keyed lock leaf, if a file lock was taken instead of the advisory one. */
async function lockLeaf(): Promise<string | null> {
  return readFile(path.join(root, LOCK_FILE), "utf-8").catch(() => null);
}

describe("while the guard holds it, the lock is the request's Stack and not the path", () => {
  it("holds the Stack's key under its own namespace, and writes no lock file", async () => {
    const stackId = randomUUID();
    let classidsDuring: string[] = [];
    let sessionsDuring = 0;
    await tryWithOrdinaryMutationLock(root, async () => {
      classidsDuring = await grantedClassids(stackId);
      sessionsDuring = await advisorySessions();
      return "ingested";
    }, { env: stackEnv(stackId) });

    // Exactly one lock, under the lock namespace: the key is the Stack id, not the path.
    expect(classidsDuring).toEqual([LOCK_NAMESPACE]);
    // Not vacuous: the holding session IS observable here, so the zero in the next two
    // cases is a release and not a probe that never sees anything.
    expect(sessionsDuring).toBeGreaterThanOrEqual(1);
    // A path-keyed acquire would have written this leaf; the Stack lock never does.
    expect(await lockLeaf()).toBeNull();
  });
});

describe("the guard gives the key back, and holds it against that Stack alone", () => {

  it("leaves no lock and no session after the guard RETURNS", async () => {
    const stackId = randomUUID();
    const result = await tryWithOrdinaryMutationLock(root, async () => "done", { env: stackEnv(stackId) });
    expect(result).toEqual({ busy: false, value: "done" });

    expect(await heldFor(stackId)).toBe(0);
    expect(await advisorySessions()).toBe(0);
  });

  it("leaves no lock and no session after the guard THROWS", async () => {
    const stackId = randomUUID();
    await expect(tryWithOrdinaryMutationLock(root, async () => {
      throw new Error("mutation exploded");
    }, { env: stackEnv(stackId) })).rejects.toThrow("mutation exploded");

    // The leak the counterfactual measured: with the release keyed on `process.env`, this
    // is 1 and every later writer on this Stack is busy until the process exits.
    expect(await heldFor(stackId)).toBe(0);
    expect(await advisorySessions()).toBe(0);
  });

  it("refuses the SAME Stack while held, and admits a different one", async () => {
    const stackA = randomUUID();
    const stackB = randomUUID();
    expect(await acquireMutationLock(root, "ordinary", { env: stackEnv(stackA) })).toBe(true);
    try {
      const sameStack = await tryWithOrdinaryMutationLock(root, async () => "ran", { env: stackEnv(stackA) });
      expect(sameStack).toEqual({ busy: true });
      const otherStack = await tryWithOrdinaryMutationLock(root, async () => "ran", { env: stackEnv(stackB) });
      expect(otherStack).toEqual({ busy: false, value: "ran" });
    } finally {
      await releaseLock(root, stackEnv(stackA));
    }
  });
});
