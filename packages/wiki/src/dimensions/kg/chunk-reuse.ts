/**
 * @file packages/wiki/src/dimensions/kg/chunk-reuse.ts
 * @description The chunk-hash ledger a re-ingest reads before it pays to extract again: the
 * statements that read the set of chunk texts this source has ALREADY been extracted for, and
 * the write that records a run's extracted hashes.
 *
 * ## Why the ledger is a table of its own
 *
 * `public.document_chunks` carries a `content_hash` column documented for exactly this skip,
 * but the compiler's ingest path never writes that table: only the vendored HTTP route calls
 * `persistChunks` (`packages/llmwiki-kg/ts/src/routes/ingest/pipeline.ts:128`), and the kg
 * dimension's `commit` registers a document, consolidates entities and consolidates
 * relationships and nothing else. A reader over `document_chunks` would therefore answer
 * "nothing reused" on every run of the only path there is.
 *
 * Writing chunk rows into `document_chunks` from here was rejected for a stronger reason:
 * rows appearing in a table the graph's own retrieval, reclassify and description readers
 * currently find EMPTY on this path would change THEIR behaviour as a side effect of a speed
 * change. So the ledger is hash-only -- `wiki.kg_extracted_chunks` holds
 * `(stack_id, source, content_hash)` and nothing else -- and no existing reader sees it.
 *
 * ## Why this module owns the SQL but not the connection
 *
 * The statements live here so `index.ts` keeps one home per concern: the dimension knows how
 * to SKIP a chunk, not how to read a set. The CONNECTION stays in `index.ts` for a boundary
 * reason rather than a taste one -- `scripts/lint-ratchet.ts` forbids a new file from
 * reaching for `@repo/kg` (wiki must not import kg; the target topology joins them in api),
 * and opening the graph database is a `@repo/kg` import. The adapter already holds that
 * allowance and already opens the database for the graph write and the forget, so the
 * default reader is wired there, around these statements, and nowhere else.
 *
 * Every statement takes a `DatabaseHandle` the caller owns, which is also what lets `commit`
 * record a run's hashes inside its OWN transaction: the graph write and the record of what
 * was extracted then commit or roll back together.
 *
 * ## Why the read binds `app.stack_id` itself
 *
 * The ledger is a tenant relation with row-level security FORCED, so a read that does not
 * bind the tenant answers with ZERO rows rather than an error -- and a silent empty set here
 * reads as "nothing was ever extracted", which is precisely the outcome that would make the
 * skip invisible. The vendored `bindCallerStack` does this for the graph writes, but the
 * barrel (`packages/llmwiki-kg/ts/src/core-index.ts`) does not export it, so the ONE
 * statement it issues is issued here, in the same shape, and nowhere else.
 */

import { sql } from "drizzle-orm";

import type { DatabaseHandle } from "@repo/foundation";

/** The tenant a statement runs for; the same setting the graph writes bind. */
const STACK_ID_SETTING = "app.stack_id";

/**
 * Reads the chunk hashes already extracted for one source.
 *
 * The type `KgDimensionOptions.readExtractedChunkHashes` carries, and the shape the
 * production reader in `index.ts` satisfies: injected so a test or a detect-only run stays
 * free of a database, exactly as `loadOntology` is.
 *
 * @param stackId - The Stack whose ledger is wanted.
 * @param source - Source identity, as `stack_documents.storage_path` records it.
 * @param databaseUrl - Connection override; defaults to the vendored config.
 * @returns Every chunk hash recorded for that Stack and source; empty when none is.
 */
export type ExtractedChunkHashesReader = (
  stackId: string,
  source: string,
  databaseUrl?: string,
) => Promise<ReadonlySet<string>>;

/**
 * Opens the graph database, runs `work` in ONE transaction, and closes the connection.
 *
 * Supplied by the caller because opening the database is a `@repo/kg` import this file may not
 * hold: the lint ratchet forbids a NEW file from reaching for it, and the adapter that owns
 * the allowance passes its own connector in.
 *
 * @param databaseUrl - Connection override; the adapter resolves its default before calling.
 * @param work - The statements to run on the transaction's handle.
 * @returns Whatever `work` returned, once the transaction committed.
 */
export type LedgerConnector = <T>(
  databaseUrl: string | undefined,
  work: (tx: DatabaseHandle) => Promise<T>,
) => Promise<T>;

/**
 * Build the production reuse reader around a connector the adapter supplies.
 *
 * @param connect - Opens the database and gives the statements a transaction handle.
 * @returns A reader in the shape {@link ExtractedChunkHashesReader} declares.
 */
export function createLedgerReader(connect: LedgerConnector): ExtractedChunkHashesReader {
  return async (stackId, source, databaseUrl) =>
    await connect(databaseUrl, (tx) => readLedgerHashes(tx, stackId, source));
}

/**
 * Read the chunk hashes already extracted for one source.
 *
 * Runs on the caller's handle, inside the caller's transaction, because the tenant binding it
 * issues is transaction-local. Scoped by Stack AND source, so a hash recorded for another
 * source can never suppress extraction for this one.
 *
 * @param tx - Transaction the read runs in.
 * @param stackId - The Stack whose ledger is wanted.
 * @param source - Source identity recorded at ingest time.
 * @returns The recorded hashes; an empty set for a source never extracted before.
 */
async function readLedgerHashes(
  tx: DatabaseHandle,
  stackId: string,
  source: string,
): Promise<ReadonlySet<string>> {
  // Transaction-local, exactly as the graph writes set it: the policy on the ledger compares
  // against this setting, and an unbound read returns zero rows instead of failing.
  await tx.execute(sql`select set_config(${STACK_ID_SETTING}, ${stackId}, true)`);
  const rows = await tx.execute<{ content_hash: string }>(sql`
    select content_hash from wiki.kg_extracted_chunks
     where stack_id = ${stackId} and source = ${source}
  `);
  return new Set(rows.map((row) => row.content_hash));
}

/**
 * Record the chunk hashes one run actually EXTRACTED.
 *
 * The `on conflict ... do nothing` is what makes recording idempotent: a re-run of the same
 * content inserts nothing, because the key already holds it. A reused chunk's hash is never
 * passed here -- it is already recorded, and writing it again would make the ledger read as
 * if the work had been redone.
 *
 * @param tx - The commit transaction; `app.stack_id` is bound by the document registration.
 * @param stackId - Stack the document belongs to.
 * @param source - Source identity recorded at ingest time.
 * @param contentHashes - Hashes of the chunks this run sent to the model.
 */
export async function recordExtractedChunkHashes(
  tx: DatabaseHandle,
  stackId: string,
  source: string,
  contentHashes: readonly string[],
): Promise<void> {
  for (const contentHash of contentHashes) {
    // One statement per hash, the same idiom `persistChunks` uses: a single multi-row insert
    // would need the driver's array binding, which is a second convention for the same job
    // and fails silently when it is wrong.
    await tx.execute(sql`
      insert into wiki.kg_extracted_chunks (stack_id, source, content_hash)
      values (${stackId}, ${source}, ${contentHash})
      on conflict (stack_id, source, content_hash) do nothing
    `);
  }
}
