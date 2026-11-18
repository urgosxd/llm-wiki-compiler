/**
 * @file src/utils/mutation-lock.ts
 * @description Acquire the project lock for a mutation and pass the recovery gate.
 *
 * ## What this replaces
 *
 * `src/operation-bundles/lock-gate.ts` (806 lines) wrapped the raw lock with a gate that
 * first settled any pending OPERATION BUNDLE -- a run store, a capacity sweep, a key
 * epoch, a preparation lifecycle. All of that is gone: the wiki dimension owns pages,
 * events, relations and artifacts, and none of them is an operation bundle.
 *
 * What survives is the part that was never about bundles: take the lock, then refuse to
 * proceed while the JOURNAL is unsafe or unsettled. That is the wiki's own recovery
 * contract -- `replayJournal` restores a crash-interrupted page batch before any new
 * mutation begins -- so the gate is narrower, not weaker.
 *
 * ## Why the gate releases the lock on refusal
 *
 * A caller that receives `RecoveryGateError` is not going to mutate anything, and a lock
 * still held by a refused attempt would block every later run until its lease expires. The
 * release happens before the throw, so the two lock helpers have no failure path that
 * leaves the project locked.
 */

import {
  acquireLock, acquireLockBlocking, releaseLock,
  type AcquireLockOptions, type BlockingLockOptions,
} from "./lock.js";
import { recoverJournalBeforeCompile, JournalUnsafeError } from "../trust/journal-recovery.js";

/** Intent labels kept so call sites and diagnostics read the same as before. */
export type MutationGateIntent =
  | "ordinary" | "review" | "recovery" | "quarantine" | "sweep" | "prune" | "handoff" | "reset";

/**
 * Run the recovery gate, releasing the held lock if it refuses.
 *
 * The release runs under the SAME environment the acquire used. `acquireLock` keys the
 * advisory lock on `options.env`'s Stack, and `releaseLock` finds the held connection in
 * `lockRegistry` by the key IT derives from the environment it is given — so releasing
 * with the default `process.env` while the caller passed a different Stack found nothing
 * to release, fell through to a file lock that was never written, and left the
 * session-level advisory lock held on the caller's reserved connection until the process
 * died. A per-request host (one process, many Stacks) is exactly that caller.
 *
 * @param root - Absolute project root whose journal is settled.
 * @param env - The environment the caller acquired with; defaults to `process.env`.
 * @throws {JournalUnsafeError} when the journal is unsafe or cannot be replayed.
 */
async function gateOrRelease(root: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // No `.catch(() => unsafe)`: that collapsed every failure -- an unsafe journal, a
  // symlink escape, and an unexpected replay fault -- into one private error type
  // nobody catches. `recoverJournalBeforeCompile` already maps the unsafe cases to
  // `status: "unsafe"` and rethrows anything else, so the only error to raise here is
  // the one `compile` used to raise from its own recovery check.
  const recovery = await recoverJournalBeforeCompile(root);
  if (recovery.status !== "unsafe") return;
  await releaseLock(root, env);
  throw new JournalUnsafeError("pre-compile journal recovery unsafe");
}

/**
 * Acquire the project lock (non-blocking) for a mutation, then pass the recovery gate.
 *
 * The `recovery` intent is EXEMPT from the gate. It is the one caller whose entire
 * job is to settle the journal, so running recovery-for-recovery first consumes the
 * pending batch and leaves the command reporting "Nothing to recover" -- the gate
 * doing the work it was supposed to be protecting.
 *
 * @param root - Absolute project root.
 * @param intent - The mutation's purpose; `recovery` skips the gate.
 * @param options - Passed through to {@link acquireLock}.
 * @returns False when the lock is already held elsewhere; throws when the gate refuses.
 */
export async function acquireMutationLock(
  root: string,
  intent: MutationGateIntent,
  options: AcquireLockOptions = {},
): Promise<boolean> {
  const acquired = await acquireLock(root, options);
  if (!acquired) return false;
  if (intent === "recovery") return true;
  await gateOrRelease(root, options.env);
  return true;
}

/**
 * Acquire the project lock (bounded-blocking) for a mutation, then pass the recovery gate.
 *
 * @param root - Absolute project root.
 * @param intent - Retained for call-site symmetry.
 * @param options - Passed through to {@link acquireLockBlocking}.
 * @throws {RecoveryGateError} when the gate refuses; the lock is already released.
 */
export async function acquireMutationLockBlocking(
  root: string,
  intent: MutationGateIntent,
  options: BlockingLockOptions = {},
): Promise<void> {
  await acquireLockBlocking(root, options);
  if (intent === "recovery") return;
  await gateOrRelease(root, options.env);
}

/**
 * Run a mutation under the project lock, waiting for it, and pass the recovery gate.
 *
 * The blocking variant is right for a CLI invocation: a human asked for one thing and
 * waiting is the obvious behaviour.
 *
 * @param root - Absolute project root.
 * @param fn - The mutation, run while the lock is held.
 * @returns Whatever `fn` returns.
 */
async function withOrdinaryMutationLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    return await fn();
  } finally {
    await releaseLock(root);
  }
}

/**
 * Run a mutation under the project lock, or report that someone else holds it.
 *
 * Fail-fast is right for a request handler: a caller waiting on an HTTP request should be
 * told the project is busy rather than held open behind a compile.
 *
 * ## The environment is the request's, and it must reach BOTH halves
 *
 * A caller that serves many Stacks from one process resolves one Stack per request and
 * carries it in the environment it passes here. Acquiring without it made the lock read
 * `process.env` instead, so the ingest half took the PATH-keyed file lock while the
 * compile half of the same operation took the Stack-keyed advisory lock: two different
 * locks for one operation, and two Stacks colliding on one path key.
 *
 * The release is the other half and is not optional. `releaseLock` looks the held
 * connection up in `lockRegistry` under the key IT derives from the environment it is
 * given, so acquiring under a request's Stack and releasing under `process.env` finds
 * nothing, falls through to a file lock that was never written, and leaves the
 * session-level advisory lock held on the caller's reserved connection until the process
 * dies. That is why the `finally` below releases with the SAME `options.env`.
 *
 * @param root - Absolute project root.
 * @param fn - The mutation, run while the lock is held.
 * @param options - The caller's environment (the Stack it resolved), passed through to
 *   {@link acquireMutationLock} AND to the release; omitting it keeps the ambient
 *   `process.env` behaviour every existing caller has.
 * @returns The mutation's result, or `busy` when the lock was held elsewhere.
 */
export async function tryWithOrdinaryMutationLock<T>(
  root: string, fn: () => Promise<T>, options: AcquireLockOptions = {},
): Promise<{ busy: true } | { busy: false; value: T }> {
  const acquired = await acquireMutationLock(root, "ordinary", options);
  if (!acquired) return { busy: true };
  try {
    return { busy: false, value: await fn() };
  } finally {
    // Symmetric with the acquire above, including the throwing path: see the header.
    await releaseLock(root, options.env);
  }
}
