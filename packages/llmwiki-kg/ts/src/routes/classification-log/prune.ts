/**
 * @file packages/llmwiki-kg/ts/src/routes/classification-log/prune.ts
 * @description Bounded retention for `kg_classification_log`: an administrative
 * time-window DELETE of one Stack's preserved-after-failure events, and nothing else.
 *
 * ## Why the table needs retention at all
 *
 * A failing classifier appends one `provider_failure_preserved:*` row per sweep per
 * affected candidate, and that is CORRECT: a refusal is state, a failure is an event.
 * A candidate that failed 47 consecutive sweeps is diagnostically different from one
 * that failed once during a transient outage, so deduping at write time would destroy
 * the signal the log exists to carry. Nothing here changes that — every surviving row
 * is still one real occurrence, and the write path is untouched.
 *
 * What cannot be accepted is unbounded growth: a permanently failing classifier writes
 * one row per sweep per candidate forever, so a single day of failed sweeps already
 * dominates the table (47 sweeps is minutes). The fix is therefore not a write-time
 * collapse but a separate, EXPLICIT administrative delete over a time window.
 *
 * ## Why a time window and not a rollup
 *
 * The alternative was collapsing old events into a summary row carrying a count plus
 * first/last seen. It needs a marker column or a new table (moving `schema.sql`, its
 * drizzle mirror and the schema parity test), it turns idempotency into a
 * re-aggregation problem, and its aggregate rows would then have to be excluded from
 * every history read — a change to read semantics, which is the same destruction of
 * the per-occurrence signal relocated rather than avoided. A window keeps every
 * surviving row a real occurrence and leaves the consecutive-failure read untouched.
 *
 * The accepted cost is that the tail of a failure run older than the window stops
 * being observable. The 30-day default below and the documented export-first operator
 * step are the mitigation.
 *
 * ## Two guards, only one of which is real
 *
 * The statement binds the tenant with `set_config('app.stack_id', ...)` for the sake of
 * consistency with every other tenanted write, but that binding is NOT what protects
 * the other Stacks: the application connects as a role that BYPASSES row-level
 * security, so the policy predicate never runs. The explicit `stack_id = $1` in the
 * WHERE clause is the real guard, repeated in both the count and the delete so the two
 * can never disagree about which rows they are describing.
 *
 * ## Dry run is the default
 *
 * Deleting rows is irreversible, so the operation reports and stops unless the caller
 * passes `confirm: true` explicitly. A dry run takes the same lock, computes the same
 * cutoff and runs the same count as the real thing — otherwise the number an operator
 * inspects would not be the number the confirmed run would act on.
 */

import { sql } from "drizzle-orm";

import { bindTenant } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import type { TransactionRunner } from "../../db.js";
import { PRESERVED_REASON_PREFIX } from "../reclassify/persist.js";

/**
 * How long a preserved-after-failure event is kept, in days, when the operator says
 * nothing.
 *
 * WHY 30. A permanently failing classifier writes one row per sweep per candidate, so
 * a day of failed sweeps already dominates the table (47 sweeps is minutes), while 30
 * days covers a full monthly operational cycle, incident postmortems and the "did this
 * regress last month?" question. A shorter window loses the diagnostic tail inside the
 * reporting period; a longer one stops bounding growth. It stays configurable because
 * Stacks with different incident cadences need a different answer.
 */
export const DEFAULT_CLASSIFICATION_FAILURE_RETENTION_DAYS = 30;

/**
 * The longest window this operation accepts, in days.
 *
 * Ten years: beyond it the argument is not a window but a typo (a caller passing
 * milliseconds, or an epoch), and a mistyped huge window would silently delete the
 * entire failure history of a Stack. Named rather than inline so the bound is
 * readable from the outside.
 */
export const MAX_CLASSIFICATION_FAILURE_RETENTION_DAYS = 3650;

/**
 * The reason prefix of the ONLY row family eligible for retention.
 *
 * Re-exported from the writer that produces it rather than re-spelled: two literals
 * that must agree but are maintained apart drift, and this one decides which rows are
 * deleted. Rows with `refused:verified_row_preserved` are state, never events, and are
 * never eligible.
 */
export const FAILURE_REASON_PREFIX = `${PRESERVED_REASON_PREFIX}:`;

/**
 * The LIKE pattern matching exactly that literal prefix.
 *
 * `_` and `%` are LIKE metacharacters, and the prefix contains underscores, so an
 * unescaped pattern would also match `provider-failure-preserved:*`. Retention is a
 * delete, so the pattern has to mean the literal family and nothing a wildcard happens
 * to reach; every metacharacter is escaped and the statement declares the escape.
 */
const FAILURE_PATTERN = `${FAILURE_REASON_PREFIX.replaceAll("\\", "\\\\")
  .replaceAll("%", "\\%")
  .replaceAll("_", "\\_")}%`;

/** The advisory-lock namespaces keyed per Stack, so two prunes of one Stack serialize. */
const PRUNE_LOCK_PREFIX = "kg-classification-log-prune";

/** What one prune asks for. */
export interface ClassificationFailurePruneRequest {
  /** The Stack whose failure events are under retention. */
  readonly stackId: string;
  /** Window in days; defaults to {@link DEFAULT_CLASSIFICATION_FAILURE_RETENTION_DAYS}. */
  readonly retentionDays?: number;
  /** Deletes only when this is exactly `true`; anything else is a dry run. */
  readonly confirm?: boolean;
}

/** What one prune reports, whether it deleted anything or not. */
export interface ClassificationFailurePruneOutcome {
  /** True when nothing was deleted. */
  readonly dryRun: boolean;
  /** The window that was applied, so the report is readable without the request. */
  readonly retentionDays: number;
  /** The fixed instant the window was measured against. */
  readonly cutoff: string;
  /** How many rows the window matched, deleted or not. */
  readonly matchedCount: number;
  /** How many rows were actually deleted: always zero on a dry run. */
  readonly deletedCount: number;
}

/**
 * The predicate both statements share.
 *
 * Written once because the count and the delete must describe the same set: two copies
 * of a predicate is how a report ends up naming a number the delete did not act on.
 *
 * @param stackId - The Stack under retention.
 * @param cutoff - Instant computed once for this transaction.
 */
function eligibleFailures(stackId: string, cutoff: string) {
  return sql`stack_id = ${stackId}
      and reason like ${FAILURE_PATTERN} escape '\\'
      and created_at < ${cutoff}`;
}

/**
 * Rejects a window this operation will not run with.
 *
 * @param retentionDays - The requested window.
 * @throws {RangeError} When it is not a whole number of days inside the accepted range.
 */
function assertRetentionWindow(retentionDays: number): void {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new RangeError(`retentionDays must be a whole number of days of at least 1, received ${retentionDays}`);
  }
  if (retentionDays > MAX_CLASSIFICATION_FAILURE_RETENTION_DAYS) {
    throw new RangeError(
      `retentionDays must not exceed ${MAX_CLASSIFICATION_FAILURE_RETENTION_DAYS}, received ${retentionDays}`,
    );
  }
}

/**
 * Computes the cutoff ONCE, inside the transaction that will use it.
 *
 * `now()` is the transaction's start instant, so the window is fixed for the whole
 * operation: a dry run and a confirmed run describe the same set, and a second run over
 * an already-pruned table matches nothing rather than a slightly later instant.
 *
 * @param tx - The prune transaction.
 * @param retentionDays - The window to subtract.
 * @returns The cutoff as the database's normalized timestamp text.
 */
async function cutoffFor(tx: Database, retentionDays: number): Promise<string> {
  const rows = await tx.execute<{ cutoff: string }>(sql`
    select now() - make_interval(days => ${retentionDays}::int) as cutoff
  `);
  const cutoff = rows[0]?.cutoff;
  if (cutoff === undefined) {
    throw new Error("the database returned no retention cutoff");
  }
  return cutoff;
}

/**
 * Counts the rows the window matches.
 *
 * @param tx - The prune transaction.
 * @param stackId - The Stack under retention.
 * @param cutoff - Instant computed once for this transaction.
 * @returns How many rows are eligible.
 */
async function countFailures(tx: Database, stackId: string, cutoff: string): Promise<number> {
  // `count(*)` is `numeric`/`bigint`; `::int` keeps the report a number instead of the
  // string the driver would hand back for either of those.
  const rows = await tx.execute<{ matched: number }>(sql`
    select count(*)::int as matched
    from kg_classification_log
    where ${eligibleFailures(stackId, cutoff)}
  `);
  return rows[0]?.matched ?? 0;
}

/**
 * Deletes the rows the window matches, in one statement.
 *
 * One statement rather than a read-then-delete loop: a single DELETE takes the rows it
 * returns, so a sweep appending concurrently can add a newer row but can never cause
 * this operation to delete a row it did not report.
 *
 * @param tx - The prune transaction.
 * @param stackId - The Stack under retention.
 * @param cutoff - Instant computed once for this transaction.
 * @returns How many rows were deleted.
 */
async function deleteFailures(tx: Database, stackId: string, cutoff: string): Promise<number> {
  const deleted = await tx.execute<{ id: string }>(sql`
    delete from kg_classification_log
    where ${eligibleFailures(stackId, cutoff)}
    returning id
  `);
  return deleted.length;
}

/**
 * The whole operation inside one transaction: bind, serialize, measure, maybe delete.
 *
 * @param tx - A short transaction owned by this operation.
 * @param stackId - The Stack under retention.
 * @param retentionDays - The window to apply.
 * @param dryRun - True when nothing may be deleted.
 * @returns The report.
 */
async function pruneInTransaction(
  tx: Database,
  stackId: string,
  retentionDays: number,
  dryRun: boolean,
): Promise<ClassificationFailurePruneOutcome> {
  await bindTenant(tx, stackId, null);
  // Two prunes of one Stack are serialized here: the second waits for the first to
  // commit, then counts and deletes against a table the first already pruned, so a row
  // is never deleted twice and never lost. A hash collision between two Stacks costs a
  // wait, never a row.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${PRUNE_LOCK_PREFIX}:${stackId}`}))`);
  const cutoff = await cutoffFor(tx, retentionDays);
  const matchedCount = await countFailures(tx, stackId, cutoff);
  const deletedCount = dryRun ? 0 : await deleteFailures(tx, stackId, cutoff);
  return { dryRun, retentionDays, cutoff, matchedCount, deletedCount };
}

/**
 * Prunes the preserved-after-failure history of one Stack.
 *
 * EXPLICIT and administrative by construction: it is never called from ingest, never
 * called inside another operation's transaction, and it is a dry run unless the caller
 * asks for the deletion.
 *
 * @param run - How this deployment opens a short transaction.
 * @param request - The Stack, the window and whether deletion is confirmed.
 * @returns What the window matched and what was deleted.
 * @throws {RangeError} When `retentionDays` is outside the accepted range, in which case
 *   no transaction is opened and nothing is touched.
 */
export async function pruneClassificationFailures(
  run: TransactionRunner,
  request: ClassificationFailurePruneRequest,
): Promise<ClassificationFailurePruneOutcome> {
  const retentionDays = request.retentionDays ?? DEFAULT_CLASSIFICATION_FAILURE_RETENTION_DAYS;
  assertRetentionWindow(retentionDays);
  // Only an explicit `true` deletes: a caller that passes nothing, or anything falsy,
  // gets the report instead of the deletion.
  const dryRun = request.confirm !== true;
  return run((tx) => pruneInTransaction(tx, request.stackId, retentionDays, dryRun));
}
