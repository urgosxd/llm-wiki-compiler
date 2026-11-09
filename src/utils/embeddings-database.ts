/**
 * @file src/utils/embeddings-database.ts
 * @description Postgres-backed replacement for `.llmwiki/embeddings.json`.
 *
 * ## What this replaces and why the shape changed
 *
 * The file store kept the WHOLE corpus in one document: every page vector and every
 * chunk vector, parsed into memory before anything could be ranked. The 64 MiB
 * `MAX_EMBEDDING_STORE_BYTES` cap was therefore not a limit on the corpus — it was a
 * limit on what a single process could hold while decoding. A table removes the
 * reason for the cap rather than raising it.
 *
 * It also fixes the scoping. Vectors describe pages, pages belong to a Stack, so
 * vectors belong to the Stack and to the same isolation policy. A project-scoped
 * file could not express that: two projects sharing one database would have kept
 * private copies of vectors for the same pages.
 *
 * ## What is preserved exactly
 *
 * The read path gates on the store's HEADER — model, dimensions, and configuration
 * fingerprint — before trusting any vector. Rows alone cannot express a header, so
 * `wiki.embedding_store_meta` carries it, one row per Stack. Without it a store
 * built by a different provider would be compared against incompatible vectors
 * instead of being degraded.
 *
 * ## Why these tables are not `document_chunks`
 *
 * `document_chunks` already carries `embedding vector(768)` with an HNSW index, and
 * reusing it looks tempting until the foreign key is checked: it hangs off
 * `stack_documents` (raw L1 documents) while embedding entries hang off
 * `wiki.pages` (compiled L2 pages). A chunk of a source document and a chunk of a
 * compiled page are different subjects with different lifecycles.
 */
import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";
import { rankChunksInSql } from "./embeddings-rank-sql.js";
import { bindStack, splitPageId } from "./embeddings-tenant.js";
import type { PageId } from "./page-id.js";

export { splitPageId };
import type { EmbeddingStoreMeta, EmbeddingStoreSource } from "./embeddings-load.js";
import type { EmbeddingStoreSink } from "./embeddings-storage.js";
import type { EmbeddingStoreLocation } from "./embeddings-store.js";
import { writeEmbeddingStoreToDb } from "./embeddings-database-write.js";
import type { StoredEmbeddingRead } from "./embeddings-storage.js";
import type { ChunkEmbeddingV3, EmbeddingStoreV3, PageEmbeddingV3 } from "./embeddings-store.js";

/** One page vector row, before it is reassembled into a `PageEmbeddingV3`. */
interface PageVectorRow extends Record<string, unknown> {
  page_directory: string;
  slug: string;
  title: string;
  summary: string;
  embedding_text_hash: string;
  vector: string;
  updated_at: Date | string;
}

/** One chunk vector row, before it is reassembled into a `ChunkEmbeddingV3`. */
interface ChunkVectorRow extends Record<string, unknown> {
  page_directory: string;
  slug: string;
  chunk_index: number;
  title: string;
  content_hash: string;
  text: string;
  vector: string;
  updated_at: Date | string;
}

/** The header row that gates whether the vectors may be used at all. */
interface MetaRow extends Record<string, unknown> {
  model: string;
  dimensions: number;
  fingerprint: string | null;
  min_similarity: number | null;
}

/** Reassemble a qualified page id from the pair stored in the table. */
function joinPageId(pageDirectory: string, slug: string): PageId {
  return `${pageDirectory}/${slug}`;
}

/**
 * Read the header for a Stack, or null when no store has ever been written.
 *
 * Absence is distinct from corruption on purpose: "no store yet" lets the caller
 * treat the wiki as un-embedded, while an unreadable header must degrade retrieval
 * with a warning instead of silently rebuilding over paid vectors.
 *
 * @param db - DatabaseHandle handle.
 * @param stackId - Stack whose header to read.
 * @returns The header, or null when this Stack has none.
 */
export async function readEmbeddingMeta(
  db: DatabaseHandle,
  stackId: string,
  callerTx?: DatabaseHandle,
): Promise<{
  model: string;
  dimensions: number;
  fingerprint: string | null;
  minSimilarity: number | null;
} | null> {
  // The tenant binding is TRANSACTION-LOCAL, so it has to run in the same
  // transaction as the read it protects. Binding the pooled handle would attach to
  // a different implicit transaction and be discarded, leaving the policy unbound:
  // every row filtered out, so a healthy Stack reads as "no embedding index" for a
  // connection whose role is not BYPASSRLS. Measured against `llmwiki_app`: 0 rows
  // unbound, 1 bound.
  if (callerTx !== undefined) return readMetaInScope(callerTx, stackId);
  return db.transaction((tx) => readMetaInScope(tx as unknown as DatabaseHandle, stackId));
}

/**
 * Read the header inside an ALREADY-bound transaction.
 *
 * Split out so both callers -- the standalone read and the store read, which needs
 * the same header without opening a second transaction -- share one statement.
 *
 * @param tx - Transaction carrying the tenant binding.
 * @param stackId - Stack whose header to read.
 * @returns The header, or null when this Stack has none.
 */
async function readMetaInScope(
  tx: DatabaseHandle,
  stackId: string,
): Promise<{
  model: string;
  dimensions: number;
  fingerprint: string | null;
  minSimilarity: number | null;
} | null> {
  await bindStack(tx, stackId);
  const rows = await tx.execute<MetaRow>(
    sql`select model, dimensions, fingerprint, min_similarity
        from wiki.embedding_store_meta where stack_id = ${stackId}`,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    model: row.model,
    dimensions: row.dimensions,
    fingerprint: row.fingerprint,
    // NULL is meaningful: an uncalibrated store must not filter.
    minSimilarity: row.min_similarity === null ? null : Number(row.min_similarity),
  };
}

/**
 * Read the whole v3 store for a Stack, reassembled into the shape the loaders
 * already understand.
 *
 * Returns null when the Stack has no header, which is the table equivalent of "the
 * file does not exist". An entry whose `pageId` cannot be recomposed is skipped
 * rather than failing the read: the file loader's contract was that one malformed
 * identity must not make the corpus unavailable.
 *
 * @param db - DatabaseHandle handle.
 * @param stackId - Stack whose store to read.
 * @returns The reassembled store, or null when this Stack has none.
 */
export async function readEmbeddingStoreFromDb(
  db: DatabaseHandle,
  stackId: string,
): Promise<EmbeddingStoreV3 | null> {
  // One transaction for the header AND the vectors: the binding is
  // transaction-local, so reading the header in one transaction and the vectors in
  // another would leave the second read unbound and return zero rows for a Stack
  // that has vectors.
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as DatabaseHandle;
    const meta = await readMetaInScope(scoped, stackId);
    if (meta === null) return null;

    // The tenant predicate is explicit as well as policy-backed. Under a superuser
    // owner the policy is inert, so a query relying on it alone would return every
    // Stack's vectors -- measured on `ingest_outbox`, same shape, same fix.
    const pageRows = await scoped.execute<PageVectorRow>(
      sql`select page_directory, slug, title, summary, embedding_text_hash, vector::text as vector, updated_at
          from wiki.page_embeddings where stack_id = ${stackId}`,
    );
    const chunkRows = await scoped.execute<ChunkVectorRow>(
      sql`select page_directory, slug, chunk_index, title, content_hash, text, vector::text as vector, updated_at
          from wiki.page_chunk_embeddings where stack_id = ${stackId} order by chunk_index asc`,
    );
    return assembleStore(meta, pageRows, chunkRows);
  });
}

/**
 * Assemble the v3 store from already-read rows.
 *
 * Split from the read so the transaction body stays a sequence of statements, and
 * so the header-to-store projection is testable without a database.
 *
 * @param meta - Header read in the same scope as the rows.
 * @param pageRows - Page vector rows.
 * @param chunkRows - Chunk vector rows.
 * @returns The reassembled store.
 */
function assembleStore(
  meta: { model: string; dimensions: number; fingerprint: string | null; minSimilarity: number | null },
  pageRows: PageVectorRow[],
  chunkRows: ChunkVectorRow[],
): EmbeddingStoreV3 {
  const entries = pageRows.map(toPageEntry).filter((entry): entry is PageEmbeddingV3 => entry !== null);
  const chunks = chunkRows.map(toChunkEntry).filter((entry): entry is ChunkEmbeddingV3 => entry !== null);

  const store: EmbeddingStoreV3 = {
    version: 3,
    model: meta.model,
    dimensions: meta.dimensions,
    entries,
    chunks,
  };
  // Only attach the optional header fields when they exist: a store written before
  // fingerprints or calibration existed must stay comparable on `model` alone, and
  // must keep its pre-column behaviour of not filtering.
  const withFingerprint = meta.fingerprint === null ? store : { ...store, fingerprint: meta.fingerprint };
  return meta.minSimilarity === null
    ? withFingerprint
    : { ...withFingerprint, minSimilarity: meta.minSimilarity };
}

/** Convert one page row to an entry, or null when its identity does not parse. */
function toPageEntry(row: PageVectorRow): PageEmbeddingV3 | null {
  const pageId = joinPageId(row.page_directory, row.slug);
  if (splitPageId(pageId) === null) return null;
  return {
    pageId,
    title: row.title,
    summary: row.summary,
    embeddingTextHash: row.embedding_text_hash,
    vector: parseVector(row.vector),
    updatedAt: toIsoString(row.updated_at),
  };
}

/** Convert one chunk row to an entry, or null when its identity does not parse. */
function toChunkEntry(row: ChunkVectorRow): ChunkEmbeddingV3 | null {
  const pageId = joinPageId(row.page_directory, row.slug);
  if (splitPageId(pageId) === null) return null;
  return {
    pageId,
    title: row.title,
    chunkIndex: row.chunk_index,
    contentHash: row.content_hash,
    text: row.text,
    vector: parseVector(row.vector),
    updatedAt: toIsoString(row.updated_at),
  };
}

/**
 * Parse pgvector's text representation (`[1,2,3]`) into numbers.
 *
 * Throws on a malformed vector rather than returning an empty array: an empty
 * vector would score as a valid but meaningless entry, while a throw lets the
 * integrity gate degrade the store the way it did for a corrupt file.
 *
 * @param raw - pgvector text output.
 * @returns The components as numbers.
 */
function parseVector(raw: string): number[] {
  const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (trimmed === "") return [];
  return trimmed.split(",").map((part) => {
    const value = Number(part);
    if (!Number.isFinite(value)) throw new Error(`embedding vector contains a non-numeric component: ${part}`);
    return value;
  });
}

/** Normalise a timestamptz to the ISO string the v3 record type declares. */
function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Adapt `wiki.*` embedding tables to the loader's `EmbeddingStoreSource` seam.
 *
 * ## Why this exists rather than the loader reading the database directly
 *
 * The loader's job is to GATE a store -- version, integrity, configuration -- and it
 * should not need to know where the bytes came from. This adapter is the only place
 * that knows both the tables and the seam, so a future move (a different table, a
 * cache, a replica) changes one function instead of the gate.
 *
 * ## Why absence is a distinct answer
 *
 * The seam's result type separates "absent" from "unavailable" because they degrade
 * differently: a Stack that was never embedded is a reason to build, while a Stack
 * whose rows cannot be read is a reason to warn. Returning "unavailable" for a
 * missing header would make every first query on a fresh Stack emit a warning that
 * looks like a fault.
 *
 * @param db - DatabaseHandle handle.
 * @param stackId - Stack whose store to read.
 * @returns A source the loaders can gate.
 */
export function databaseEmbeddingSource(db: DatabaseHandle, stackId: string): EmbeddingStoreSource {
  return {
    // Rows can rank without materializing the store, which is the whole point of
    // the row store: the file path must read every vector to score anything.
    rankChunks: (queryVec, k, scope) => rankChunksInSql(db, stackId, queryVec, k, scope),
    /**
     * The header only: four numbers, no vectors.
     *
     * This is what makes a lightweight load possible at all. Reading the whole store
     * costs ~588ms on a 1696-chunk Stack because it transfers 16.1MB of
     * `vector::text`; the header costs under a millisecond, and `rankChunks` needs
     * nothing more to answer a query.
     */
    readMeta: async (): Promise<EmbeddingStoreMeta | null> => {
      try {
        const meta = await readEmbeddingMeta(db, stackId);
        if (meta === null) return null;
        return {
          model: meta.model,
          dimensions: meta.dimensions,
          ...(meta.minSimilarity === null ? {} : { minSimilarity: meta.minSimilarity }),
          ...(meta.fingerprint === null ? {} : { fingerprint: meta.fingerprint }),
        };
      } catch (err) {
        // A FAILED read must not return null. `null` means "this Stack has no
        // store", and a caller that believes that rebuilds from scratch — which,
        // on a transient connection failure, would re-embed a corpus that was
        // never lost. Rethrowing keeps "absent" and "unavailable" distinct, the
        // same way `read()` separates those two kinds.
        throw new Error(describeReadFailure(err));
      }
    },
    read: async (): Promise<StoredEmbeddingRead> => {
      try {
        const store = await readEmbeddingStoreFromDb(db, stackId);
        // A Stack with no header has never been embedded. That is absence, not
        // unavailability: the caller should build, not warn.
        if (store === null) return { kind: "absent" };
        return { kind: "parsed", parsed: { version: 3, store: store as unknown as Record<string, unknown> } };
      } catch (err) {
        // A failed read is NOT absence. Reporting it as absent would make a broken
        // connection look like an un-embedded Stack and silently re-embed everything.
        return { kind: "unavailable", reason: describeReadFailure(err) };
      }
    },
  };
}

/** Turn a read failure into the one-line reason the seam's diagnostics expect. */
function describeReadFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Embedding store could not be read from the database: ${message}`;
}

/**
 * Adapt `wiki.*` embedding tables to the writer's `EmbeddingStoreSink` seam.
 *
 * The counterpart to {@link databaseEmbeddingSource}. A read-modify-write pairs
 * them through `EmbeddingStoreLocation`, so a compile that reads rows also writes
 * rows -- reading one and writing the other would update a store nothing consults.
 *
 * A non-v3 store is refused rather than coerced: the tables have no shape for the
 * v1/v2 records, and guessing one would recreate the re-keying bug that made a
 * vector describe one page while sitting under another's identity. The writer only
 * ever produces v3, so a non-v3 here means a caller bypassed the migration core.
 *
 * @param db - DatabaseHandle handle.
 * @param stackId - Stack that owns these vectors.
 * @returns A sink the writer can persist through.
 */
export function databaseEmbeddingSink(db: DatabaseHandle, stackId: string): EmbeddingStoreSink {
  return {
    write: async (store): Promise<void> => {
      if (store.version !== 3) {
        throw new Error(
          `refusing to persist a v${store.version} embedding store to the database: ` +
            "the tables only describe v3 records, and guessing a v3 shape would attach vectors to the wrong pages",
        );
      }
      await writeEmbeddingStoreToDb(db, stackId, store);
    },
  };
}

/**
 * Pair the read and write adapters for one Stack.
 *
 * Composed here rather than in the caller because the two must always travel
 * together: a read-modify-write that resolved them independently could read rows
 * and write the file, updating a store nothing consults. Returning the pair from
 * one function makes that mismatch unrepresentable.
 *
 * @param db - DatabaseHandle handle.
 * @param stackId - Stack that owns these vectors.
 * @returns A location the writer and reader both accept.
 */
export function databaseEmbeddingLocation(db: DatabaseHandle, stackId: string): EmbeddingStoreLocation {
  return {
    source: databaseEmbeddingSource(db, stackId),
    sink: databaseEmbeddingSink(db, stackId),
  };
}
