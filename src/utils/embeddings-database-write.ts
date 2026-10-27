/**
 * @file src/utils/embeddings-database-write.ts
 * @description Postgres persistence for page and chunk embedding vectors.
 *
 * Split from `embeddings-database.ts` because the read and write paths are large,
 * independent, and a single file exceeded the project's size limit. The two share
 * exactly one thing -- how the tenant is bound -- which lives with the reader.
 *
 * ## Why one transaction covers header and vectors
 *
 * They describe ONE store. Writing the header first and the vectors after would
 * leave a window where the header claims a configuration the vectors were not built
 * with, and a reader in that window would either compare incompatible vectors or
 * degrade for no reason. The file writer solved this with a single atomic rename; a
 * transaction is the row equivalent.
 *
 * ## Why the write deletes rather than only upserting
 *
 * Vectors for pages that no longer exist must disappear, or a deleted page keeps
 * being retrievable from the corpus that is supposed to have dropped it. The
 * transaction therefore ends by deleting every row this write did not cover, so the
 * table describes exactly the store that was passed in.
 */
import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import { bindStack, splitPageId } from "./embeddings-tenant.js";
import type { ChunkEmbeddingV3, EmbeddingStoreV3, PageEmbeddingV3 } from "./embeddings-store.js";
import { EMBEDDING_MODELS } from "./constants.js";
import { getActiveEmbeddingProviderName } from "./embedding-provider.js";

/**
 * The width `wiki.page_embeddings.vector` and `wiki.page_chunk_embeddings.vector`
 * declare. Kept as one constant so the check above and the schema cannot drift
 * apart silently.
 */
const EMBEDDING_COLUMN_WIDTH = 768;

export async function writeEmbeddingStoreToDb(
  db: Database,
  stackId: string,
  store: EmbeddingStoreV3,
): Promise<void> {
  await db.transaction(async (tx) => {
    await bindStack(tx, stackId);
    await upsertMeta(tx, stackId, store);
    await upsertPageVectors(tx, stackId, store.entries);
    await upsertChunkVectors(tx, stackId, store.chunks ?? []);
    await deleteAbsentPageVectors(tx, stackId, store.entries);
    await deleteAbsentChunkVectors(tx, stackId, store.chunks ?? []);
  });
}

/** Upsert the header row for this Stack. */
async function upsertMeta(tx: Database, stackId: string, store: EmbeddingStoreV3): Promise<void> {
  await tx.execute(sql`
    insert into wiki.embedding_store_meta (stack_id, model, dimensions, fingerprint, updated_at)
    values (${stackId}, ${store.model}, ${store.dimensions}, ${store.fingerprint ?? null}, now())
    on conflict (stack_id) do update
      set model = excluded.model,
          dimensions = excluded.dimensions,
          fingerprint = excluded.fingerprint,
          updated_at = now()
  `);
}

/**
 * Upsert page vectors.
 *
 * An entry whose identity does not parse is skipped, matching the read path: a
 * malformed id is dropped rather than aborting the whole write, because losing the
 * whole store over one bad page is strictly worse than losing that page. The delete
 * pass applies the same filter, so a skipped entry's stale row is removed rather
 * than left behind.
 */
async function upsertPageVectors(
  tx: Database,
  stackId: string,
  entries: readonly PageEmbeddingV3[],
): Promise<void> {
  for (const entry of entries) {
    const split = splitPageId(entry.pageId);
    if (split === null) continue;
    // Check the width BEFORE the insert. `vector(N)` rejects a mismatched vector
    // with a Postgres error that names neither the provider nor the schema, and the
    // caller swallows embedding failures so a compile survives them -- so a
    // misconfigured provider used to look like "search quietly finds nothing".
    // Naming the provider, its width and the column's width makes the fix obvious.
    if (entry.vector.length !== EMBEDDING_COLUMN_WIDTH) {
      throw new Error(
        `embedding width ${entry.vector.length} does not match wiki.page_embeddings.vector(${EMBEDDING_COLUMN_WIDTH}). ` +
        `Provider "${getActiveEmbeddingProviderName()}" (${EMBEDDING_MODELS[getActiveEmbeddingProviderName()] ?? "?"}) produced ${entry.vector.length} dimensions. ` +
        `Use a provider/model that emits ${EMBEDDING_COLUMN_WIDTH} (ollama nomic-embed-text does), or migrate the column to match.`,
      );
    }
    await tx.execute(sql`
      insert into wiki.page_embeddings
        (stack_id, page_directory, slug, title, summary, embedding_text_hash, vector, updated_at)
      values (${stackId}, ${split.pageDirectory}, ${split.slug}, ${entry.title}, ${entry.summary},
              ${entry.embeddingTextHash}, ${toVectorLiteral(entry.vector)}::vector, now())
      on conflict (stack_id, page_directory, slug) do update
        set title = excluded.title,
            summary = excluded.summary,
            embedding_text_hash = excluded.embedding_text_hash,
            vector = excluded.vector,
            updated_at = now()
    `);
  }
}

/** Upsert chunk vectors, skipping any whose page identity does not parse. */
async function upsertChunkVectors(
  tx: Database,
  stackId: string,
  chunks: readonly ChunkEmbeddingV3[],
): Promise<void> {
  for (const chunk of chunks) {
    const split = splitPageId(chunk.pageId);
    if (split === null) continue;
    await tx.execute(sql`
      insert into wiki.page_chunk_embeddings
        (stack_id, page_directory, slug, chunk_index, title, content_hash, text, vector, updated_at)
      values (${stackId}, ${split.pageDirectory}, ${split.slug}, ${chunk.chunkIndex}, ${chunk.title},
              ${chunk.contentHash}, ${chunk.text}, ${toVectorLiteral(chunk.vector)}::vector, now())
      on conflict (stack_id, page_directory, slug, chunk_index) do update
        set title = excluded.title,
            content_hash = excluded.content_hash,
            text = excluded.text,
            vector = excluded.vector,
            updated_at = now()
    `);
  }
}

/**
 * Delete every page vector this write did not cover.
 *
 * One statement rather than one per kept page: the earlier loop deleted rows that
 * did not match each pair in turn, which meant its FIRST iteration already removed
 * everything except one page. A single `NOT IN` over the kept pairs states the
 * intent once and cannot be reordered into that bug.
 *
 * The pairs are rendered as row values because the identity is composite; a slug
 * may itself contain characters that make a string-built predicate ambiguous.
 */
async function deleteAbsentPageVectors(
  tx: Database,
  stackId: string,
  entries: readonly PageEmbeddingV3[],
): Promise<void> {
  const pairs = entries
    .map((entry) => splitPageId(entry.pageId))
    .filter((pair) => pair !== null);
  if (pairs.length === 0) {
    // An empty store means every row belongs to a store that no longer exists.
    await tx.execute(sql`delete from wiki.page_embeddings where stack_id = ${stackId}`);
    return;
  }
  const values = sql.join(
    pairs.map((pair) => sql`(${pair.pageDirectory}, ${pair.slug})`),
    sql`, `,
  );
  await tx.execute(sql`
    delete from wiki.page_embeddings
    where stack_id = ${stackId}
      and (page_directory, slug) not in (${values})
  `);
}

/**
 * Delete every chunk vector this write did not cover, keyed by page and index.
 *
 * Same single-statement shape as the page delete, with the chunk index as the third
 * column of the row value: chunk identity is the triple, never a delimited string.
 */
async function deleteAbsentChunkVectors(
  tx: Database,
  stackId: string,
  keptChunks: readonly ChunkEmbeddingV3[],
): Promise<void> {
  const triples: Array<{ pageDirectory: string; slug: string; chunkIndex: number }> = [];
  for (const chunk of keptChunks) {
    const split = splitPageId(chunk.pageId);
    if (split === null) continue;
    triples.push({ ...split, chunkIndex: chunk.chunkIndex });
  }
  if (triples.length === 0) {
    await tx.execute(sql`delete from wiki.page_chunk_embeddings where stack_id = ${stackId}`);
    return;
  }
  const values = sql.join(
    triples.map((t) => sql`(${t.pageDirectory}, ${t.slug}, ${t.chunkIndex})`),
    sql`, `,
  );
  await tx.execute(sql`
    delete from wiki.page_chunk_embeddings
    where stack_id = ${stackId}
      and (page_directory, slug, chunk_index) not in (${values})
  `);
}

/**
 * Render a numeric vector as pgvector's text literal.
 *
 * The driver cannot bind an array to a `vector` column directly, so the value is
 * formatted here and cast in SQL. Non-finite components are refused rather than
 * written: NaN survives a round trip but silently poisons every cosine score it
 * touches.
 *
 * @param vector - Components to render.
 * @returns The `[a,b,c]` literal pgvector accepts.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  const rendered = vector.map((value) => {
    if (!Number.isFinite(value)) throw new Error("embedding vector contains a non-finite component");
    return String(value);
  });
  return `[${rendered.join(",")}]`;
}
