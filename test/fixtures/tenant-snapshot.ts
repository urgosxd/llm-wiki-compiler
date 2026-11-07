/**
 * @file test/fixtures/tenant-snapshot.ts
 * @description The one shared cross-tenant invariant: a tenant's stored ROWS, before and after.
 *
 * ## Why CONTENT rather than counts
 *
 * The class this helper guards is "a request-scoped call wrote to, or read from, a
 * Stack nobody named" — the lock, the derived artefacts and the candidate/pages
 * seams are three occurrences of it. A row counter is the cheapest detector and the
 * weakest one, for two measured reasons:
 *
 *  - an UPDATE moves no counter. A run that rewrote another tenant's page body,
 *    candidate row or derived artefact in place would be invisible to `count(*)`;
 *  - a count that stays equal hides a MOVE. One row added and one removed leaves
 *    `pages = 1` before and after, so "unchanged" would be reported for a run that
 *    replaced the victim's content wholesale.
 *
 * So every row is captured as canonical, deterministically ordered TEXT and the
 * assertion is byte equality. That is the only form in which "the ambient Stack is
 * untouched" is a literal claim rather than a proxy for one, and it is why this
 * assertion cannot cry wolf: it is the comparison of a tenant against itself.
 *
 * ## Why the row is serialized instead of the columns being enumerated
 *
 * `to_jsonb(t)::text` needs no knowledge of any table's columns, so adding a column
 * to `wiki.pages` cannot silently drop it from the guard, and the ORDER BY is the
 * serialized row itself — canonical ordering without a per-table key, and stable
 * across a schema change that reorders a table's columns. `stack_id` is passed as a
 * bind parameter, never interpolated.
 *
 * ## Why the table list is a UNION of the variants it replaces
 *
 * Three mutually inconsistent inline variants existed (a single-table `rowCount`, a
 * five-table set, and a DIFFERENT four-table set). A helper that had inherited
 * either narrow set would have been unable to see a displacement into the table only
 * the other variant listed, so the set here is the union and every name is verified
 * against `src/dimensions/wiki/schema.sql` and its migrations: all six exist and all
 * six carry a `stack_id` column.
 *
 * @example
 * const before = await snapshotTenantRows(ambient.harness, ambient.harness.stackId);
 * await compileAndReport(root, { env: requestEnv });
 * assertTenantUnchanged(before, await snapshotTenantRows(ambient.harness, id), "Stack B");
 */

import { sql } from "drizzle-orm";

import type { KgPostgresHarness } from "./kg-postgres.js";

/**
 * Every Stack-scoped table a request-scoped call could write or move.
 *
 * The union of the three inline variants this replaces, each name verified against
 * the schema and its migration. Kept to tables that store TENANT data: a counter or
 * singleton table (`stacks` itself) is not a victim of a displaced write.
 */
export const TENANT_TABLES: readonly string[] = [
  "wiki.pages",
  "wiki.review_candidates",
  "wiki.ingest_job",
  "wiki.derived_artifact",
  "wiki.activity_log",
  "wiki.source_documents",
];

/** One tenant's rows: table name → canonically ordered serialized row text. */
export type TenantSnapshot = Readonly<Record<string, readonly string[]>>;

/**
 * Capture every row `stackId` owns, as canonical text.
 *
 * @param harness - A handle on the database the Stack lives in.
 * @param stackId - The ONE tenant to capture; bound as a parameter, never spliced.
 * @returns Table name → its rows, ordered by their own serialized text.
 */
export async function snapshotTenantRows(
  harness: KgPostgresHarness,
  stackId: string,
): Promise<TenantSnapshot> {
  const snapshot: Record<string, readonly string[]> = {};
  for (const table of TENANT_TABLES) {
    const rows = await harness.db.execute<{ row: string }>(
      sql`select to_jsonb(t)::text as row from ${sql.raw(table)} t
          where t.stack_id = ${stackId}::uuid
          order by to_jsonb(t)::text`,
    );
    snapshot[table] = rows.map((entry) => entry.row);
  }
  return snapshot;
}

/**
 * Rows whose multiplicity in `left` exceeds their multiplicity in `right`.
 *
 * Multiset, not set: two identical rows are a legal state for several of these
 * tables, so removing one of a pair must still register as a change.
 *
 * @param left - The rows to look for.
 * @param right - The rows to subtract.
 * @returns Every row left over, in `left`'s order.
 */
function rowsOnlyIn(left: readonly string[], right: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const row of right) remaining.set(row, (remaining.get(row) ?? 0) + 1);
  const only: string[] = [];
  for (const row of left) {
    const seen = remaining.get(row) ?? 0;
    if (seen > 0) remaining.set(row, seen - 1);
    else only.push(row);
  }
  return only;
}

/**
 * Diff two snapshots of the same tenant.
 *
 * Exact by construction: an added row, a removed row and a CHANGED row each produce
 * a non-empty report — a changed row appears once as a removal and once as an
 * addition, because the row itself is the comparison unit.
 *
 * @param before - The snapshot taken before the run.
 * @param after - The snapshot taken after it.
 * @returns `""` when the tenant is byte-identical, otherwise one line per moved row.
 */
export function diffTenantSnapshots(before: TenantSnapshot, after: TenantSnapshot): string {
  const report: string[] = [];
  for (const table of TENANT_TABLES) {
    const was = before[table] ?? [];
    const is = after[table] ?? [];
    for (const row of rowsOnlyIn(was, is)) report.push(`${table} - ${row}`);
    for (const row of rowsOnlyIn(is, was)) report.push(`${table} + ${row}`);
  }
  return report.join("\n");
}

/**
 * Fail with the table and the exact rows when a tenant moved.
 *
 * Thrown rather than returned so the failure names the surviving evidence: a
 * displaced write is only actionable if the reader can see WHICH row landed in the
 * wrong tenant.
 *
 * @param before - The snapshot taken before the run.
 * @param after - The snapshot taken after it.
 * @param label - How to name the tenant in the failure, e.g. "Stack B (ambient)".
 * @throws When any of the tenant's rows changed.
 */
export function assertTenantUnchanged(
  before: TenantSnapshot,
  after: TenantSnapshot,
  label: string,
): void {
  const report = diffTenantSnapshots(before, after);
  if (report === "") return;
  throw new Error(`${label}: stored rows changed during the run\n${report}`);
}
