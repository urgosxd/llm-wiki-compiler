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
import type { DatabaseHandle } from "@repo/foundation";
import { bindStack, splitPageId } from "./embeddings-tenant.js";
import {
  embeddingIdentityDigest,
  resolveEmbeddingFingerprintIdentity,
  type ChunkEmbeddingV3,
  type EmbeddingFingerprintIdentity,
  type EmbeddingStoreV3,
  type PageEmbeddingV3,
} from "./embeddings-store.js";
import { EMBEDDING_MODELS } from "./constants.js";
import { getActiveEmbeddingProviderName } from "./embedding-provider.js";

/**
 * The width `wiki.page_embeddings.vector` and `wiki.page_chunk_embeddings.vector`
 * declare. Kept as one constant so the check above and the schema cannot drift
 * apart silently.
 */
const EMBEDDING_COLUMN_WIDTH = 768;

/**
 * The fingerprint inputs a header row may record, or NULLs when this write cannot
 * vouch for them.
 *
 * NULL is the correct answer whenever the proof below fails: it says "unknown", which
 * is exactly what a digest produced in another environment leaves behind. A guess
 * would be worse than nothing, because a reader treats a populated pair as evidence.
 */
interface RecordedFingerprintInputs {
  readonly backend: string | null;
  readonly endpoint: string | null;
}

/** The one shape an unproven write records. */
const UNRECORDED_INPUTS: RecordedFingerprintInputs = { backend: null, endpoint: null };

/**
 * The inputs this write may record beside `store.fingerprint`.
 *
 * TWO proofs, both required. The digest must equal the one the ACTIVE configuration
 * produces — that is what makes these values THE inputs of the stored digest, since
 * no other triple hashes to it — and the stored `model` must equal the resolved one, or
 * the row would carry four values (backend, model, endpoint, fingerprint) that cannot
 * be reconciled. Anything unproven records NULL rather than a plausible-looking lie.
 */
function recordableFingerprintInputs(store: EmbeddingStoreV3): RecordedFingerprintInputs {
  if (typeof store.fingerprint !== "string") return UNRECORDED_INPUTS;
  const identity = resolveIdentityOrNull();
  if (identity === null) return UNRECORDED_INPUTS;
  if (store.model !== identity.model) return UNRECORDED_INPUTS;
  if (embeddingIdentityDigest(identity) !== store.fingerprint) return UNRECORDED_INPUTS;
  return { backend: identity.backend, endpoint: redactEndpointCredentials(identity.endpoint) };
}

/**
 * The active identity, or null when resolution refuses the configuration.
 *
 * Recording is DIAGNOSTIC here, so a configuration the resolver rejects must not turn a
 * header write that used to succeed into a failure. NULL then says the inputs are
 * unknown, which is true.
 */
function resolveIdentityOrNull(): EmbeddingFingerprintIdentity | null {
  try {
    return resolveEmbeddingFingerprintIdentity();
  } catch {
    return null;
  }
}

/**
 * Strip credentials from an endpoint before it is stored in CLEARTEXT.
 *
 * The endpoint is operator-supplied free text (`OPENAI_EMBEDDINGS_BASE_URL`,
 * `OLLAMA_HOST`, ...) and may carry a token as userinfo or as a query parameter — which
 * is exactly why the fingerprint hashes it. Scheme, host, port and path are kept, so the
 * value still identifies the server; userinfo, query and fragment are dropped.
 */
function redactEndpointCredentials(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    // Not a URL (for example a bare `host:port`), so there is no scheme to rebuild.
    return stripInlineCredentials(endpoint);
  }
}

/** Redact a value that is not a parseable URL, where userinfo can still appear. */
function stripInlineCredentials(value: string): string {
  const bare = value.split(/[?#]/, 1)[0] ?? "";
  const userinfoEnd = bare.indexOf("@");
  return userinfoEnd === -1 ? bare : bare.slice(userinfoEnd + 1);
}

export async function writeEmbeddingStoreToDb(
  db: DatabaseHandle,
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

/**
 * Upsert the header row for this Stack.
 *
 * The fingerprint's inputs are recorded from the SAME resolver the digest comes from,
 * and only when their digest IS the fingerprint being written — see
 * {@link recordableFingerprintInputs}. `model`, `dimensions`, `min_similarity` and
 * `fingerprint` are written exactly as before; the inputs are evidence beside them and
 * nothing compares them.
 */
async function upsertMeta(tx: DatabaseHandle, stackId: string, store: EmbeddingStoreV3): Promise<void> {
  const recorded = recordableFingerprintInputs(store);
  await tx.execute(sql`
    insert into wiki.embedding_store_meta
      (stack_id, model, dimensions, fingerprint, backend, endpoint, min_similarity, updated_at)
    values (${stackId}, ${store.model}, ${store.dimensions},
            ${store.fingerprint ?? null}, ${recorded.backend}, ${recorded.endpoint},
            ${store.minSimilarity ?? null}, now())
    on conflict (stack_id) do update
      set model = excluded.model,
          dimensions = excluded.dimensions,
          fingerprint = excluded.fingerprint,
          backend = excluded.backend,
          endpoint = excluded.endpoint,
          min_similarity = excluded.min_similarity,
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
  tx: DatabaseHandle,
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
  tx: DatabaseHandle,
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
  tx: DatabaseHandle,
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
  tx: DatabaseHandle,
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
