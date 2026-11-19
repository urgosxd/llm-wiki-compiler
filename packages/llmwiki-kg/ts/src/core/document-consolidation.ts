import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import type { DatabaseHandle } from "@repo/foundation";
import type { Database } from "../db.js";
import { bindCallerStack } from "./stack_resolver.js";
import { extractionModel } from "./llm/endpoints.js";
import type { ExtractedEntity, ExtractedRelationship } from "./extraction.js";
import type { OntologyClassification } from "./ontology.js";
import type { ClassificationState } from "../schema-open-classification.js";
import type { OntologyVerdict } from "../schema.js";

/**
 * @file packages/llmwiki-kg/ts/src/core/document-consolidation.ts
 * @description Document-extraction consolidation: the graph writes performed
 * after a document's chunks have been extracted.
 *
 * These two functions were lifted verbatim out of `routes/ingest.ts` so the
 * compiler's `kg` dimension can drive the same consolidation **in process**,
 * without going through the Express handler. Behaviour is unchanged: the SQL,
 * the confidence arithmetic, and the "written counts attempts" contract are
 * copied as-is, which is what keeps this a move rather than a rewrite.
 *
 * They stay in `core/` (not `routes/`) for the same reason the upstream
 * backfeed half of `consolidation.py` does: this is graph logic, not transport.
 */

type EntityLookupRow = {
  id: string;
  confidence: number;
  description: string | null;
};

/**
 * An extracted entity plus the metadata a CLASSIFYING caller supplies.
 *
 * Every field is optional, so a caller that does not classify (the compiler's
 * in-process path) keeps exactly the behaviour it had: no identity key means the
 * lookup stays the `lower(name)` match and the DB trigger derives the stored key,
 * and no classification state means the column stays NULL — which the migration
 * defines as "no decision was ever recorded", not as `pending`.
 *
 * `identityKey` is what makes two mentions ONE row (S28, S43): the caller resolves
 * identity first (T5) and this function honours it instead of re-deriving a name.
 *
 * The ontology class is optional here for the same reason as the rest: the routes that
 * never enforce a declaration keep the behaviour they had, and an absent class means the
 * row is accepted — which is the column's own default and the state every row written
 * before the class existed is in. A caller that DID enforce one always supplies it.
 */
export interface ConsolidationEntity
  extends ExtractedEntity,
    Partial<OntologyClassification> {
  /** The identity this mention resolved to; absent leaves the trigger to derive it. */
  readonly identityKey?: string;
  /** What the extractor proposed, kept beside the projection label. */
  readonly proposedType?: string;
  /** Operational classification state; absent when the caller never classifies. */
  readonly classificationState?: ClassificationState;
}

/**
 * An extracted relationship plus the metadata a classifying caller supplies.
 *
 * `predicate` is the verb the document used, written once and never rewritten, so
 * a relation nobody could map keeps its meaning instead of collapsing into a
 * generic one (S31). `identityKey` is what keeps two distinct free predicates
 * between the same endpoints apart (S33).
 *
 * The ontology class rides along exactly as it does on {@link ConsolidationEntity}:
 * absent means accepted, and a caller that enforced a declaration supplies the verdict
 * and the reason, so a rejected edge is a ROW rather than a count (S1).
 */
export interface ConsolidationRelationship
  extends ExtractedRelationship,
    Partial<OntologyClassification> {
  /** The original predicate; absent leaves the trigger to copy `type`. */
  readonly predicate?: string;
  /** The predicate-derived identity key; absent leaves the trigger to derive it. */
  readonly identityKey?: string;
  /** Operational classification state; absent when the caller never classifies. */
  readonly classificationState?: ClassificationState;
}

/** Confidence bump applied when a re-extraction corroborates an existing entity. */
const ENTITY_CONFIDENCE_BUMP = 0.05;

/** `source_kind` written for every document-derived row. */
const DOCUMENT_SOURCE_KIND = "document";

/** `pipeline` written for every document-derived row. */
const DOCUMENT_PIPELINE = "llamaindex-schema-extraction";

/**
 * The Stack's existing entity for this mention, by identity when one was resolved.
 *
 * Two lookup modes, chosen by the caller rather than by a heuristic:
 *
 * - with an `identityKey`, the row whose stored key is EQUAL is the identity, and
 *   a re-ingest of the same mention therefore updates that row instead of opening a
 *   sibling (S28, S43). A disambiguated key (`jordan#ctx:…`) can never match a bare
 *   one, which is how homonyms stay apart (S29).
 * - without one, the oracle's `lower(name)` match, unchanged, so a caller that does
 *   not resolve identities behaves exactly as before.
 */
async function findExistingEntity(
  tx: DatabaseHandle,
  stackId: string,
  entity: ConsolidationEntity,
): Promise<EntityLookupRow | undefined> {
  if (entity.identityKey !== undefined) {
    const byKey = await tx.execute<EntityLookupRow>(sql`
      select id, confidence, description
      from ontology_entities
      where stack_id = ${stackId} and identity_key = ${entity.identityKey}
    `);
    return byKey[0];
  }
  const rows = await tx.execute<EntityLookupRow>(sql`
    select id, confidence, description
    from ontology_entities
    where stack_id = ${stackId} and lower(name) = lower(${entity.name})
  `);
  return rows[0];
}

/**
 * Rewrites an existing entity's confidence, description, freshness — and, accepted-wins,
 * its ontology class.
 *
 * A NULL description is treated as empty and written back as `''`, and the
 * description is replaced only when strictly longer — both measured on the
 * oracle.
 *
 * ## The class moves in ONE direction, and only when a row was refused (S7)
 *
 * `unique_edge_per_stack`'s sibling for nodes is the name lookup above, so one mention and
 * another mention of the same name are ONE row: a refusal and an acceptance of it cannot
 * both persist, and a later re-ingest must not be able to flip a stored class either way.
 *
 * - **A stored rejection that is now admitted BECOMES accepted.** The admitted type
 *   replaces the refused one, and the reason and offending type are cleared WITH the
 *   verdict: an accepted row carrying an undeclared type, or a reason, is a row
 *   `ontology_rejection_reason_requires_rejected` refuses and a reader could not tell from
 *   a real admission. This is the half the previous behaviour was missing — the class was
 *   simply never rewritten, so a refusal outlived the refusal.
 * - **A stored acceptance is never downgraded.** The reverse direction is deliberately not
 *   performed: a mention at fault later does not retract what the ontology already
 *   vouched for, and `type` keeps the admitted label.
 *
 * Both class rules come from the STORED `ontology_verdict` and the incoming one, and all
 * three columns are derived from those same two values in the same statement, so the triple
 * they write can never disagree — the CHECK is not relied on to catch a half-update.
 */
async function updateEntity(
  tx: DatabaseHandle,
  entity: ConsolidationEntity,
  existing: EntityLookupRow,
): Promise<string> {
  const existingConfidence = Number(existing.confidence);
  const existingDescription = existing.description ?? "";
  const nextConfidence = Math.min(1.0, existingConfidence + ENTITY_CONFIDENCE_BUMP);
  // The docstring above promises "a NULL description is treated as empty", and the
  // EntityLookupRow side already guards with `?? ""`. The extracted side did not,
  // so a re-extraction whose model omitted a description crashed on
  // `null.length` — the very case the comment says is supported.
  const extractedDescription = entity.description ?? "";
  const nextDescription =
    extractedDescription !== "" && extractedDescription.length > existingDescription.length
      ? extractedDescription
      : existingDescription;
  // Absent means accepted: the column's own default, and the state every row written by a
  // caller that never enforced a declaration is in.
  const incomingVerdict = entity.ontologyVerdict ?? "accepted";
  // The row is admitted once EITHER side admits it. Never the other way round.
  const staysAdmitted = sql`(ontology_entities.ontology_verdict = 'accepted' or ${incomingVerdict} = 'accepted')`;

  await tx.execute(sql`
    update ontology_entities
    set confidence = ${nextConfidence},
        description = ${nextDescription},
        last_seen_at = now(),
        updated_at = now(),
        type = case
          when ontology_entities.ontology_verdict = 'rejected' and ${incomingVerdict} = 'accepted'
          then ${entity.type}
          else ontology_entities.type
        end,
        ontology_verdict = case
          when ${staysAdmitted} then 'accepted'
          else 'rejected'
        end,
        ontology_rejection_reason = case
          when ${staysAdmitted} then null
          else ontology_entities.ontology_rejection_reason
        end,
        ontology_offending_type = case
          when ${staysAdmitted} then null
          else ontology_entities.ontology_offending_type
        end
    where id = ${existing.id}
  `);
  return existing.id;
}

/**
 * Inserts a new entity, populating `extracted_by_model` with the model the
 * extraction actually asked for.
 *
 * The three identity/classification columns are bound as NULL when the caller
 * supplied nothing, which is not a placeholder: the landed triggers fill
 * `proposed_type` from `type` and `identity_key` from `lower(btrim(name))`, and
 * NULL `classification_state` means "no decision was recorded".
 *
 * The three ONTOLOGY columns are bound here and nowhere else, and never from a
 * default of their own: `ontology_verdict` is the class as the caller decided it,
 * `ontology_rejection_reason` is why, and `ontology_offending_type` is the type that was
 * refused. Binding the reason is what makes the verdict legible: a row marked
 * `rejected` with no reason is refused by `ontology_rejection_reason_requires_rejected`,
 * and a row marked `accepted` beside a reason is refused by the same CHECK.
 */
async function insertEntity(
  tx: DatabaseHandle,
  stackId: string,
  entity: ConsolidationEntity,
): Promise<string> {
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into ontology_entities (
      stack_id, name, type, description, confidence,
      extracted_by_model, source_kind, pipeline,
      identity_key, proposed_type, classification_state,
      ontology_verdict, ontology_rejection_reason, ontology_offending_type
    )
    values (
      ${stackId}, ${entity.name}, ${entity.type}, ${entity.description},
      ${entity.confidence}, ${extractionModel()},
      ${DOCUMENT_SOURCE_KIND}, ${DOCUMENT_PIPELINE},
      ${entity.identityKey ?? null}, ${entity.proposedType ?? null},
      ${entity.classificationState ?? null},
      ${entity.ontologyVerdict ?? "accepted"},
      ${entity.ontologyRejectionReason ?? null},
      ${entity.ontologyOffendingType ?? null}
    )
    returning id
  `);
  const created = onlyRow(inserted, "insert into ontology_entities");
  return created.id;
}

/**
 * Records that `documentId` contributed to `entityId`, reporting whether this is
 * a NEW contribution or a REPLAY of one already recorded.
 *
 * `on conflict (entity_id, document_id) do nothing` — a re-ingest does not
 * duplicate the contribution, which is why `entity_source_documents` keeps
 * exactly one row per entity/document pair.
 *
 * ## Why the return value exists
 *
 * `RETURNING` on a conflict-skipped insert yields ZERO rows, while a real insert
 * yields one (measured). That difference is the only available proof of whether
 * this document is new corroboration for the entity, and the caller needs it to
 * decide whether confidence may rise — see {@link consolidateEntityRows}.
 *
 * @returns `true` when a contribution row was actually inserted.
 */
async function recordContribution(
  tx: DatabaseHandle,
  entityId: string,
  documentId: string,
  stackId: string,
): Promise<boolean> {
  const inserted = await tx.execute<{ entity_id: string }>(sql`
    insert into entity_source_documents (entity_id, document_id, stack_id)
    values (${entityId}, ${documentId}, ${stackId})
    on conflict (entity_id, document_id) do nothing
    returning entity_id
  `);
  return inserted.length > 0;
}

/**
 * `consolidate_entities` — insert or update entities, return the name→id map.
 *
 * Reproduced from `app/core/consolidation.py`, including three details that are
 * observable in the database:
 *
 * 1. **Confidence arithmetic is a double, rounded by `real` on write.** Python
 *    computes `min(1.0, existing + 0.05)` in double precision and psycopg2 sends
 *    it as text; Postgres rounds to the nearest `real`. Reproducing the same
 *    double math keeps stored values identical — `0.7 + 0.05` becomes
 *    `0.75` here exactly as it does there.
 * 2. **A NULL description is rewritten as the empty string.** Python reads
 *    `existing_desc = row["description"] or ""` and writes that back, so an
 *    entity whose description was NULL ends up with `''` after a second ingest.
 *    Measured on the oracle.
 * 3. **The description is replaced only when strictly longer.** `if
 *    ent.description and len(ent.description) > len(existing_desc)`.
 *
 * `extracted_by_model` is populated with the model the extraction call asked for
 * — see {@link extractionModel}, which honours an injected chat backend — and is
 * **not** touched on update, matching the Python `update` statement.
 *
 * @returns lowercased entity name → entity id, consumed by
 *   {@link consolidateRelationshipRows}.
 */
export async function consolidateEntityRows(
  tx: DatabaseHandle,
  stackId: string,
  documentId: string,
  extracted: readonly ConsolidationEntity[],
): Promise<Map<string, string>> {
  // Bind the tenant before any write: every statement below is tenant-scoped, so under
  // RLS an unbound insert is refused. `stackId` is already this call's own filter.
  await bindCallerStack(tx, stackId, null);

  const nameToId = new Map<string, string>();

  for (const entity of extracted) {
    const existing = await findExistingEntity(tx, stackId, entity);
    const entityId =
      existing === undefined
        ? await insertEntity(tx, stackId, entity)
        : existing.id;

    nameToId.set(entity.name.toLowerCase(), entityId);

    // The contribution is recorded FIRST, because its result decides whether the
    // confidence may move. Counting a replay as corroboration is how a retried
    // outbox replay used to inflate an entity from 0.7 to 1.0 while nothing new
    // was learned: `confidence` must mean "how many documents agree", never
    // "how many times we tried".
    const isNewCorroboration = await recordContribution(tx, entityId, documentId, stackId);
    if (existing !== undefined && isNewCorroboration) {
      await updateEntity(tx, entity, existing);
    }
  }

  return nameToId;
}
/**
 * `consolidate_relationships` — upsert edges, report what they became.
 *
 * Returns the same {@link RelationshipWriteOutcome} its `…Detailed` sibling returns, because
 * the class a collision decided is only observable there: a caller that needs to say how
 * many rows are stored `rejected` cannot derive it from the input it passed in.
 *
 * Reproduced from `app/core/consolidation.py`. Three behaviours worth naming:
 *
 * - **Unresolvable endpoints are skipped, not invented.** `from_id` and `to_id`
 *   come only from the map built above, so an edge naming an entity the
 *   extractor never emitted is dropped silently. The Python comment says this
 *   is rare; it is also why `relationships_extracted` can exceed
 *   `relationships_written`.
 * - **The UPSERT takes `greatest()` of the confidences** and rewrites the
 *   description only when the incoming confidence is strictly higher. Because
 *   document extraction always emits 0.7, a re-ingest leaves an existing edge's
 *   description and confidence untouched and still counts as written.
 * - **`written` counts attempts, not changed rows.** An update of an unchanged
 *   edge counts exactly like a fresh insert. This is why the measured re-ingest
 *   shows `relationships_written: 1` while `relationships_in_stack` grows to 2:
 *   the write happened, and the row count grew because the *other* relationship
 *   from the second run was a new edge.
 */
export async function consolidateRelationshipRows(
  tx: DatabaseHandle,
  stackId: string,
  extracted: readonly ConsolidationRelationship[],
  nameToId: ReadonlyMap<string, string>,
): Promise<RelationshipWriteOutcome> {
  return consolidateRelationshipRowsDetailed(tx, stackId, extracted, nameToId);
}

/**
 * One assertion absorbed by another because both folded onto one stored edge.
 *
 * `unique_edge_per_stack` is `(stack_id, from_entity_id, to_entity_id, type)` and
 * `type` carries the LABEL the extraction folded (`deja sin efecto` and
 * `deja_sin_efecto` both become `DEJA_SIN_EFECTO`), while the identity key keeps the
 * original predicate (`core/classify/identity.ts`). Two spellings of one verb between
 * the same nodes therefore reach the database as one edge whose identity key differs
 * — and the upsert can only keep one of them.
 *
 * What survives and what is reported:
 *
 * - **The first predicate survives, never the last writer's.** The `do update` clause
 *   does not list `predicate`, and the migration declares it immutable, so the stored
 *   verb is the one the first document used. Silently replacing it would rewrite a
 *   source's wording with another source's.
 * - **The collision is reported.** The incoming assertion has no row of its own, so a
 *   caller that logs nothing is claiming a fact it does not hold, which is the
 *   silence S43 forbids.
 */
export interface RelationCollision {
  /** Folded subject name, as the extraction reported it. */
  readonly fromName: string;
  /** Folded object name. */
  readonly toName: string;
  /** The predicate of the assertion that was absorbed. */
  readonly predicate: string;
  /** The folded `type` label both assertions share. */
  readonly type: string;
  /** The original predicate of the row that survived. */
  readonly storedPredicate: string;
}

/** What one relationship pass wrote, and what it could not keep apart. */
export interface RelationshipWriteOutcome {
  /** How many upserts ran, attempts included, exactly as the oracle counts them. */
  readonly written: number;
  readonly collisions: readonly RelationCollision[];
  /**
   * How many DISTINCT relationship rows this pass left stored with class `rejected`.
   *
   * Read from the post-write row, not derived from the input: the upsert below returns
   * `ontology_verdict` with the row it just wrote, so this number is what Postgres stored
   * and cannot disagree with it. Deriving it from `extracted` would be wrong twice — a
   * duplicate identity collapses onto one row (`unique_edge_per_stack`), and a refusal
   * that collides with an acceptance writes the ACCEPTED row (S7) — and re-reading the
   * rows afterwards would answer a question about a different moment.
   *
   * It is a per-call count, so a re-ingest of an earlier chunk reports the refusals it
   * wrote again. That is deliberate: `written` counts attempts by the same rule.
   */
  readonly rejectedRows: number;
}

/**
 * The identity key the trigger would derive for an incoming relationship.
 *
 * Mirrors `kg_relationship_identity_key`: `lower(btrim(predicate))`, and `type` when
 * the caller supplied no predicate. Derived only to COMPARE against the stored key, so
 * a collision is detected here instead of being inferred afterwards from a count that
 * did not change.
 *
 * @param relationship - One extracted relationship, with its optional key.
 * @returns The key the row will carry.
 */
function incomingIdentityKey(relationship: ConsolidationRelationship): string {
  if (relationship.identityKey !== undefined) return relationship.identityKey;
  const predicate = (relationship.predicate ?? relationship.type).trim();
  return (predicate === "" ? relationship.type : predicate).toLowerCase();
}

/**
 * The stored row already occupying this edge's `(stack, from, to, type)` slot.
 *
 * @param tx - Transaction carrying the read.
 * @param edge - The endpoint ids and the folded label.
 * @returns The stored identity key and predicate, or `undefined` when the slot is free.
 */
async function existingEdge(
  tx: DatabaseHandle,
  stackId: string,
  edge: { readonly fromId: string; readonly toId: string; readonly type: string },
): Promise<{ identity_key: string; predicate: string | null } | undefined> {
  const rows = await tx.execute<{ identity_key: string; predicate: string | null }>(sql`
    select identity_key, predicate from ontology_relationships
    where stack_id = ${stackId}
      and from_entity_id = ${edge.fromId}
      and to_entity_id = ${edge.toId}
      and type = ${edge.type}
  `);
  return rows[0];
}

/**
 * The `do update set` fragment that makes an acceptance survive a collision.
 *
 * A fragment and not three cases inline, so the three columns stay visibly ONE decision:
 * they are all derived from the same two verdicts — the stored row's and `excluded`'s —
 * which is what stops the triple from disagreeing. `ontology_rejection_reason_requires_rejected`
 * refuses a rejected row with no reason and an accepted row with one, so three independent
 * cases that disagreed would turn a re-ingest into a failed transaction instead of a
 * merely wrong class.
 *
 * The rule, in one direction only: the row is accepted once EITHER side accepts it. A
 * stored acceptance is never downgraded to a refusal, and a stored refusal IS upgraded when
 * a later document is admitted — a refusal is not permanent. Two rejections on one identity
 * keep the STORED one, the first this Stack ever recorded, for the same reason the predicate
 * is kept: `do update` does not rewrite what the first writer established.
 */
const ACCEPTED_WINS_SET = sql`
  ontology_verdict = case
    when (ontology_relationships.ontology_verdict = 'accepted' or excluded.ontology_verdict = 'accepted')
    then 'accepted'
    else 'rejected'
  end,
  ontology_rejection_reason = case
    when (ontology_relationships.ontology_verdict = 'accepted' or excluded.ontology_verdict = 'accepted')
    then null
    else ontology_relationships.ontology_rejection_reason
  end,
  ontology_offending_type = case
    when (ontology_relationships.ontology_verdict = 'accepted' or excluded.ontology_verdict = 'accepted')
    then null
    else ontology_relationships.ontology_offending_type
  end
`;

/** The two column values the relationship upsert reports about the row it wrote. */
type StoredEdgeRow = { readonly id: string; readonly ontology_verdict: OntologyVerdict };

/**
 * The one row a statement that always produces exactly one row left behind.
 *
 * A `returning` clause on an insert-or-update yields a row on both paths, so an empty
 * result means the statement did not do what it says. Swallowing that into `undefined`
 * would turn a broken write into a missing count.
 *
 * @param rows - What the statement returned.
 * @param what - The statement, named for the error message.
 * @returns That row.
 * @throws {Error} When the statement returned nothing at all.
 */
function onlyRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`${what} returned no row`);
  return row;
}

/**
 * The relationship insert-or-update, with {@link ACCEPTED_WINS_SET} bound into it.
 *
 * A statement builder rather than an inline template so the class rule and the statement
 * it governs stay readable without pushing {@link upsertRelationshipRow} past the house
 * function-size limit.
 *
 * @param stackId - Stack the edge belongs to.
 * @param ids - The endpoint row ids the folded names resolved to.
 * @param relationship - The folded relationship, with the class its row must carry.
 * @returns The statement, already bound.
 */
function relationshipUpsertSql(
  stackId: string,
  ids: { readonly fromId: string; readonly toId: string },
  relationship: ConsolidationRelationship,
) {
  return sql`
    insert into ontology_relationships (
      stack_id, from_entity_id, to_entity_id, type,
      description, confidence, extracted_by_model, source_kind, pipeline,
      predicate, identity_key, classification_state,
      ontology_verdict, ontology_rejection_reason, ontology_offending_type
    )
    values (
      ${stackId}, ${ids.fromId}, ${ids.toId}, ${relationship.type},
      ${relationship.description}, ${relationship.confidence},
      ${extractionModel()}, ${DOCUMENT_SOURCE_KIND}, ${DOCUMENT_PIPELINE},
      ${relationship.predicate ?? null}, ${relationship.identityKey ?? null},
      ${relationship.classificationState ?? null},
      ${relationship.ontologyVerdict ?? "accepted"},
      ${relationship.ontologyRejectionReason ?? null},
      ${relationship.ontologyOffendingType ?? null}
    )
    on conflict (stack_id, from_entity_id, to_entity_id, type)
    do update set
      confidence = greatest(
        ontology_relationships.confidence,
        excluded.confidence
      ),
      description = case
        when excluded.confidence > ontology_relationships.confidence
        then excluded.description
        else ontology_relationships.description
      end,
      ${ACCEPTED_WINS_SET}
    returning id, ontology_verdict
  `;
}

/**
 * Writes one relationship row, through the collision clause that decides its class.
 *
 * Extracted from the loop below so the statement and the rule that governs a collision
 * read as one unit rather than two halves of a long function.
 *
 * `type` keeps its projection meaning and is NOT rewritten by a classification, so no
 * later update can collide with `unique_edge_per_stack`. The original verb travels in
 * `predicate`, which the trigger copies from `type` when the caller supplied none, and
 * `identity_key` is what keeps two distinct free predicates between the same endpoints
 * apart (S33).
 *
 * The three ontology columns are bound exactly as the entity insert binds them, so an edge
 * the ontology refused is a ROW with its reason instead of a counter that describes nothing.
 *
 * ## The class is enforced HERE as well as in memory, because accepted must win
 *
 * `unique_edge_per_stack (stack_id, from_entity_id, to_entity_id, type)` is the very
 * identity this clause collides on, and it admits one row per identity — so a refusal and
 * an acceptance of the same edge cannot both persist, and "both were written" is not an
 * available answer. Enforcing this only in `mergeRelationships` would leave the invariant
 * unprotected against every OTHER writer: that merge sees one extraction, while this
 * statement sees every ingest, so a re-ingest of an earlier chunk would be free to flip the
 * class. {@link ACCEPTED_WINS_SET} is the rule; this statement is where it is applied.
 *
 * ## Why the write reports the row back
 *
 * The `returning` clause is what makes the stored class OBSERVABLE to the caller: a
 * collision decides the class in SQL, so the caller cannot compute it from its own input,
 * and a follow-up `select` would answer about a different moment. The row this statement
 * returns is the row the graph now holds.
 *
 * @param tx - Transaction carrying the write.
 * @param stackId - Stack the edge belongs to.
 * @param ids - The endpoint row ids the folded names resolved to.
 * @param relationship - The folded relationship, with the class its row must carry.
 * @returns The row's id and the class Postgres stored for it.
 */
async function upsertRelationshipRow(
  tx: DatabaseHandle,
  stackId: string,
  ids: { readonly fromId: string; readonly toId: string },
  relationship: ConsolidationRelationship,
): Promise<{ readonly id: string; readonly verdict: OntologyVerdict }> {
  const rows = await tx.execute<StoredEdgeRow>(relationshipUpsertSql(stackId, ids, relationship));
  const { id, ontology_verdict: verdict } = onlyRow(rows, "upsert into ontology_relationships");
  return { id, verdict };
}

/**
 * `consolidate_relationships` with the collisions it caused, for a caller that must
 * record them.
 *
 * @param tx - Transaction carrying the writes.
 * @param stackId - Stack the edges belong to.
 * @param extracted - The folded relationships, in extraction order.
 * @param nameToId - Folded entity name → entity row id.
 * @returns The attempt count, one record per absorbed assertion, and the rejected-row count.
 */
export async function consolidateRelationshipRowsDetailed(
  tx: DatabaseHandle,
  stackId: string,
  extracted: readonly ConsolidationRelationship[],
  nameToId: ReadonlyMap<string, string>,
): Promise<RelationshipWriteOutcome> {
  await bindCallerStack(tx, stackId, null);
  let written = 0;
  const collisions: RelationCollision[] = [];
  // Keyed by ROW id, so two assertions that fold onto one row are counted once, and the
  // LAST returned class wins: that is the class the row ended the pass with.
  const verdictByRow = new Map<string, OntologyVerdict>();

  for (const relationship of extracted) {
    const fromId = nameToId.get(relationship.fromEntityName.toLowerCase());
    const toId = nameToId.get(relationship.toEntityName.toLowerCase());
    if (fromId === undefined || toId === undefined) {
      continue;
    }

    const stored = await existingEdge(tx, stackId, { fromId, toId, type: relationship.type });
    if (stored !== undefined && stored.identity_key !== incomingIdentityKey(relationship)) {
      collisions.push({
        fromName: relationship.fromEntityName,
        toName: relationship.toEntityName,
        predicate: relationship.predicate ?? relationship.type,
        type: relationship.type,
        storedPredicate: stored.predicate ?? relationship.type,
      });
    }

    const row = await upsertRelationshipRow(tx, stackId, { fromId, toId }, relationship);
    verdictByRow.set(row.id, row.verdict);
    written += 1;
  }

  let rejectedRows = 0;
  for (const verdict of verdictByRow.values()) {
    if (verdict === "rejected") rejectedRows += 1;
  }
  return { written, collisions, rejectedRows };
}

/** What the compiler knows about a source it wants to register as a document. */
export interface DocumentRegistration {
  /** Stack the document belongs to. */
  readonly stackId: string;
  /** Identity of the source, e.g. its URL or file path. */
  readonly source: string;
  /** Full text that was extracted. */
  readonly body: string;
  /** Human-facing title, used as the stored filename. */
  readonly title: string;
}

/**
 * Register a source as a document row and return its id.
 *
 * WHY THIS EXISTS. `consolidate_entities` writes `entity_source_documents`, whose
 * `document_id` is a FOREIGN KEY onto `stack_documents`. The upstream server only
 * ever inserted that parent row from its HTTP upload handler
 * (`routes/documents/upload.ts`), so the in-process path had no way to satisfy the
 * constraint: every consolidation failed with a foreign-key violation and the
 * graph dimension could never write anything. This closes that gap with the same
 * SQL shape the upload handler uses.
 *
 * IDEMPOTENT ON CONTENT, BY CONSTRUCTION. `stack_documents` carries
 * `unique_hash_per_stack` on `(stack_id, source_hash)`, so re-registering identical
 * content resolves to the SAME row via `on conflict ... do update` and `returning`.
 * The caller therefore never invents an id — Postgres owns it — and a re-ingest
 * cannot fork a second document for unchanged bytes.
 *
 * `source_hash` covers the source identity AND the body: a source whose content
 * changed is a different document, which is what lets the graph hold the current
 * text rather than accumulating stale chunks under one id. A soft delete keys off
 * `source` instead, so `forget` can find every generation of a removed source.
 *
 * ## Why this binds the tenant like its two siblings
 *
 * Every statement here is tenant-scoped, and `stack_documents` carries a
 * `tenant_isolation` policy with a `WITH CHECK`, so an insert whose bound tenant
 * does not match `stack_id` is REFUSED. Measured under the application role:
 * SQLSTATE 42501, `new row violates row-level security policy for table
 * "stack_documents"`, which failed the whole graph write.
 *
 * `consolidateEntityRows` and `consolidateRelationshipRows` already bound before
 * their writes; this function did not, and the asymmetry was invisible because
 * every suite connects as `aks` -- a SUPERUSER with `BYPASSRLS`, where no policy
 * runs at all. Binding here is what makes the three writes consistent and the
 * dimension work under the role production is meant to use.
 *
 * @param tx - Transaction that will also carry the consolidation writes.
 * @param registration - Source identity, body, and title.
 * @returns The document row's id.
 */
export async function registerDocumentRow(
  tx: DatabaseHandle,
  registration: DocumentRegistration,
): Promise<string> {
  // Before the insert, for the same reason the consolidation functions do it:
  // the policy validates what is written against the bound tenant.
  await bindCallerStack(tx, registration.stackId, null);

  const sourceHash = createHash("sha256")
    .update(registration.source)
    .update("\u0000")
    .update(registration.body)
    .digest("hex");
  const rows = await tx.execute<{ id: string }>(sql`
    insert into stack_documents (
      stack_id, filename, storage_path, size_bytes, content_type, source_hash
    )
    values (
      ${registration.stackId}, ${registration.title}, ${registration.source},
      ${Buffer.byteLength(registration.body, "utf8")}, 'text/markdown', ${sourceHash}
    )
    on conflict on constraint unique_hash_per_stack
    do update set filename = excluded.filename
    returning id
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("insert into stack_documents returned no row");
  }
  return row.id;
}

/**
 * Delete every document row a source owns, letting the foreign keys cascade.
 *
 * WHY `storage_path` IS THE MATCH COLUMN. The compiler has no filename to give the
 * graph, so it registers a document with the SOURCE IDENTITY (a URL or path) in
 * `storage_path`. That column is therefore the only link between a source string
 * and its rows.
 *
 * DELETES ALL GENERATIONS, BY DESIGN. A source whose content changed produces a
 * different `source_hash` and therefore a different row. Forgetting the source
 * must retire every one of them, not only the newest, or the graph keeps serving
 * text the source no longer has.
 *
 * Chunk and `entity_source_documents` rows cascade from `stack_documents`, so this
 * single delete retires the whole trace. Deleting nothing is not an error: the
 * desired end state for an unknown or already-forgotten source already holds.
 *
 * @param tx - Transaction carrying the deletion.
 * @param stackId - Stack the source belongs to; scoping prevents a cross-stack delete.
 * @param source - Source identity recorded at ingest time.
 */
export async function forgetDocumentRows(
  tx: Database,
  stackId: string,
  source: string,
): Promise<void> {
  await tx.execute(sql`
    delete from stack_documents
    where stack_id = ${stackId} and storage_path = ${source}
  `);
}
