/**
 * Postgres advisory lock, used instead of the lock file when a Stack is configured.
 *
 * ## Why a DEDICATED connection
 *
 * An advisory lock belongs to a SESSION, not to a transaction or a database. A
 * pooled client hands connections back after each query, so a lock taken on one
 * checkout and released on the next would release NOTHING: the unlock runs on a
 * different session, Postgres warns "you don't own a lock of type ExclusiveLock",
 * and the lock stays held until that connection dies. The connection is therefore
 * reserved for the lock's whole lifetime and closed on release.
 *
 * ## Why the caller-visible shape stays `releaseLock(root)`
 *
 * A root string cannot say which session to unlock on. {@link lockRegistry} keeps
 * that association in-process, so every existing acquire/release call site keeps its
 * signature: a lock this process holds is found by root, and a lock it does not hold
 * releases as a no-op -- the same semantics the file path already had for a foreign
 * PID.
 *
 * ## What this buys over the file lock
 *
 * Visibility across machines. Two hosts sharing one Stack each held "the" lock on
 * their own disk and could compile the same corpus concurrently; an advisory lock is
 * one row of shared state they both contend for.
 */

import { createClient } from "llmwiki-kg";

/**
 * Namespace for this application's advisory locks.
 *
 * The two-int form keeps unrelated tooling that shares the database from colliding
 * by accident: a bare `hashtext(path)` occupies a key space anyone else may pick
 * from too.
 */
const LOCK_NAMESPACE = 0x4c57;

/** Seconds to wait for a connection before treating the lock as unavailable. */
const CONNECT_TIMEOUT_SECONDS = 10;

/**
 * A held advisory lock.
 *
 * `release` is idempotent. The file-backed path tolerated a double release (an
 * already-removed file was ignored), and a cleanup path must not start crashing
 * because the resource behind it is a connection.
 */
export interface HeldPostgresLock {
  /** Release the lock and close the reserved connection. Safe to call twice. */
  release(): Promise<void>;
}

/** Locks this process holds, keyed by the resolved project root. */
export const lockRegistry = new Map<string, HeldPostgresLock>();

/**
 * Try to take the advisory lock for `lockKey`, without waiting.
 *
 * Non-blocking by design: `acquireLockBlocking` already owns the waiting policy, and
 * blocking inside the query would hide that policy where the timeout could not be
 * observed or tested.
 *
 * @param dsn - PostgreSQL connection string.
 * @param lockKey - Stable identity being locked, normally the resolved project root.
 * @returns The held lock, or null when another session already holds it.
 * @throws When the connection cannot be established; the caller decides whether that
 *   means "no database" or a hard failure.
 */
export async function tryAcquirePostgresLock(
  dsn: string,
  lockKey: string,
): Promise<HeldPostgresLock | null> {
  // `max: 1` makes the reservation below the entire pool, so no query can ever run
  // on a second connection and mistake itself for the lock holder.
  const client = createClient(dsn, CONNECT_TIMEOUT_SECONDS);
  let reserved: ReturnType<typeof client.reserve> extends Promise<infer R> ? R : never;
  try {
    reserved = await client.reserve();
  } catch (error) {
    await client.end({ timeout: 0 });
    throw error;
  }
  try {
    const rows = await reserved<{ acquired: boolean }[]>`
      select pg_try_advisory_lock(${LOCK_NAMESPACE}::int, hashtext(${lockKey})::int) as acquired
    `;
    if (rows[0]?.acquired !== true) {
      await reserved.release();
      await client.end({ timeout: 0 });
      return null;
    }
  } catch (error) {
    await reserved.release();
    await client.end({ timeout: 0 });
    throw error;
  }
  return { release: releaseSession(reserved, client, lockKey) };
}

/**
 * Build the idempotent release closure for one reserved connection.
 *
 * @param reserved - The connection holding the lock.
 * @param client - The client that owns it, closed after the reservation returns.
 * @param lockKey - The key that was locked; passed in rather than recomputed, so a
 *   caller's root spelling changing mid-run cannot unlock a different key.
 * @returns A release function safe to call more than once.
 */
function releaseSession(
  reserved: ReservedConnection,
  client: PostgresClient,
  lockKey: string,
): () => Promise<void> {
  let alreadyReleased = false;
  return async () => {
    if (alreadyReleased) return;
    alreadyReleased = true;
    try {
      await reserved`
        select pg_advisory_unlock(${LOCK_NAMESPACE}::int, hashtext(${lockKey})::int)
      `;
    } catch {
      // Closing the connection drops its advisory locks anyway, so a failed explicit
      // unlock is not worth surfacing: the lock is released either way.
    }
    await reserved.release();
    await client.end({ timeout: 0 });
  };
}

/** A connection checked out of the pool, holding the advisory lock. */
type ReservedConnection = Awaited<ReturnType<ReturnType<typeof createClient>["reserve"]>>;

/** The client owning a reserved connection. */
type PostgresClient = ReturnType<typeof createClient>;
