/**
 * @file src/dimensions/wiki/page-batch-transaction.ts
 * @description The transaction a row-backed page BATCH runs inside, carried in an
 * async scope so the sinks join it without every call site threading a handle.
 *
 * ## The defect this closes
 *
 * A row-backed page batch used to be N transactions. `applyBatch`
 * (`trust/executor.ts`) is a `for` loop over the mutations — correct for the file
 * backend, which needs one `recordPreState` per target inside a SINGLE open journal
 * batch — and the row backend inherited that loop while dropping the unit around it.
 * Each `upsertStoredPage` then called `withTenant` with no `callerTx`, which opens
 * `db.transaction`. So five pages committed five times, and a failure on the fifth
 * left the first four durable: exactly the partial application the journal prevents
 * on the file path, with no journal to replay because a row records no pre-state.
 *
 * ## Why a scope and not a parameter on the sink
 *
 * `PageSink` is a bare function at five call sites, deliberately structural so the
 * trust path stays usable with no database and no Stack. Widening it to carry a
 * `tx` would churn all five for a fact none of them decides. This is the same
 * mechanism `linter/corpus.ts` uses for the page corpus: resolved once per run,
 * nested scopes cannot leak into each other, and a concurrent run cannot corrupt
 * another's.
 *
 * ## Why the trust path never sees a database
 *
 * {@link PageBatchTransaction} is a structural function type. `executor.ts` imports
 * it to wrap its loop, and still cannot reach a pool, a connection, or `llmwiki-kg`.
 * The database stays entirely on this side of the seam.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseHandle } from "@repo/foundation";

const transactionScope = new AsyncLocalStorage<DatabaseHandle>();

/**
 * Run `fn` with `tx` as the ambient batch transaction.
 *
 * Every row write performed inside joins it, so the whole set commits or rolls back
 * together.
 *
 * @param tx - The transaction the batch runs in.
 * @param fn - The batch body.
 * @returns Whatever `fn` returns.
 */
export async function withPageBatchTransaction<T>(
  tx: DatabaseHandle,
  fn: () => Promise<T>,
): Promise<T> {
  return await transactionScope.run(tx, fn);
}

/**
 * The ambient batch transaction, or `undefined` when this call runs outside one.
 *
 * `undefined` is the common case: a single-page write, the ingest coordinator (which
 * supplies its own `tx` explicitly), and every file-backed project. The sinks treat
 * it as "open your own transaction", which is the behaviour they had before this
 * module existed.
 *
 * @returns The active transaction, if any.
 */
export function activePageBatchTransaction(): DatabaseHandle | undefined {
  return transactionScope.getStore();
}
