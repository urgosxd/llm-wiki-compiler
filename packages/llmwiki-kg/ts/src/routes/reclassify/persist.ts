/**
 * @file packages/llmwiki-kg/ts/src/routes/reclassify/persist.ts
 * @description Stage 3 of a reclassification run: write the decisions that changed,
 * and the history of every change, inside ONE short transaction.
 *
 * ## Nothing is inserted, nothing is deleted, nothing is moved
 *
 * Every write is an `UPDATE` of a row that already exists, addressed by its own
 * primary key. That is what keeps the three things a re-decision must never break: the
 * UUID other facts point at (S28), the `entity_source_documents` rows that record which
 * documents contributed, and the relationships whose endpoints are that UUID. Only the
 * decision columns move, and `type`, `predicate`, `properties`, `identity_key` and
 * `verified` are not among them.
 *
 * `verified` in particular is never written. It means a human reviewed the fact (S39),
 * and no branch of this module has a human in it.
 *
 * ## Four outcomes, four traces
 *
 * - **changed** — the decision columns move and one `kg_classification_log` row names
 *   the previous state, the previous canonical type, the new pair, the vendor readout,
 *   both versions and the reason (S43).
 * - **versions refreshed** — the decision columns move to the SAME answer under the new
 *   versions, and no history row is written: nothing about the classification changed.
 *   Without the write the sweep would never converge, because the row would stay stale
 *   forever.
 * - **unchanged** — nothing is written at all, so a second identical run leaves no
 *   trace to explain away (S43).
 * - **preserved after a failure** — the row keeps the decision it had, and one history
 *   row records that the attempt failed and the decision was kept (S45.13). An outage
 *   is not an answer, and erasing a type because a socket closed would silently
 *   regress what the graph had established.
 *
 * A verified row was separated out by stage 1 and is never classified; its refusal is
 * recorded here, naming the state and canonical type it kept, so "we did not touch it"
 * is something a reader can find instead of something a reader has to assume.
 *
 * ## A refusal is recorded once per version, not once per sweep
 *
 * A verified row keeps the versions it was verified under, so the skew predicate selects
 * it again on every sweep: it converges on nothing, by design (S39). Recording the
 * refusal again each time would grow `kg_classification_log` by (verified rows x sweeps)
 * on a scheduled operation. The refusal entry therefore names the versions THIS RUN
 * decided under — not the versions the row still holds — and is written idempotently
 * against them (see `appendClassificationLog`): the same catalog and classifier silence a
 * repeated refusal, and a bumped catalog or classifier version records a fresh one,
 * because a refusal under a new vocabulary is a new decision. The counted report keeps
 * the refusals it collapsed, so an operator sees deduplication rather than silence.
 *
 * Only the refusal entry is idempotent. A real change and a preserved decision happened
 * once and must stay traceable every time they happen (S43).
 */

import { sql } from "drizzle-orm";

import type { CandidateDecision } from "../../core/classify/types.js";
import { bindCallerStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { appendClassificationLog, decisionLogEntry } from "../ingest/classification-log.js";
import type { ClassificationLogEntry, ClassificationWriteContext } from "../ingest/classification-log.js";
import { applyEntityDecision, applyRelationDecision } from "../ingest/persist-classification.js";
import type { ReclassifyAction } from "./plan.js";
import type { ReclassifyRow } from "./types.js";

/** One row, the decision this run made about it, and what the plan said to do. */
export interface PlannedDecision {
  readonly row: ReclassifyRow;
  readonly decision: CandidateDecision;
  readonly action: ReclassifyAction;
}

/** How many rows fell into each outcome, for the run's report. */
export interface PersistCounts {
  readonly applied: number;
  readonly changed: number;
  readonly versionsRefreshed: number;
  readonly unchanged: number;
  readonly preservedAfterFailure: number;
  /** Refusals already recorded under the same versions, so nothing was written. */
  readonly refusedDeduplicated: number;
}

/** The reason recorded for a refusal, spelled once so a reader and a test agree. */
export const VERIFIED_REFUSAL_REASON = "refused:verified_row_preserved";

/** The prefix recorded when an outage left a stored decision untouched. */
export const PRESERVED_REASON_PREFIX = "provider_failure_preserved";

/**
 * The history reason of an applied change.
 *
 * A real change keeps the classifier's own reason, so `free_no_match` still says why
 * it abstained. A refresh or a first decision has no classifier reason, so it records
 * the action itself — a reader must be able to tell a new decision from a re-run of an
 * old one.
 *
 * @param planned - The planned decision.
 * @returns The `reason` column's value.
 */
function changeReason(planned: PlannedDecision): string | null {
  if (planned.action.kind !== "apply") return null;
  if (planned.action.reason === "classification_changed") return planned.decision.reason;
  return planned.action.reason;
}

/**
 * Applies one row's decision through the shared updater for its kind.
 *
 * One writer for the decision columns means a reclassification and an ingest cannot
 * disagree about which column holds what.
 *
 * @param tx - The write transaction.
 * @param context - Stack, versions and model for this run.
 * @param planned - The row and its decision.
 */
async function writeDecision(
  tx: Database,
  context: ClassificationWriteContext,
  planned: PlannedDecision,
): Promise<void> {
  const { row, decision } = planned;
  if (decision.kind === "entity") {
    await applyEntityDecision(tx, context, row.id, decision);
    return;
  }
  if (row.edge === undefined) {
    throw new Error(`relationship ${row.id} was selected without its endpoints`);
  }
  await applyRelationDecision(tx, context, row.edge, decision);
}

/**
 * The history entry of a decision the row kept because the classifier failed.
 *
 * `new_state` is the state the row STILL holds, because that is what the row holds
 * after this run: the failed attempt did not become the row's state, and a log that
 * said otherwise would disagree with the table it describes. The failure, and the
 * operational state it would have written, are named in the reason.
 *
 * @param row - The row that kept its decision.
 * @param operationalState - The state the failed attempt would have stored.
 * @returns The entry to append.
 */
function preservedEntry(row: ReclassifyRow, operationalState: "pending" | "failed"): ClassificationLogEntry {
  return {
    candidateKind: row.kind,
    candidateRef: row.ref,
    previousState: row.stored.classificationState,
    newState: row.stored.classificationState ?? operationalState,
    previousCanonicalType: row.stored.canonicalType,
    newCanonicalType: row.stored.canonicalType,
    readout: null,
    catalogVersion: row.stored.catalogVersion,
    classifierVersion: row.stored.classifierVersion,
    reason: `${PRESERVED_REASON_PREFIX}:${operationalState}`,
  };
}

/**
 * The history entry of a verified row this run refused to re-decide.
 *
 * The versions are the RUN's, not the row's: the entry answers "under which catalog and
 * classifier was this row refused?". That is also what makes the write idempotent — the
 * dedupe key includes both versions, so a repeated sweep under the same vocabulary adds
 * nothing while a bumped catalog records a fresh refusal.
 *
 * @param row - The verified row that was left alone.
 * @param context - Stack, versions and model for this run.
 * @returns The entry to append at most once per version.
 */
function refusalEntry(row: ReclassifyRow, context: ClassificationWriteContext): ClassificationLogEntry {
  return {
    candidateKind: row.kind,
    candidateRef: row.ref,
    previousState: row.stored.classificationState,
    newState: row.stored.classificationState ?? "pending",
    previousCanonicalType: row.stored.canonicalType,
    newCanonicalType: row.stored.canonicalType,
    readout: null,
    catalogVersion: context.catalogVersion,
    classifierVersion: context.classifierVersion,
    reason: VERIFIED_REFUSAL_REASON,
    idempotent: true,
  };
}

/**
 * Serializes the refusal writes of two sweeps of the same Stack.
 *
 * `not exists` is idempotent across a retry and inside one transaction, but two sweeps
 * running at the same instant can both read before either writes. A transaction-scoped
 * advisory lock named after the Stack closes that window: the second sweep waits for the
 * first to commit, then sees its row and writes nothing. A hash collision between two
 * Stacks costs a wait, never a row.
 *
 * @param tx - The write transaction.
 * @param stackId - The Stack whose refusals are being recorded.
 */
async function serializeRefusalWrites(tx: Database, stackId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`kg-refusal:${stackId}`}))`);
}

/**
 * Stage 3: applies the plan and appends its history, in the caller's transaction.
 *
 * @param tx - A SHORT write transaction, opened after every classifier call finished.
 * @param context - Stack, versions and model for this run.
 * @param planned - Every decided row and its planned action, entities first.
 * @param refused - The verified rows stage 1 separated out.
 * @returns How many rows fell into each outcome.
 */
export async function persistReclassification(
  tx: Database,
  context: ClassificationWriteContext,
  planned: readonly PlannedDecision[],
  refused: readonly ReclassifyRow[],
): Promise<PersistCounts> {
  await bindCallerStack(tx, context.stackId, null);
  let applied = 0;
  let changed = 0;
  let versionsRefreshed = 0;
  let unchanged = 0;
  let preservedAfterFailure = 0;
  const history: ClassificationLogEntry[] = refused.map((row) => refusalEntry(row, context));
  if (history.length > 0) await serializeRefusalWrites(tx, context.stackId);
  for (const item of planned) {
    if (item.action.kind === "noop") {
      unchanged += 1;
      continue;
    }
    if (item.action.kind === "preserved_after_failure") {
      preservedAfterFailure += 1;
      history.push(preservedEntry(item.row, item.action.operationalState));
      continue;
    }
    await writeDecision(tx, context, item);
    applied += 1;
    if (item.action.reason === "versions_refreshed") {
      // The row now records the version it was re-decided under, which is what makes
      // the sweep converge. Nothing about the classification changed, so there is
      // nothing for the history to explain.
      versionsRefreshed += 1;
      continue;
    }
    changed += 1;
    history.push({
      ...decisionLogEntry(item.decision, {
        state: item.row.stored.classificationState,
        canonicalType: item.row.stored.canonicalType,
      }),
      classifierVersion: context.classifierVersion,
      reason: changeReason(item),
    });
  }
  const write = await appendClassificationLog(tx, context, history);
  // Only refusal entries are idempotent, so every deduplicated entry is a refusal this
  // run found already recorded under its versions.
  return {
    applied,
    changed,
    versionsRefreshed,
    unchanged,
    preservedAfterFailure,
    refusedDeduplicated: write.deduplicated,
  };
}
