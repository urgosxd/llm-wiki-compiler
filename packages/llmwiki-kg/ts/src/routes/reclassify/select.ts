/**
 * @file packages/llmwiki-kg/ts/src/routes/reclassify/select.ts
 * @description Stage 1 of a reclassification run: which rows are decided again, and
 * what each of them will be judged against.
 *
 * ## The selection rule is version skew, plus whatever never got an answer
 *
 * A row is selected when it is operational (`pending` / `failed`) or when the catalog
 * version or the classifier version it was decided under differs from the current
 * ones. That is the whole rule, and it is what makes a sweep CONVERGE: after a run
 * every selected row carries the current versions, so an unchanged rerun selects
 * nothing and calls nobody.
 *
 * `is distinct from` rather than `<>` on purpose: a row that never stored a version —
 * pre-classification rows, rows the compiler path wrote — has `catalog_version IS
 * NULL`, and `NULL <> '1.0.0'` is `NULL`, i.e. not selected. The version-less row is
 * exactly the one a version sweep must pick up.
 *
 * ## Evidence is read, never re-derived
 *
 * A re-decision is only allowed where the row already has a LOCATED quote: the newest
 * textual `kg_evidence` row with character offsets into a stored chunk. A row whose
 * quote was never located has no context to classify against, and inventing one would
 * be classifying a fact nobody can verify (S19). Such a row is counted as
 * `skipped_no_evidence` and left exactly as it was.
 *
 * The quote supplies the candidate ref too, so a reclassification log entry lands on
 * the same key the ingest wrote, and a reader can read the whole history of one
 * candidate in order.
 *
 * ## Two things this stage refuses to guess
 *
 * A human-verified row is separated out before anything is asked about it: `verified`
 * means a person reviewed the fact (S39), and re-deciding it automatically would
 * overwrite a human decision with a machine's. And nothing here writes: the caller
 * runs this inside its own short transaction, which commits before the first provider
 * call (S44).
 */

import { sql } from "drizzle-orm";

import { normalizeCatalogName } from "../../core/catalog/names.js";
import { loadStackCatalog } from "../../core/catalog/stack-catalog.js";
import type { KnowledgeCandidate, RelationCandidate } from "../../core/candidates/types.js";
import type { CandidateEvidence } from "../../core/classify/types.js";
import { bindCallerStack } from "../../core/stack_resolver.js";
import type { TypeCatalog } from "../../core/catalog/types.js";
import type { Database } from "../../db.js";
import type {
  ClassificationState,
  CompatibilityState,
  SupportState,
} from "../../schema-open-classification.js";
import type { ReclassifyRow, ReclassifySelection } from "./types.js";

/** How one run is bounded and which classifier version it is running as. */
export interface SelectOptions {
  readonly classifierVersion: string;
  /** Rows per kind one run may take, so a sweep is bounded and says when it is. */
  readonly limit: number;
}

/** The located quote of one candidate: what the classifier reads and where it came from. */
interface LocatedQuote {
  readonly ref: string;
  readonly quote: string;
  readonly documentId: string;
  readonly chunkIndex: number;
  readonly context: string;
}

/** One entity row, with the columns a re-decision reads. */
type EntityRow = {
  id: string;
  name: string;
  identity_key: string;
  proposed_type: string | null;
  type: string;
  description: string | null;
  classification_state: ClassificationState | null;
  canonical_type: string | null;
  support_state: SupportState | null;
  catalog_version: string | null;
  classifier_version: string | null;
  verified: boolean;
}

/** One relationship row with both endpoints resolved. */
type RelationRow = {
  id: string;
  predicate: string | null;
  type: string;
  identity_key: string;
  description: string | null;
  classification_state: ClassificationState | null;
  canonical_type: string | null;
  support_state: SupportState | null;
  compatibility: CompatibilityState | null;
  catalog_version: string | null;
  classifier_version: string | null;
  verified: boolean;
  from_id: string;
  from_name: string;
  from_canonical_type: string | null;
  from_classification_state: ClassificationState | null;
  to_id: string;
  to_name: string;
  to_canonical_type: string | null;
  to_classification_state: ClassificationState | null;
};

/** Everything a run needs, split into what it may touch and what it must leave alone. */
export interface ReclassificationRead extends ReclassifySelection {
  /** The catalog the decisions are made against. */
  readonly catalog: TypeCatalog;
  /** Canonical types of already-known endpoints, so a relation is not re-judged blind. */
  readonly endpointTypes: ReadonlyMap<string, string>;
}

/**
 * The skew predicate both table queries share.
 *
 * Written once so a change to the rule cannot select entities by one condition and
 * relations by another.
 *
 * @param alias - Table alias the columns belong to.
 * @param options - The versions this run is comparing against.
 * @returns The SQL condition, already parameterized.
 */
function skewCondition(alias: string, options: SkewOptions) {
  return sql`(
    ${sql.raw(`${alias}.classification_state`)} in ('pending', 'failed')
    or ${sql.raw(`${alias}.catalog_version`)} is distinct from ${options.catalogVersion}::text
    or ${sql.raw(`${alias}.classifier_version`)} is distinct from ${options.classifierVersion}::text
  )`;
}

/**
 * Reads the newest LOCATED textual evidence of the given candidate keys.
 *
 * `right(candidate_ref, char_length(key) + 1) = ':' || key` matches the ref's own key
 * segment exactly, with no LIKE metacharacter in the pattern — a name may contain `%`
 * or `_`, and a wildcard match here would attribute one candidate's quote to another.
 *
 * @param tx - Transaction carrying the read.
 * @param stackId - Stack the candidates belong to.
 * @param kind - Which kind of candidate the keys describe.
 * @param keys - The candidate keys, as the ingest wrote them into the ref.
 * @returns Key to located quote, newest evidence per candidate.
 */
async function newestEvidence(
  tx: Database,
  stackId: string,
  kind: "entity" | "relationship",
  keys: readonly string[],
): Promise<Map<string, LocatedQuote>> {
  const found = new Map<string, LocatedQuote>();
  if (keys.length === 0) return found;
  const matches = sql.join(
    keys.map((key) => sql`right(e.candidate_ref, char_length(${key}) + 1) = ${`:${key}`}`),
    sql` or `,
  );
  const rows = await tx.execute<{
    candidate_ref: string;
    evidence_text: string;
    document_id: string;
    chunk_index: number | null;
    content: string;
  }>(sql`
    select distinct on (e.candidate_ref)
      e.candidate_ref, e.evidence_text, e.document_id, e.chunk_index, dc.content
    from kg_evidence e
    join document_chunks dc
      on dc.document_id = e.document_id and dc.chunk_index = e.chunk_index
    where e.stack_id = ${stackId}
      and e.candidate_kind = ${kind}
      and e.evidence_kind = 'textual'
      and e.char_start is not null
      and (${matches})
    order by e.candidate_ref, e.created_at desc, e.id desc
  `);
  for (const row of rows) {
    const key = keys.find((candidate) => row.candidate_ref.endsWith(`:${candidate}`));
    if (key === undefined || row.chunk_index === null) continue;
    found.set(key, {
      ref: row.candidate_ref,
      quote: row.evidence_text,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      context: row.content,
    });
  }
  return found;
}

/**
 * The candidate the classification stage sees for a stored entity row.
 *
 * `proposedType` is the extractor's proposal as it was stored, and `properties` is
 * empty: the projection's `properties` column belongs to the read path, and passing it
 * as extractor properties would attribute a later enrichment to the extractor.
 *
 * @param row - The stored entity row.
 * @param quote - The evidence the candidate is judged against.
 * @returns The candidate.
 */
function entityCandidate(row: EntityRow, quote: LocatedQuote): KnowledgeCandidate {
  return {
    kind: "entity",
    ref: quote.ref,
    source: { documentId: quote.documentId, chunkId: null, chunkIndex: quote.chunkIndex },
    name: row.name,
    proposedType: row.proposed_type ?? row.type,
    description: row.description,
    properties: [],
  };
}

/**
 * The candidate the classification stage sees for a stored relationship row.
 *
 * The original predicate is required, so it falls back to the folded `type` only when
 * the row predates the predicate column — never to a generic verb (S31).
 *
 * @param row - The stored relationship row.
 * @param quote - The evidence the candidate is judged against.
 * @returns The candidate.
 */
function relationCandidate(row: RelationRow, quote: LocatedQuote): RelationCandidate {
  return {
    kind: "relationship",
    ref: quote.ref,
    source: { documentId: quote.documentId, chunkId: null, chunkIndex: quote.chunkIndex },
    fromName: row.from_name,
    toName: row.to_name,
    predicate: row.predicate ?? row.type,
    description: row.description,
  };
}

/** The evidence record the classification stage takes. */
function evidenceOf(quote: LocatedQuote): CandidateEvidence {
  return { quote: quote.quote, context: quote.context };
}

/** The stored decision of one entity row. */
function entityStored(row: EntityRow) {
  return {
    classificationState: row.classification_state,
    canonicalType: row.canonical_type,
    supportState: row.support_state,
    catalogVersion: row.catalog_version,
    classifierVersion: row.classifier_version,
    verified: row.verified,
  };
}

/** The stored decision of one relationship row. */
function relationStored(row: RelationRow) {
  return {
    classificationState: row.classification_state,
    canonicalType: row.canonical_type,
    supportState: row.support_state,
    catalogVersion: row.catalog_version,
    classifierVersion: row.classifier_version,
    verified: row.verified,
  };
}

/**
 * The key the ingest wrote into an entity's candidate ref: the stored identity key.
 *
 * @param row - The stored entity row.
 * @returns The key segment of its evidence refs.
 */
function entityKey(row: EntityRow): string {
  return row.identity_key;
}

/**
 * The key the ingest wrote into a relation's candidate ref: the folded triple.
 *
 * Rebuilt with the same fold `candidates.ts` used, so the stored evidence can be found
 * without parsing a ref whose middle segment is a UUID and whose last segment is the
 * predicate — which may itself contain the separator.
 *
 * @param row - The stored relationship row.
 * @returns The key segment of its evidence refs.
 */
function relationKey(row: RelationRow): string {
  return [
    normalizeCatalogName(row.from_name),
    normalizeCatalogName(row.predicate ?? row.type),
    normalizeCatalogName(row.to_name),
  ].join("|");
}

/** Every entity the relations of this run point at, as a folded-name seed. */
function endpointSeed(rows: readonly RelationRow[]): ReadonlyMap<string, string> {
  const seed = new Map<string, string>();
  const seen = new Set<string>();
  for (const row of rows) {
    for (const endpoint of [
      { name: row.from_name, type: row.from_canonical_type, state: row.from_classification_state },
      { name: row.to_name, type: row.to_canonical_type, state: row.to_classification_state },
    ]) {
      const key = normalizeCatalogName(endpoint.name);
      if (endpoint.type === null || endpoint.state !== "classified" || seen.has(`${key}:${endpoint.type}`)) {
        continue;
      }
      seen.add(`${key}:${endpoint.type}`);
      seed.set(key, endpoint.type);
    }
  }
  return seed;
}

/**
 * Builds the classifiable rows of one kind, splitting out what must not be touched.
 *
 * Three outcomes per selected row: classifiable, refused because a human verified it,
 * or skipped because no located quote exists. The skip happens before the verified
 * check on purpose — a row with no evidence has nothing to judge either way, and
 * reporting it as "refused" would suggest a decision was made about it.
 *
 * @param rows - The selected storage rows, in order.
 * @param quoteOf - The located quote of one row, or `undefined` when it has none.
 * @param toRow - How to turn one row and its quote into a reclassification row.
 * @returns The classifiable rows, the verified ones, and how many were skipped.
 */
function partition<T extends { readonly verified: boolean }>(
  rows: readonly T[],
  quoteOf: (row: T) => LocatedQuote | undefined,
  toRow: (row: T, quote: LocatedQuote) => ReclassifyRow,
): { readonly classifiable: ReclassifyRow[]; readonly refused: ReclassifyRow[]; readonly missing: number } {
  const classifiable: ReclassifyRow[] = [];
  const refused: ReclassifyRow[] = [];
  let missing = 0;
  for (const row of rows) {
    const quote = quoteOf(row);
    if (quote === undefined) {
      missing += 1;
      continue;
    }
    const built = toRow(row, quote);
    if (row.verified) refused.push(built);
    else classifiable.push(built);
  }
  return { classifiable, refused, missing };
}

/** The skew predicate's options: the run's own plus the version it compares against. */
type SkewOptions = SelectOptions & { readonly catalogVersion: string };

/**
 * The rows of `ontology_entities` whose decision is stale, bounded and ordered.
 *
 * @param tx - Transaction carrying the read.
 * @param stackId - Stack to read.
 * @param options - Versions to compare against and the per-run bound.
 * @returns At most `limit + 1` rows, so the caller can tell there was more.
 */
async function selectEntities(
  tx: Database,
  stackId: string,
  options: SkewOptions,
): Promise<readonly EntityRow[]> {
  return tx.execute<EntityRow>(sql`
    select e.id, e.name, e.identity_key, e.proposed_type, e.type, e.description,
           e.classification_state, e.canonical_type, e.support_state,
           e.catalog_version, e.classifier_version, e.verified
    from ontology_entities e
    where e.stack_id = ${stackId} and ${skewCondition("e", options)}
    order by e.name, e.id
    limit ${options.limit + 1}
  `);
}

/**
 * The rows of `ontology_relationships` whose decision is stale, with both endpoints.
 *
 * The endpoint columns come along so the compatibility check can be given the types
 * storage already established instead of re-deriving them from a batch that does not
 * contain those entities (see `ClassifyCandidatesInput.endpointTypes`).
 *
 * @param tx - Transaction carrying the read.
 * @param stackId - Stack to read.
 * @param options - Versions to compare against and the per-run bound.
 * @returns At most `limit + 1` rows, endpoint columns included.
 */
async function selectRelations(
  tx: Database,
  stackId: string,
  options: SkewOptions,
): Promise<readonly RelationRow[]> {
  return tx.execute<RelationRow>(sql`
    select r.id, r.predicate, r.type, r.identity_key, r.description, r.classification_state,
           r.canonical_type, r.support_state, r.compatibility,
           r.catalog_version, r.classifier_version, r.verified,
           ef.id as from_id, ef.name as from_name,
           ef.canonical_type as from_canonical_type,
           ef.classification_state as from_classification_state,
           et.id as to_id, et.name as to_name,
           et.canonical_type as to_canonical_type,
           et.classification_state as to_classification_state
    from ontology_relationships r
    join ontology_entities ef on ef.id = r.from_entity_id
    join ontology_entities et on et.id = r.to_entity_id
    where r.stack_id = ${stackId} and ${skewCondition("r", options)}
    order by r.predicate, r.id
    limit ${options.limit + 1}
  `);
}

/**
 * Turns the two row sets plus their evidence into the run's selection.
 *
 * @param tx - Transaction carrying the evidence read.
 * @param stackId - Stack being swept.
 * @param resolution - The Stack's resolved catalog and its version.
 * @param entities - Entity rows, at most `limit + 1`.
 * @param relations - Relationship rows, at most `limit + 1`.
 * @param limit - How many rows per kind one run may take.
 * @returns The selection, with everything the caller has to report.
 */
async function assemble(
  tx: Database,
  stackId: string,
  resolution: { readonly catalog: TypeCatalog; readonly version: string },
  entities: readonly EntityRow[],
  relations: readonly RelationRow[],
  limit: number,
): Promise<ReclassificationRead> {
  const truncated = entities.length > limit || relations.length > limit;
  const boundedEntities = entities.slice(0, limit);
  const boundedRelations = relations.slice(0, limit);
  const entityQuotes = await newestEvidence(tx, stackId, "entity", boundedEntities.map(entityKey));
  const relationQuotes = await newestEvidence(
    tx,
    stackId,
    "relationship",
    boundedRelations.map(relationKey),
  );
  const entityRows = partition(
    boundedEntities,
    (row) => entityQuotes.get(entityKey(row)),
    (row, quote) => ({
      id: row.id,
      kind: "entity",
      ref: quote.ref,
      stored: entityStored(row),
      compatibility: null,
      candidate: entityCandidate(row, quote),
      evidence: evidenceOf(quote),
    }),
  );
  const relationRows = partition(
    boundedRelations,
    (row) => relationQuotes.get(relationKey(row)),
    (row, quote) => ({
      id: row.id,
      kind: "relationship",
      ref: quote.ref,
      stored: relationStored(row),
      compatibility: row.compatibility,
      edge: { fromId: row.from_id, toId: row.to_id, identityKey: row.identity_key },
      candidate: relationCandidate(row, quote),
      evidence: evidenceOf(quote),
    }),
  );
  return {
    catalog: resolution.catalog,
    catalogVersion: resolution.version,
    classifiable: [...entityRows.classifiable, ...relationRows.classifiable],
    refusedVerified: [...entityRows.refused, ...relationRows.refused],
    skippedNoEvidence: entityRows.missing + relationRows.missing,
    selected: { entities: boundedEntities.length, relationships: boundedRelations.length },
    endpointTypes: endpointSeed(boundedRelations),
    truncated,
  };
}

/**
 * Stage 1 of a reclassification run: the reads, with no provider call and no writes.
 *
 * @param tx - A short read transaction, committed before any classifier call (S44).
 * @param stackId - Stack to sweep.
 * @param options - Bounded size and the classifier version to compare against.
 * @returns The selection, or `undefined` when the Stack does not exist.
 */
export async function selectForReclassification(
  tx: Database,
  stackId: string,
  options: SelectOptions,
): Promise<ReclassificationRead | undefined> {
  await bindCallerStack(tx, stackId, null);
  const stack = await tx.execute<{ id: string }>(sql`select id from stacks where id = ${stackId}`);
  if (stack[0] === undefined) return undefined;
  const resolution = await loadStackCatalog(tx, stackId);
  const skew = { ...options, catalogVersion: resolution.version };
  const entities = await selectEntities(tx, stackId, skew);
  const relations = await selectRelations(tx, stackId, skew);
  return assemble(tx, stackId, resolution, entities, relations, options.limit);
}
