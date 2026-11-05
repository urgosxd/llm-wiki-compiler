/**
 * @file test/fixtures/quickstart-lock-holder.ts
 * @description Hold a Stack's project lock from the TEST process, at the moment a
 * quickstart subprocess releases it, so its compile finds the lock taken.
 *
 * ## Why a database holder and not a lock file
 *
 * The project lock used to be `.llmwiki/lock`, a file, and a test could seed it. It is
 * now a session-scoped Postgres advisory lock keyed by the Stack id
 * (`src/utils/lock-postgres.ts`, `lockKeyFor` in `src/utils/lock.ts`), so a lock FILE
 * contends with nothing. A second CONNECTION is enough: the advisory lock belongs to a
 * session, and this process's session is as foreign to the child as one on another host.
 *
 * ## Why the acquire waits for the child instead of taking the lock up front
 *
 * Both phases of quickstart take the SAME lock: the ingest holds it
 * (`src/services/ingest/service.ts` → `tryWithOrdinaryMutationLock`, fail-fast) and the
 * compile takes it right after (`src/compiler/index.ts` → `acquireMutationLock`,
 * fail-fast). A holder present BEFORE the ingest starts makes the INGEST fail, which is a
 * different scenario from "ingest succeeds, compile is locked out". So the holder waits
 * until the child's ingest session is seen holding the lock and only then issues a
 * BLOCKING acquire: Postgres hands a released advisory lock to the session already queued
 * for it, before a new `pg_try_advisory_lock` from anyone else can take it, so the
 * compile's try loses by queue order rather than by luck.
 *
 * ## How the project lock is identified without duplicating its keys
 *
 * The lock namespace is private to `src/utils/lock-postgres.ts`, and copying the constant
 * here would be a second source of truth for the lock's identity. Instead the holder asks
 * the PRODUCTION helper to take the lock once at setup, reads the `classid` that request
 * appeared under in `pg_locks`, and releases it again -- so the identity always comes from
 * the code that owns it. `objid` is the `hashtext` of the Stack id, and `objsubid` is
 * deliberately not filtered: this Postgres reports both the two-int and the single-bigint
 * advisory forms with `objsubid = 2`, so it cannot discriminate them; `classid` can.
 */

import { createClient } from "llmwiki-kg";
import { tryAcquirePostgresLock } from "../../src/utils/lock-postgres.js";

/** The driver handle the package's factory returns; named structurally, not re-imported. */
type LockClient = ReturnType<typeof createClient>;

/** How often the holder re-checks whether the child has taken the lock. */
const POLL_INTERVAL_MS = 1;

/** Bound on waiting for the child to reach its ingest critical section. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Fail-fast bound for the holder's own connection handshake. */
const CONNECT_TIMEOUT_SECONDS = 10;

/**
 * Block on the project lock `stackId` releases next.
 *
 * Returns ZERO rows while nobody holds that lock and ONE row (`acquired: true`) once the
 * blocking acquire is granted, which makes observation and queueing a single statement:
 * there is no window between seeing the child's lock and asking for it.
 * `pid <> pg_backend_pid()` keeps this session from matching a lock it already holds.
 */
const HOLD_ON_NEXT_RELEASE = `
  select pg_advisory_lock(l.classid::int4, l.objid::int4) as acquired
    from pg_locks l
   where l.locktype = 'advisory'
     and l.granted
     and l.pid <> pg_backend_pid()
     and l.classid::int4 = $1::int4
     and l.objid::int4 = hashtext($2)::int
`;

/** `classid` values currently granted for keys derived from `stackId`, seen from here. */
const GRANTED_CLASSIDS = `
  select distinct l.classid::text as classid
    from pg_locks l
   where l.locktype = 'advisory'
     and l.granted
     and l.pid <> pg_backend_pid()
     and l.objid::int4 = hashtext($1)::int
`;

/** A holder that takes the project lock as soon as the subprocess gives it up. */
export interface ProjectLockHold {
  /**
   * Resolve once this process OWNS the lock, or reject when the subprocess never held it
   * within the timeout. Safe to await more than once.
   */
  hold(): Promise<void>;
  /** Release the lock and close the connection. Idempotent. */
  release(): Promise<void>;
}

/**
 * Start watching `stackId`'s project lock and take it when the child releases it.
 *
 * The watch starts before the caller spawns the subprocess, so the first thing the ingest
 * does cannot be missed.
 *
 * @param stackId - Stack whose lock the subprocess will take (`AKS_STACK_ID`).
 * @param dsn - Connection string of the database carrying that Stack.
 * @param timeoutMs - Bound on the wait for the child's ingest critical section.
 * @returns The pending hold, whose `hold()` resolves once the lock is owned.
 */
export async function holdProjectLockOnNextRelease(
  stackId: string,
  dsn: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProjectLockHold> {
  const client = createClient(dsn, CONNECT_TIMEOUT_SECONDS);
  const classid = await projectLockClassid(client, dsn, stackId);
  // Started HERE, not on the first `hold()`: the caller spawns the subprocess right
  // after this returns, so a lazily-started watch would miss the ingest entirely.
  const holding = acquireWhenChildReleases(client, classid, stackId, timeoutMs);
  // Observed through `hold()`; this keeps an early rejection from surfacing as an
  // unhandled rejection before the caller awaits it.
  holding.catch(() => undefined);
  let released = false;
  return {
    hold: () => holding,
    release: async () => {
      if (released) return;
      released = true;
      await client.unsafe("select pg_advisory_unlock_all()").catch(() => undefined);
      await client.end({ timeout: 0 });
    },
  };
}

/**
 * Read the `classid` the production lock helper's own acquisition appears under.
 *
 * Nobody else can hold this Stack's lock at setup time (the subprocess has not started and
 * the Stack id is unique to the suite), so the only matching row belongs to the probe.
 * The probe is released before returning, leaving the project free for the child's ingest.
 */
async function projectLockClassid(
  client: LockClient,
  dsn: string,
  stackId: string,
): Promise<string> {
  const probe = await tryAcquirePostgresLock(dsn, stackId);
  if (probe === null) throw new Error(alreadyHeldMessage(stackId));
  try {
    const rows = (await client.unsafe(GRANTED_CLASSIDS, [stackId])) as unknown as Array<{
      classid: string;
    }>;
    const classid = rows[0]?.classid;
    if (classid === undefined) throw new Error(notObservableMessage(stackId));
    return classid;
  } finally {
    await probe.release();
  }
}

/** Poll until the blocking acquire is granted, or fail with the reason it was not. */
async function acquireWhenChildReleases(
  client: LockClient,
  classid: string,
  stackId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = (await client.unsafe(HOLD_ON_NEXT_RELEASE, [classid, stackId])) as unknown as unknown[];
    if (rows.length > 0) return;
    if (Date.now() > deadline) throw new Error(neverContendedMessage(stackId, timeoutMs));
    await delay(POLL_INTERVAL_MS);
  }
}

/** Message for a Stack whose project lock was already taken before the run began. */
function alreadyHeldMessage(stackId: string): string {
  return `Stack ${stackId}'s project lock was already held before the run started; nothing to contend with.`;
}

/** Message for the case where the production helper's lock is invisible in `pg_locks`. */
function notObservableMessage(stackId: string): string {
  return `the project lock for Stack ${stackId} is not visible in pg_locks; cannot identify it.`;
}

/** Message for the case that would otherwise read as a mysterious timeout. */
function neverContendedMessage(stackId: string, timeoutMs: number): string {
  return (
    `no session took the project lock for Stack ${stackId} within ${timeoutMs}ms, so the ` +
    "subprocess never reached a mutation phase that locks -- the contention this test " +
    "needs was never set up. Check that the spawned CLI is bound to that Stack " +
    "(AKS_STACK_ID) and can reach its database."
  );
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
