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
import { recoverJournalBeforeCompile } from "../trust/journal-recovery.js";

/** Intent labels kept so call sites and diagnostics read the same as before. */
export type MutationGateIntent =
  | "ordinary" | "review" | "recovery" | "quarantine" | "sweep" | "prune" | "handoff" | "reset";

/** Thrown when the project's journal cannot be settled, so the mutation is refused. */
class RecoveryGateError extends Error {
  constructor(readonly detail: string) {
    super(`project recovery is incomplete; refusing to mutate: ${detail}`);
    this.name = "RecoveryGateError";
  }
}

/**
 * Run the recovery gate, releasing the held lock if it refuses.
 *
 * @param root - Absolute project root whose journal is settled.
 * @throws {RecoveryGateError} when the journal is unsafe or cannot be replayed.
 */
async function gateOrRelease(root: string): Promise<void> {
  const recovery = await recoverJournalBeforeCompile(root).catch(() => ({ status: "unsafe" as const }));
  if (recovery.status === "unsafe") {
    await releaseLock(root);
    throw new RecoveryGateError("the project journal is unsafe");
  }
}

/**
 * Acquire the project lock (non-blocking) for a mutation, then pass the recovery gate.
 *
 * @param root - Absolute project root.
 * @param intent - Retained for call-site symmetry; the wiki gate is not intent-dependent.
 * @param options - Passed through to {@link acquireLock}.
 * @returns False when the lock is already held elsewhere; throws when the gate refuses.
 */
export async function acquireMutationLock(
  root: string,
  intent: MutationGateIntent,
  options: AcquireLockOptions = {},
): Promise<boolean> {
  void intent;
  const acquired = await acquireLock(root, options);
  if (!acquired) return false;
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
  void intent;
  await acquireLockBlocking(root, options);
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
