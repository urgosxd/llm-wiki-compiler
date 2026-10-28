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
 * @param root - Absolute project root whose journal is settled.
 * @throws {JournalUnsafeError} when the journal is unsafe or cannot be replayed.
 */
async function gateOrRelease(root: string): Promise<void> {
  // No `.catch(() => unsafe)`: that collapsed every failure -- an unsafe journal, a
  // symlink escape, and an unexpected replay fault -- into one private error type
  // nobody catches. `recoverJournalBeforeCompile` already maps the unsafe cases to
  // `status: "unsafe"` and rethrows anything else, so the only error to raise here is
  // the one `compile` used to raise from its own recovery check.
  const recovery = await recoverJournalBeforeCompile(root);
  if (recovery.status !== "unsafe") return;
  await releaseLock(root);
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
  await gateOrRelease(root);
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
  await gateOrRelease(root);
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
export async function withOrdinaryMutationLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
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
 * @param root - Absolute project root.
 * @param fn - The mutation, run while the lock is held.
 * @returns The mutation's result, or undefined when the lock was busy.
 */
export async function tryWithOrdinaryMutationLock<T>(
  root: string, fn: () => Promise<T>,
): Promise<{ busy: true } | { busy: false; value: T }> {
  const acquired = await acquireMutationLock(root, "ordinary");
  if (!acquired) return { busy: true };
  try {
    return { busy: false, value: await fn() };
  } finally {
    await releaseLock(root);
  }
}
