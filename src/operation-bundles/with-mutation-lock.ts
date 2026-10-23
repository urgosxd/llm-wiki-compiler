/** Shared ordinary-mutation lock lifetime; admission still belongs to lock-gate. */
import { mkdir } from "node:fs/promises";
import { acquireMutationLock, acquireMutationLockBlocking } from "./lock-gate.js";
import { releaseLock } from "../utils/lock.js";

/** Release only after successfully acquiring, including when the operation throws. */
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
 * WHY FAIL-FAST AND NOT BLOCKING. `withOrdinaryMutationLock` waits for the lock,
 * which is right for a CLI invocation: a human asked for one thing and waiting is
 * the obvious behaviour. A request handler is the opposite case. Concurrency here
 * is not hypothetical — the MCP server is a separate PROCESS sharing the same
 * project, so the lock file is the only thing that can serialize it against the
 * HTTP host. A blocking acquire would park an HTTP request for as long as another
 * client's compile takes, and park it invisibly: the caller learns nothing until
 * it gives up. Returning `busy` lets the caller answer `409` immediately and retry
 * on its own terms.
 *
 * The lock is deliberately the SAME one the ordinary mutation path takes, in the
 * same `.llmwiki/` directory, because the point is to exclude across processes, not
 * merely across call sites in one process.
 *
 * @param root - Project root whose lock is contended.
 * @param fn - Mutation to run while holding the lock.
 * @returns The mutation's result, or `{ busy: true }` when the lock is held.
 */
export async function tryWithOrdinaryMutationLock<T>(
  root: string,
  fn: () => Promise<T>,
): Promise<{ busy: true } | { busy: false; value: T }> {
  // The lock lives at `<root>/.llmwiki/`, so acquiring it requires the root to
  // exist. `ingestText` is documented to CREATE `sources/` under a root that does
  // not exist yet, and the lock is taken before that work — so without this the
  // first ingest into a fresh project would report `busy` forever instead of
  // running. Creating the root is safe here because the caller is about to write
  // into it anyway; a confinement escape still fails closed inside the resolver.
  await mkdir(root, { recursive: true });
  if (!(await acquireMutationLock(root, "ordinary"))) return { busy: true };
  try {
    return { busy: false, value: await fn() };
  } finally {
    await releaseLock(root);
  }
}
