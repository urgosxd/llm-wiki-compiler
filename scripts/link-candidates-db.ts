/**
 * @file scripts/link-candidates-db.ts
 * @description The database half of the semantic link-candidate measurement: it
 * opens a session it cannot write with, reads the vectors a compile already
 * stored, ranks every paragraph against every concept through the QUERY PATH'S own
 * ranker, and transposes the result into (paragraph → concept) pairs.
 *
 * ## Why the ranking is transposed instead of reimplemented
 *
 * The measurement asks "which concepts is this paragraph about", and both real
 * corpora are 100% `concepts` pages, so there is no page-level ranker to call:
 * `rankChunksInSql` is the only exported ranker that accepts a PRECOMPUTED vector,
 * and every other retrieval entry point (`pickSearchRefs`, `findRelevantChunksV3`,
 * `rankChunksViaSource`) takes a question and calls `embedQuery` internally. Using
 * one of those would compute an embedding, which this command must never do. So the
 * call is inverted instead: each concept page's STORED vector becomes the query, `k`
 * is the stack's whole chunk set, and the rows come back keyed by paragraph. That
 * keeps cosine inside Postgres, inside the index the product already maintains, and
 * out of this file entirely.
 *
 * ## Why coverage is asserted rather than assumed
 *
 * `k` equals the chunk count precisely so nothing is silently truncated: no
 * similarity floor, no `ef_search` clamp and no store-derived filter sits inside
 * that SELECT. A concept that comes back with FEWER rows than the stack has chunks
 * means the database declined to return what was asked for, and the difference
 * between "nothing is similar" and "the answer was cut short" is the difference
 * between an honest report and a quietly empty one. The shortfall is counted, never
 * swallowed.
 *
 * ## Why the session is read-only at the CONNECTION level
 *
 * This command is evidence about a corpus, so it must not be able to change one.
 * `SET default_transaction_read_only = on` is issued as the session's first
 * statement AND sent as a startup parameter, because a pooled driver may open a
 * second connection at any time and a `SET` only covers the connection that ran it.
 * The startup parameter covers every connection the pool can ever open, and the
 * server — not this module's discipline — is what refuses a write.
 *
 * ## Why a credential cannot escape
 *
 * Nothing here emits the DSN, and every string that leaves this module — including a
 * caught driver error, which routinely quotes the connection it failed to make —
 * passes through {@link redactSecrets}. A prior audit leaked one credential from a
 * script like this one; the redaction is total on purpose, not best effort.
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { DatabaseHandle } from "@repo/foundation";

import { rankChunksInSql } from "../packages/wiki/src/utils/embeddings-rank-sql.js";
import { bindStack } from "../packages/wiki/src/utils/embeddings-tenant.js";
import { testDatabaseUrl } from "../test/fixtures/test-database.js";
import type { RawCandidatePair } from "./link-candidates.js";

/**
 * The variable the whole application reads its DSN from.
 *
 * Restated rather than imported so this module's import graph stays shallow: the
 * only module that exports it (`dimensions/activation.ts`) pulls the entire
 * dimension stack in for a ten-character constant, and `utils/lock.ts` already keeps
 * its own private copy for the same reason.
 */
const AKS_DATABASE_URL_ENV_VAR = "AKS_DATABASE_URL";

/** Seconds to wait for a connection before failing, matching `createDimensionsDatabase`. */
const DB_CONNECT_TIMEOUT_SECONDS = 10;

/** Seconds allowed for the pool to drain on close. */
const DB_CLOSE_TIMEOUT_SECONDS = 5;

/** The GUC that makes a session refuse writes, and the value that enables it. */
const READ_ONLY_PARAMETER = "default_transaction_read_only";
const READ_ONLY_VALUE = "on";

/** A `postgres://` or `postgresql://` URL, whatever it carries. */
const DSN_PATTERN = /postgres(?:ql)?:\/\/\S+/gu;

/** What a redacted URL is replaced with: the scheme, and nothing else. */
const REDACTED_DSN = "postgresql://***";

/**
 * The ranker's scope for this measurement.
 *
 * `excludedNamespaces` is empty because the only two corpora measured are 100%
 * `page_directory = 'concepts'`, so there is no namespace whose retrieval flag could
 * exclude a row, and no caller-narrowed `pageScope` either. Both fields are passed
 * explicitly rather than omitted because `RankScope` requires them: an adapter may
 * not drop a filter it cannot express, and a caller may not pretend it has none.
 */
const CONCEPT_ONLY_SCOPE = { excludedNamespaces: [], surface: "search" } as const;

/** One chunk a concept's stored page vector ranked, before inversion. */
export interface ConceptChunkRanking {
  /** The concept that supplied the query vector: `<pageDirectory>/<slug>`. */
  conceptId: string;
  /** The concept's page title, which is the only lexical name a real corpus has. */
  conceptTitle: string;
  /** Every chunk that concept's vector ranked, in any order. */
  hits: readonly {
    pageDirectory: string;
    slug: string;
    chunkIndex: number;
    cosine: number;
  }[];
}

/** One (paragraph → concept) pair after the inversion. */
export interface ParagraphConceptPair {
  /** `<pageDirectory>/<slug>#<chunkIndex>`. */
  paragraphId: string;
  /** The page the paragraph belongs to: `<pageDirectory>/<slug>`. */
  documentId: string;
  conceptId: string;
  conceptTitle: string;
  cosine: number;
}

/** A stack to measure, as the caller named it. */
export interface CorpusSpec {
  stackId: string;
  label: string;
}

/** Row counts, used as the report's read-only proof. */
export interface ReadOnlyCounts {
  pages: number;
  pageEmbeddings: number;
  chunkEmbeddings: number;
}

/** Everything one corpus contributed to the report, before stratification. */
export interface CorpusMeasurement {
  spec: CorpusSpec;
  /** True when the corpus could not be ranked at all; `pairs` is then empty. */
  skipped: boolean;
  skipReason: string | null;
  /** Row counts read before ranking, or null when the corpus was skipped unread. */
  counts: ReadOnlyCounts | null;
  /** How many times the query path's ranker was called. */
  rankingCalls: number;
  /** False when any concept ranked fewer rows than the stack has chunks. */
  coverageComplete: boolean;
  shortfallConcepts: number;
  readOnly: { before: ReadOnlyCounts; after: ReadOnlyCounts; identical: boolean } | null;
  pairs: RawCandidatePair[];
}

/** A session that cannot write, plus the one way to release it. */
export interface ReadOnlySession {
  db: DatabaseHandle;
  close(): Promise<void>;
}

/**
 * Replace every connection URL in `text` with a fixed, credential-free form.
 *
 * @param text - Any string about to be printed, rendered, or stored.
 * @returns The same string with every DSN replaced by `postgresql://***`.
 */
export function redactSecrets(text: string): string {
  return text.replace(DSN_PATTERN, REDACTED_DSN);
}

/**
 * The DSN to measure against: the application's own variable, else the test fixture's default.
 *
 * The fallback is `testDatabaseUrl`, the project's single resolver for this question
 * — it is never the empty string, and it never resolves to the production port, both
 * of which are properties a second copy of this logic would have to re-earn.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @returns A non-empty connection string.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env[AKS_DATABASE_URL_ENV_VAR] ?? "").trim();
  return configured === "" ? testDatabaseUrl(env) : configured;
}

/**
 * Open a read-only session on `url` and prove it is read-only.
 *
 * @param url - Connection string; never emitted.
 * @returns The handle and its closer, or a thrown error whose text is redacted.
 */
export async function openReadOnlySession(url: string): Promise<ReadOnlySession> {
  const client = postgres(url, {
    max: 1,
    connect_timeout: DB_CONNECT_TIMEOUT_SECONDS,
    // Spelled literally because the driver types this key as a BOOLEAN startup
    // parameter; postgres-js renders it as the server-side `on` the check below
    // expects, and the explicit `SET` underneath covers the connection already open.
    connection: { default_transaction_read_only: true },
  });
  const db = drizzle(client) as unknown as DatabaseHandle;
  try {
    await db.execute(sql.raw(`set ${READ_ONLY_PARAMETER} = ${READ_ONLY_VALUE}`));
    const rows = await db.execute<{ [READ_ONLY_PARAMETER]: string }>(
      sql.raw(`show ${READ_ONLY_PARAMETER}`),
    );
    if (rows[0]?.[READ_ONLY_PARAMETER] !== READ_ONLY_VALUE) {
      throw new Error(`session refused to become read-only: ${READ_ONLY_PARAMETER}`);
    }
  } catch (error) {
    await client.end({ timeout: DB_CLOSE_TIMEOUT_SECONDS });
    throw new Error(redactSecrets(describe(error)));
  }
  return { db, close: () => client.end({ timeout: DB_CLOSE_TIMEOUT_SECONDS }) };
}

/**
 * Render any thrown value as text, without letting a DSN through.
 *
 * @param error - Whatever was caught.
 * @returns One redacted line.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run `run` in a transaction with the tenant bound, so RLS sees the stack.
 *
 * The binding is transaction-LOCAL, so it must be set inside the transaction that
 * reads: issuing it on the bare handle would apply to a different transaction and be
 * discarded, leaving the policy unbound and every row filtered out silently.
 *
 * @param db - Handle to open the transaction on.
 * @param stackId - Stack whose rows the callback may read.
 * @param run - The reads.
 * @returns Whatever `run` returned.
 */
function withTenant<T>(
  db: DatabaseHandle,
  stackId: string,
  run: (tx: DatabaseHandle) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await bindStack(tx, stackId);
    return run(tx);
  });
}

/**
 * Count the three row populations the read-only proof compares.
 *
 * @param db - Read-only handle.
 * @param stackId - Stack to count.
 * @returns The counts, as read at this instant.
 */
async function countRows(db: DatabaseHandle, stackId: string): Promise<ReadOnlyCounts> {
  return withTenant(db, stackId, async (tx) => {
    const rows = await tx.execute<{ pages: number; page_embeddings: number; chunk_embeddings: number }>(sql`
      select (select count(*)::int from wiki.pages where stack_id = ${stackId}) as pages,
             (select count(*)::int from wiki.page_embeddings where stack_id = ${stackId}) as page_embeddings,
             (select count(*)::int from wiki.page_chunk_embeddings where stack_id = ${stackId}) as chunk_embeddings
    `);
    const row = rows[0];
    return {
      pages: Number(row?.pages ?? 0),
      pageEmbeddings: Number(row?.page_embeddings ?? 0),
      chunkEmbeddings: Number(row?.chunk_embeddings ?? 0),
    };
  });
}

/** One stored page vector, with its identity and title. */
interface PageVectorRow extends Record<string, unknown> {
  page_directory: string;
  slug: string;
  title: string;
  vector: string;
}

/** One stored chunk, with the text a report excerpt quotes. */
interface ChunkRow extends Record<string, unknown> {
  page_directory: string;
  slug: string;
  chunk_index: number;
  text: string;
}

/** One page body, which is the document-level evidence S6 asks for. */
interface BodyRow extends Record<string, unknown> {
  page_directory: string;
  slug: string;
  body: string;
}

/** Everything one corpus stores, read in one tenant-bound transaction. */
interface CorpusRows {
  pageVectors: PageVectorRow[];
  /** `<pageDirectory>/<slug>` → page body. */
  bodies: Map<string, string>;
  /** `<pageDirectory>/<slug>#<chunkIndex>` → chunk text. */
  chunks: Map<string, string>;
}

/**
 * A page's qualified id, which is also its concept id and its document id.
 *
 * @param pageDirectory - Namespace directory, `concepts` in both measured corpora.
 * @param slug - Page slug.
 * @returns `<pageDirectory>/<slug>`.
 */
function pageIdOf(pageDirectory: string, slug: string): string {
  return `${pageDirectory}/${slug}`;
}

/**
 * Read the vectors, bodies and chunk texts one corpus stores.
 *
 * @param db - Read-only handle.
 * @param stackId - Stack to read.
 * @returns The three populations, keyed for the inversion.
 */
async function readCorpusRows(db: DatabaseHandle, stackId: string): Promise<CorpusRows> {
  return withTenant(db, stackId, async (tx) => {
    const pageVectors = await tx.execute<PageVectorRow>(sql`
      select page_directory, slug, title, vector::text as vector
      from wiki.page_embeddings where stack_id = ${stackId}
      order by page_directory, slug
    `);
    const bodyRows = await tx.execute<BodyRow>(sql`
      select page_directory, slug, body from wiki.pages where stack_id = ${stackId}
    `);
    const chunkRows = await tx.execute<ChunkRow>(sql`
      select page_directory, slug, chunk_index, text
      from wiki.page_chunk_embeddings where stack_id = ${stackId}
      order by page_directory, slug, chunk_index
    `);
    return {
      pageVectors: [...pageVectors],
      bodies: new Map(bodyRows.map((row) => [pageIdOf(row.page_directory, row.slug), row.body])),
      chunks: new Map(
        chunkRows.map((row) => [
          `${pageIdOf(row.page_directory, row.slug)}#${row.chunk_index}`,
          row.text,
        ]),
      ),
    };
  });
}

/**
 * Parse a pgvector `vector::text` value into the array the ranker binds.
 *
 * @param stored - The value as Postgres rendered it, e.g. `[0.1,0.2]`.
 * @returns The vector components.
 */
function parseVector(stored: string): number[] {
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) {
    throw new Error("stored vector is not an array");
  }
  return parsed.map(Number);
}

/** One concept's ranking pass over the whole chunk set. */
interface RankingPass {
  rankings: ConceptChunkRanking[];
  calls: number;
  shortfallConcepts: number;
  /** Set when the ranker declined to rank; already redacted. */
  degradedReason: string | null;
}

/**
 * Rank the whole chunk set once per concept, using that concept's STORED vector.
 *
 * @param db - Read-only handle.
 * @param stackId - Stack whose chunks are ranked.
 * @param pages - The concept pages, and the query vector each supplies.
 * @param expectedChunks - The stack's chunk count, used as both `k` and the coverage bar.
 * @returns The rankings, the call count, and any coverage or capability failure.
 */
async function rankConcepts(
  db: DatabaseHandle,
  stackId: string,
  pages: readonly PageVectorRow[],
  expectedChunks: number,
): Promise<RankingPass> {
  const rankings: ConceptChunkRanking[] = [];
  let calls = 0;
  let shortfallConcepts = 0;
  for (const page of pages) {
    calls += 1;
    const outcome = await rankChunksInSql(
      db,
      stackId,
      parseVector(page.vector),
      expectedChunks,
      CONCEPT_ONLY_SCOPE,
    );
    if (outcome.kind === "degraded") {
      return { rankings: [], calls, shortfallConcepts: 0, degradedReason: redactSecrets(outcome.reason) };
    }
    if (outcome.hits.length < expectedChunks) {
      shortfallConcepts += 1;
    }
    rankings.push({
      conceptId: pageIdOf(page.page_directory, page.slug),
      conceptTitle: page.title,
      hits: outcome.hits,
    });
  }
  return { rankings, calls, shortfallConcepts, degradedReason: null };
}

/**
 * Transpose per-concept rankings into per-paragraph top-k concept pairs.
 *
 * A concept is compared against its OWN page in this transposed direction (its
 * vector lands on its own chunks), so those pairs are dropped BEFORE the top-k cut:
 * filtering afterwards would let a page's self-similarity consume one of the k slots
 * and hide the concept's best genuine neighbour.
 *
 * @param rankings - One ranking per concept, in any order.
 * @param topK - Maximum concepts kept per paragraph.
 * @returns Pairs ordered by `paragraphId`, then `conceptId`.
 */
export function topConceptsPerParagraph(
  rankings: readonly ConceptChunkRanking[],
  topK: number,
): ParagraphConceptPair[] {
  const byParagraph = new Map<string, ParagraphConceptPair[]>();
  for (const ranking of rankings) {
    for (const hit of ranking.hits) {
      const documentId = pageIdOf(hit.pageDirectory, hit.slug);
      if (documentId === ranking.conceptId) continue;
      const paragraphId = `${documentId}#${hit.chunkIndex}`;
      const bucket = byParagraph.get(paragraphId) ?? [];
      bucket.push({
        paragraphId,
        documentId,
        conceptId: ranking.conceptId,
        conceptTitle: ranking.conceptTitle,
        cosine: hit.cosine,
      });
      byParagraph.set(paragraphId, bucket);
    }
  }
  const kept: ParagraphConceptPair[] = [];
  for (const bucket of byParagraph.values()) {
    bucket.sort(compareByCosineThenConcept);
    kept.push(...bucket.slice(0, Math.max(0, Math.floor(topK))));
  }
  return kept.sort(compareByParagraphThenConcept);
}

/**
 * Compare two qualified ids without consulting a locale or a collator.
 *
 * The report has to be byte-identical between runs and machines, and a collator's
 * answer is a property of the ICU build it ships with, so code-unit order is the
 * only comparison this file may use.
 *
 * @param left - First id.
 * @param right - Second id.
 * @returns Negative, zero or positive.
 */
function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Order one paragraph's candidates: cosine descending, then concept id ascending.
 *
 * @param left - First pair.
 * @param right - Second pair.
 * @returns Negative, zero or positive.
 */
function compareByCosineThenConcept(
  left: ParagraphConceptPair,
  right: ParagraphConceptPair,
): number {
  return left.cosine === right.cosine
    ? compareIds(left.conceptId, right.conceptId)
    : right.cosine - left.cosine;
}

/**
 * The report's global order: paragraph id, then concept id.
 *
 * @param left - First pair.
 * @param right - Second pair.
 * @returns Negative, zero or positive.
 */
function compareByParagraphThenConcept(
  left: ParagraphConceptPair,
  right: ParagraphConceptPair,
): number {
  return compareIds(left.paragraphId, right.paragraphId) || compareIds(left.conceptId, right.conceptId);
}

/**
 * Map inverted pairs onto the core's raw candidate shape.
 *
 * `conceptNames` carries the canonical title and nothing else. Both real corpora
 * carry ZERO declared aliases (the live database has no `aliases` column and
 * `wiki.concept_aliases` is empty), so there is no alias source to read here and
 * inventing one would make the lexical-exclusion filter claim coverage it does not
 * have. The alias branch of that filter is exercised by a fixture test only.
 *
 * @param pairs - The inverted pairs, in report order.
 * @param spec - The corpus they came from.
 * @param rows - The texts a pair needs to be judged.
 * @returns Raw pairs ready for stratification.
 */
function toRawPairs(
  pairs: readonly ParagraphConceptPair[],
  spec: CorpusSpec,
  rows: CorpusRows,
): RawCandidatePair[] {
  return pairs.map((pair) => ({
    corpus: spec.label,
    paragraphId: pair.paragraphId,
    documentId: pair.documentId,
    conceptId: pair.conceptId,
    conceptTitle: pair.conceptTitle,
    conceptNames: [pair.conceptTitle],
    cosine: pair.cosine,
    paragraphText: rows.chunks.get(pair.paragraphId) ?? "",
    documentText: rows.bodies.get(pair.documentId) ?? "",
  }));
}

/**
 * Why this corpus cannot be measured at all, or null when it can.
 *
 * @param rows - What the corpus stores.
 * @param counts - The row counts read alongside it.
 * @returns The reason to skip, in the words the caller prints.
 */
function skipReasonFor(rows: CorpusRows, counts: ReadOnlyCounts): string | null {
  if (counts.pageEmbeddings === 0 || rows.pageVectors.length === 0) {
    return "no page embeddings stored for this stack";
  }
  if (counts.chunkEmbeddings === 0 || rows.chunks.size === 0) {
    return "no chunk embeddings stored for this stack";
  }
  return null;
}

/**
 * A measurement that records a corpus as skipped, with the reason.
 *
 * @param spec - The corpus.
 * @param reason - Why it was skipped; already redacted.
 * @param counts - The counts read, or null when nothing could be read.
 * @returns The skipped measurement.
 */
function skippedMeasurement(
  spec: CorpusSpec,
  reason: string,
  counts: ReadOnlyCounts | null,
): CorpusMeasurement {
  return {
    spec,
    skipped: true,
    skipReason: reason,
    counts,
    rankingCalls: 0,
    coverageComplete: false,
    shortfallConcepts: 0,
    readOnly: null,
    pairs: [],
  };
}

/**
 * Measure one corpus, read-only, through the query path's own ranker.
 *
 * @param db - Read-only handle.
 * @param spec - The stack and the label it is reported under.
 * @param topK - Maximum concepts kept per paragraph.
 * @returns The corpus's contribution to the report.
 */
export async function measureCorpus(
  db: DatabaseHandle,
  spec: CorpusSpec,
  topK: number,
): Promise<CorpusMeasurement> {
  const before = await countRows(db, spec.stackId);
  const rows = await readCorpusRows(db, spec.stackId);
  const skipReason = skipReasonFor(rows, before);
  if (skipReason !== null) return skippedMeasurement(spec, skipReason, before);
  const pass = await rankConcepts(db, spec.stackId, rows.pageVectors, before.chunkEmbeddings);
  const after = await countRows(db, spec.stackId);
  const readOnly = { before, after, identical: isIdentical(before, after) };
  if (pass.degradedReason !== null) {
    return {
      ...skippedMeasurement(spec, `ranking unavailable: ${pass.degradedReason}`, before),
      rankingCalls: pass.calls,
      readOnly,
    };
  }
  return {
    spec,
    skipped: false,
    skipReason: null,
    counts: before,
    rankingCalls: pass.calls,
    coverageComplete: pass.shortfallConcepts === 0,
    shortfallConcepts: pass.shortfallConcepts,
    readOnly,
    pairs: toRawPairs(topConceptsPerParagraph(pass.rankings, topK), spec, rows),
  };
}

/**
 * Whether two sets of row counts are the same, field by field.
 *
 * @param before - Counts taken before ranking.
 * @param after - Counts taken after it.
 * @returns True when nothing was written.
 */
function isIdentical(before: ReadOnlyCounts, after: ReadOnlyCounts): boolean {
  return (
    before.pages === after.pages &&
    before.pageEmbeddings === after.pageEmbeddings &&
    before.chunkEmbeddings === after.chunkEmbeddings
  );
}
