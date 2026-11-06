/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/classification-log.ts
 * @description The append-only history of classification decisions, and the one
 * writer both the ingest pipeline and a reclassification run use.
 *
 * ## Why this lives apart from the persistence stage
 *
 * Two operations append to `kg_classification_log`: an ingest, which classifies a
 * candidate for the first time, and a reclassification pass, which decides again
 * about a row that already has an answer. They differ in exactly one respect — what
 * the PREVIOUS value is — and that difference is the whole point of the table: a
 * stored decision that changes with no trace is indistinguishable from corruption
 * (S43).
 *
 * So the entry carries its own previous state instead of the writer assuming one.
 * The ingest path passes the `pending` state stage 1 wrote; a reclassification run
 * passes the state and canonical type it actually found, and the resulting row can
 * then be read as a real transition.
 *
 * ## A collision is an entry too
 *
 * `unique_edge_per_stack` is `(stack_id, from_entity_id, to_entity_id, type)` and
 * `type` carries the FOLDED label, so two spellings of one verb between the same
 * endpoints cannot both become rows. The first predicate survives (the upsert never
 * touches `predicate`) and the second assertion is absorbed — a real decision about
 * which fact the graph keeps, recorded here with `relation_collision:<survivor>`
 * rather than dropped in silence (S43).
 *
 * ## A refusal is not an event that happened again
 *
 * Most entries describe something that happened once: a row moved from one answer to
 * another. A refusal describes something that did NOT happen — a human-verified row was
 * left alone — and it happens identically on every sweep, because that row keeps the
 * versions it was verified under and therefore stays selected forever. Appending it
 * once per sweep grows an append-only table by (verified rows x sweeps) on a scheduled
 * operation, which is unbounded growth for no information.
 *
 * An entry marked `idempotent` is therefore appended only while no row already records
 * the same decision: same candidate, same reason, same catalog version, same classifier
 * version. `not exists` rather than a unique index because the dedupe key is a property
 * of this writer, not of the table, and because the suppression must be VERSION-SCOPED:
 * a sweep under a new catalog or a new classifier is a new refusal and must be recorded
 * as one. Everything that is not marked idempotent is written exactly as before, so a
 * real classification change still appends a history row every single time.
 *
 * ## Nothing here invents a state
 *
 * `new_state` is written exactly as the decision reported it, and every entry names
 * the catalog version, the classifier version and the vendor readout that produced
 * it. The table's CHECK constraints accept only the five states, so a typo surfaces
 * as a refused write rather than as a sixth meaning nobody defined.
 */

import { sql } from "drizzle-orm";

import type { CandidateDecision } from "../../core/classify/types.js";
import type { JevChoiceReadout } from "../../core/jev/types.js";
import type {
  CandidateKind,
  ClassificationState,
} from "../../schema-open-classification.js";
import type { Database } from "../../db.js";

/** What every write of one run shares. */
export interface ClassificationWriteContext {
  readonly stackId: string;
  /** The catalog version the decisions were made under. */
  readonly catalogVersion: string;
  /** Our label for the stage that produced them. */
  readonly classifierVersion: string;
  /** The vendor model id the requests asked for. */
  readonly jevModel: string;
}

/** One appended history row. */
export interface ClassificationLogEntry {
  readonly candidateKind: CandidateKind;
  readonly candidateRef: string;
  /** The state found before this run; `null` when the row never had a decision. */
  readonly previousState: ClassificationState | null;
  /** The state the row holds after this run. */
  readonly newState: ClassificationState;
  readonly previousCanonicalType: string | null;
  readonly newCanonicalType: string | null;
  /** The vendor's raw answer, absent when nobody answered. */
  readonly readout: JevChoiceReadout | null;
  readonly catalogVersion: string | null;
  readonly classifierVersion: string | null;
  /** Why the decision is what it is; `null` for a positive classification. */
  readonly reason: string | null;
  /**
   * True when an existing row recording the same decision silences this one.
   *
   * For a refusal: the same candidate under the same reason and the same two versions
   * is the same refusal, and a sweep that refuses it again adds no information. A
   * different catalog or classifier version is a different refusal and is written.
   */
  readonly idempotent?: boolean;
}

/** What one append call did with the entries it was given. */
export interface ClassificationLogWrite {
  /** How many rows were inserted. */
  readonly appended: number;
  /** How many entries an already-recorded decision silenced. */
  readonly deduplicated: number;
}

/** The previous value of one row, as a writer observed it. */
export interface PreviousDecision {
  readonly state: ClassificationState | null;
  readonly canonicalType: string | null;
}

/** What stage 1 wrote before any classifier was asked: the ingest's previous value. */
export const PENDING_PREVIOUS: PreviousDecision = Object.freeze({
  state: "pending" as ClassificationState,
  canonicalType: null,
});

/**
 * Builds the history entry for one decision.
 *
 * @param decision - The validated decision.
 * @param previous - What the row held before this run.
 * @returns The entry to append.
 */
export function decisionLogEntry(
  decision: CandidateDecision,
  previous: PreviousDecision,
): ClassificationLogEntry {
  return {
    candidateKind: decision.kind,
    candidateRef: decision.ref,
    previousState: previous.state,
    newState: decision.classificationState,
    previousCanonicalType: previous.canonicalType,
    newCanonicalType: decision.canonicalType,
    readout: decision.readout,
    catalogVersion: decision.catalogVersion,
    classifierVersion: null,
    reason: decision.reason,
  };
}

/** The columns every insert of this writer fills, in one place. */
const LOG_COLUMNS = sql`
  stack_id, candidate_kind, candidate_ref, previous_state, new_state,
  previous_canonical_type, new_canonical_type,
  jev_choice, jev_confidence, jev_top_probability, jev_model,
  catalog_version, classifier_version, reason`;

/**
 * The values one entry contributes, in the order of {@link LOG_COLUMNS}.
 *
 * Written once so a plain append and a guarded append cannot disagree about which
 * column holds what.
 *
 * @param context - Stack, versions and model this run shares.
 * @param entry - The entry being written.
 * @returns The value row, already parameterized.
 */
function entryValues(context: ClassificationWriteContext, entry: ClassificationLogEntry) {
  const readout = entry.readout;
  return sql`
    ${context.stackId}, ${entry.candidateKind}, ${entry.candidateRef},
    ${entry.previousState}, ${entry.newState},
    ${entry.previousCanonicalType}, ${entry.newCanonicalType},
    ${readout?.choice ?? null}, ${readout?.confidence ?? null},
    ${readout?.topProbability ?? null}, ${readout?.model ?? context.jevModel},
    ${entry.catalogVersion ?? context.catalogVersion},
    ${entry.classifierVersion ?? context.classifierVersion},
    ${entry.reason}`;
}

/**
 * Appends one entry, unconditionally.
 *
 * @param tx - The write transaction.
 * @param context - Stack, versions and model this run shares.
 * @param entry - The entry to append.
 */
async function insertEntry(
  tx: Database,
  context: ClassificationWriteContext,
  entry: ClassificationLogEntry,
): Promise<void> {
  await tx.execute(sql`
    insert into kg_classification_log (${LOG_COLUMNS})
    values (${entryValues(context, entry)})
  `);
}

/**
 * Appends one entry only while nothing already records the same decision.
 *
 * The predicate is the dedupe key the caller's entry names: the same candidate under
 * the same reason and the same catalog and classifier versions. `is not distinct from`
 * because a refusal's versions are nullable in principle, and a `null` that equals
 * `null` must count as the same refusal rather than escape the predicate.
 *
 * Idempotent under a retry and inside one transaction (the second attempt reads the
 * first's row). Two CONCURRENT transactions are serialized by the caller, which takes an
 * advisory lock before the first guarded write.
 *
 * @param tx - The write transaction.
 * @param context - Stack, versions and model this run shares.
 * @param entry - The entry to append at most once.
 * @returns True when a row was inserted, false when one already existed.
 */
async function insertEntryOnce(
  tx: Database,
  context: ClassificationWriteContext,
  entry: ClassificationLogEntry,
): Promise<boolean> {
  const catalogVersion = entry.catalogVersion ?? context.catalogVersion;
  const classifierVersion = entry.classifierVersion ?? context.classifierVersion;
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into kg_classification_log (${LOG_COLUMNS})
    select ${entryValues(context, entry)}
    where not exists (
      select 1 from kg_classification_log recorded
      where recorded.stack_id = ${context.stackId}
        and recorded.candidate_kind = ${entry.candidateKind}
        and recorded.candidate_ref = ${entry.candidateRef}
        and recorded.reason is not distinct from ${entry.reason}
        and recorded.catalog_version is not distinct from ${catalogVersion}
        and recorded.classifier_version is not distinct from ${classifierVersion}
    )
    returning id
  `);
  return inserted.length > 0;
}

/**
 * Appends every entry in the caller's transaction.
 *
 * A single loop of single-row inserts, in the caller's order: the history of one
 * run reads in candidate order, entities before relations, which is what makes the
 * table usable without a sequence column.
 *
 * @param tx - The write transaction.
 * @param context - Stack, versions and model this run shares.
 * @param entries - The entries to append, in order.
 * @returns How many rows were written and how many were already recorded.
 */
export async function appendClassificationLog(
  tx: Database,
  context: ClassificationWriteContext,
  entries: readonly ClassificationLogEntry[],
): Promise<ClassificationLogWrite> {
  let appended = 0;
  let deduplicated = 0;
  for (const entry of entries) {
    if (entry.idempotent !== true) {
      await insertEntry(tx, context, entry);
      appended += 1;
      continue;
    }
    if (await insertEntryOnce(tx, context, entry)) {
      appended += 1;
      continue;
    }
    deduplicated += 1;
  }
  return { appended, deduplicated };
}
