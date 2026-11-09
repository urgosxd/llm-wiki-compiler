/**
 * @file src/utils/embeddings-rank-sql.ts
 * @description Chunk ranking executed by Postgres instead of by Node.
 *
 * ## Why this exists
 *
 * The in-memory ranking path cannot start until the whole store is materialized:
 * `findRelevantChunksV3` receives `store.chunks` and scores it with
 * `cosineSimilarity`. For a 1696-chunk Stack that means transferring 16.1MB of
 * `vector::text` and parsing it with `split(",").map(Number)`. Measured: 196ms to
 * fetch, 236ms to parse, 431ms of pure representation work to answer a question
 * Postgres can answer over an index with four metadata numbers.
 *
 * So this module answers the same question — "which k chunks are closest to this
 * query?" — as ONE query, and returns only the identities plus their cosine.
 *
 * ## Why the cosine is computed in SQL, not in Node
 *
 * The tempting shape is a CTE for the approximate candidate set, then re-verify in
 * Node by fetching those vectors. That defeats the purpose: fetching 90 vectors back
 * costs 21.3ms, more than the whole query. Computing `1 - (vector <=> $1)` inside
 * the same statement keeps every vector inside the database and costs 10ms.
 *
 * Exactness is not sacrificed. `pgvector`'s cosine operator and
 * `cosineSimilarity` agree to 1.4e-07 on this corpus (measured: 30/30 identical
 * top-k, zero order flips), so the floor compares the same number either way.
 *
 * ## The eligibility predicate has NO `archived` term
 *
 * The live gate is `isLegacyScanEligible`: `orphaned !== true && hasTitle`, and it
 * never tests `archived`. Archiving is a freshness SIGNAL — `context/ranking.ts`
 * warns `archived-page` while still returning the page — not an eligibility gate.
 * Adding `and not archived` here would make this path return less than the
 * in-memory one, silently, for a class of page the product deliberately keeps
 * rankable. `title <> ''` is NOT cosmetic either: `title` is `not null default ''`
 * and `hasTitle` is exactly `title !== ''`.
 */

import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";

import type { ChunkRanking, RankedChunk, RankScope } from "./embeddings-load.js";
import { toVectorLiteral } from "./embeddings-database-write.js";
import { bindStack } from "./embeddings-tenant.js";
import { storeMatchesActiveEmbedding } from "./embeddings-store.js";

/** One ranking row as it leaves Postgres. */
interface RankedChunkRow extends Record<string, unknown> {
  page_directory: string;
  slug: string;
  chunk_index: number;
  cosine: number;
  content_hash: string;
}

/**
 * Validate the store, then rank chunks by exact cosine similarity, in Postgres.
 *
 * Returns a discriminated result rather than a bare array so the caller can tell
 * "ranked, and found nothing" from "could not rank": an empty array reads as "no
 * relevant pages", which is a different claim from "the index is unusable".
 *
 * @param db - The database handle.
 * @param stackId - The tenant whose chunks to rank.
 * @param queryVec - Embedded query; the caller has already checked its dimensions.
 * @param k - Maximum hits to return.
 * @param scope - Eligibility and scope constraints applied as SQL predicates.
 * @returns `ranked` with hits (possibly none), or `degraded` with a warning code.
 */
export async function rankChunksInSql(
  db: DatabaseHandle,
  stackId: string,
  queryVec: readonly number[],
  k: number,
  scope: RankScope,
): Promise<ChunkRanking> {
  if (k <= 0) return { kind: "ranked", hits: [] };
  // Bound as a parameter and cast, mirroring the write path, so the vector never
  // becomes SQL text that could be misparsed.
  const literal = toVectorLiteral(queryVec);
  const pageScopeClause = buildPageScopeClause(scope.pageScope);
  const excludedClause = buildExcludedClause(scope.excludedNamespaces);
  // The tenant binding is TRANSACTION-LOCAL (`set_config(..., true)`), so it must
  // be set inside the transaction that reads. Issuing it on the bare handle would
  // apply to a different implicit transaction and be discarded, leaving the RLS
  // policy unbound: every row filtered out, silently, for any connection whose
  // role is not BYPASSRLS. The explicit `stack_id` predicate below is a second
  // guard, not a substitute.
  return db.transaction(async (tx): Promise<ChunkRanking> => {
    await bindStack(tx, stackId);
    const integrity = await assertStoreIntegrityInSql(tx, stackId);
    if (integrity !== null) return integrity;
    const rows = await tx.execute<RankedChunkRow>(sql`
      select c.page_directory, c.slug, c.chunk_index, c.content_hash,
             1 - (c.vector <=> ${literal}::vector) as cosine
      from wiki.page_chunk_embeddings c
      join wiki.pages p
        on p.stack_id = c.stack_id
       and p.page_directory = c.page_directory
       and p.slug = c.slug
      where c.stack_id = ${stackId}
        and not p.orphaned
        and p.title <> ''
        ${excludedClause}
        ${pageScopeClause}
      order by c.vector <=> ${literal}::vector asc
      limit ${k}
    `);
    return { kind: "ranked", hits: rows.map(toRankedChunk) };
  });
}

/**
 * The relational equivalent of `assertEmbeddingStoreValid`, plus the staleness gate.
 *
 * Every check `gateActiveStore` performs on an in-memory store has a row-count
 * form: a header must exist, vectors must be present when dimensions claim they
 * are, and no vector may disagree with the declared width. Checking them here keeps
 * the lightweight path from skipping the gate just because it never built a store.
 *
 * The fingerprint/model comparison is the same one `storeMatchesActiveEmbedding`
 * makes — it reads only those two fields, so the header is enough for it.
 *
 * @param tx - Transaction already bound to the tenant.
 * @param stackId - Stack being ranked.
 * @returns A degraded result when the store cannot be ranked, else null.
 */
async function assertStoreIntegrityInSql(
  tx: DatabaseHandle,
  stackId: string,
): Promise<ChunkRanking | null> {
  const rows = await tx.execute<IntegrityRow>(sql`
    select m.dimensions, m.model, m.fingerprint,
           (select count(*)::int from wiki.page_chunk_embeddings c where c.stack_id = m.stack_id)
         + (select count(*)::int from wiki.page_embeddings p where p.stack_id = m.stack_id) as total,
           (select count(*)::int from wiki.page_chunk_embeddings c
             where c.stack_id = m.stack_id and vector_dims(c.vector) <> m.dimensions) as bad_dims
    from wiki.embedding_store_meta m where m.stack_id = ${stackId}
  `);
  const row = rows[0];
  if (row === undefined) {
    return { kind: "degraded", code: "embedding-index-outdated", reason: "No embedding index found." };
  }
  if (row.bad_dims > 0) {
    return {
      kind: "degraded",
      code: "embedding-store-unavailable",
      reason: `Embedding index failed integrity validation (${row.bad_dims} vector(s) do not match ${row.dimensions} dimensions); rebuilt on next compile.`,
    };
  }
  if (row.total > 0 && row.dimensions === 0) {
    return {
      kind: "degraded",
      code: "embedding-store-unavailable",
      reason: "Embedding index declares 0 dimensions but vectors are present.",
    };
  }
  // Reuses the exact predicate the in-memory gate applies. It reads only
  // `fingerprint` and `model`, so passing the header shape is sufficient and the two
  // paths cannot drift on configuration staleness.
  if (!storeMatchesActiveEmbedding({ model: row.model, fingerprint: row.fingerprint ?? undefined })) {
    return {
      kind: "degraded",
      code: "embedding-index-outdated",
      reason: "Embedding index was built with a different embedding configuration; rebuild with 'llmwiki compile'.",
    };
  }
  return null;
}

/** One integrity row. */
interface IntegrityRow extends Record<string, unknown> {
  dimensions: number;
  model: string;
  fingerprint: string | null;
  total: number;
  bad_dims: number;
}

/**
 * Restrict to the caller's page scope, when it has one.
 *
 * The pair is compared as a rendered id because the scope arrives as qualified
 * `namespace/slug` strings (see `narrowToScope`), and re-deriving a directory per
 * id here would duplicate the namespace mapping that `page-registry` owns.
 *
 * @param pageScope - Qualified ids to keep, or undefined for no restriction.
 * @returns A fragment that constrains the query, or an empty fragment.
 */
function buildPageScopeClause(pageScope: readonly string[] | undefined) {
  if (pageScope === undefined) return sql``;
  // An EMPTY scope is not "no scope": it names nothing, so nothing may be returned.
  if (pageScope.length === 0) return sql`and false`;
  return sql`and (c.page_directory || '/' || c.slug) = any(${toTextArrayLiteral(pageScope)}::text[])`;
}

/**
 * Exclude the namespaces whose retrieval flag is off.
 *
 * `page_directory` carries the namespace name for every row this query can reach
 * (the table's foreign key pins it to `wiki.pages`, whose directory column is
 * constrained to the two reserved names), so the comparison is direct.
 *
 * @param excludedNamespaces - Namespace names to drop; empty means none.
 * @returns A fragment that constrains the query, or an empty fragment.
 */
function buildExcludedClause(excludedNamespaces: readonly string[]) {
  if (excludedNamespaces.length === 0) return sql``;
  return sql`and c.page_directory <> all(${toTextArrayLiteral(excludedNamespaces)}::text[])`;
}

/**
 * Render a Postgres text-array literal, escaping per Postgres rules.
 *
 * One bind parameter pair regardless of batch size, so a large scope cannot hit a
 * parameter ceiling.
 *
 * @param values - Raw strings.
 * @returns An array literal such as `{"a","b"}`.
 */
function toTextArrayLiteral(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
  return `{${quoted.join(",")}}`;
}

/**
 * Project a row onto the contract shape.
 *
 * @param row - Raw ranking row.
 * @returns The ranked chunk.
 */
function toRankedChunk(row: RankedChunkRow): RankedChunk {
  return {
    pageDirectory: row.page_directory,
    slug: row.slug,
    chunkIndex: row.chunk_index,
    // `numeric`-safe: pgvector returns a double, and Drizzle hands it back as a
    // number for `1 - (...)`.
    cosine: Number(row.cosine),
    contentHash: row.content_hash,
  };
}
