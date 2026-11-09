/**
 * @file test/dimensions/kg-rls-tenant-catalog.test.ts
 * @description The CATALOG half of tenant isolation: every relation keyed by `stack_id` really
 * has row-level security ENABLED, really has it FORCED, and really carries a policy set that
 * covers both `INSERT` and `UPDATE`.
 *
 * ## Why these properties cannot be proven by a write probe
 *
 * `kg-rls-write-refusal.test.ts` proves the same relations refuse a cross-tenant write when the
 * statements run as `llmwiki_app`. Two defects survive that probe, which is why they are read
 * from the catalog here instead:
 *
 *  - a relation that lost `FORCE ROW LEVEL SECURITY` still refuses a cross-tenant write from
 *    `llmwiki_app`, because FORCE is about the table OWNER and the application role is not the
 *    owner. The flag is invisible to a behavioural probe and can only be read from the catalog;
 *  - a relation that lost a write-capable policy can still refuse an INSERT — a table with no
 *    applicable permissive policy refuses one anyway — so the write probe answers a different
 *    question than "is this write governed".
 *
 * Both defects have the same failure shape if the derivation is allowed to filter on them: the
 * relation leaves the population and the suite stays green. The population therefore comes from
 * `test/fixtures/rls-catalog.ts`, which asks about a `stack_id` COLUMN and nothing else, and the
 * flags are asserted per relation so the failure names the relation that lost one.
 *
 * ## Why the population is derived rather than baked
 *
 * A baked list of names stops covering the table somebody adds tomorrow, and it does so
 * silently. The catalog is asked instead, and the first case below fails when that answer is
 * empty so nothing here can pass over an empty set.
 *
 * ## Why `public.stacks` needs its own case
 *
 * The derivation asks about a `stack_id` COLUMN, and `public.stacks` carries its tenant as its
 * own primary key, so no derivation keyed on that column can reach the bootstrap table. Folded
 * into the loop it would assert nothing; left out entirely, dropping `FORCE ROW LEVEL SECURITY`
 * on it stays green. So its two flags are read from the catalog by name, in a case that fails
 * with `public.stacks` in the message.
 *
 * ## The three database conditions, identical to the write-refusal suite
 *
 * `createKgPostgresHarness` decides whether a database exists and owns the wording
 * (`test/fixtures/kg-postgres.ts` -> `missingTestDatabase`). An unreachable database WITHOUT the
 * documented opt-out `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` throws that actionable failure before a
 * single case is collected; with the opt-out it warns with the same text and reports
 * `reachable === false`, and this file registers itself as SKIPPED instead of asserting nothing.
 * A reachable database is never skipped.
 */

import { afterAll, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";

import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import {
  readTenantRelations,
  uncoveredWriteCommands,
  type DerivedRelation,
} from "../fixtures/rls-catalog.js";

const harness = await createKgPostgresHarness("kg-rls-tenant-catalog");
const { db, reachable } = harness;

/** Run one catalog query on the harness connection, which bypasses RLS. */
async function onCatalog<T>(query: SQL): Promise<T[]> {
  // The driver's result type is a `RowList` of generic rows; each query above names the shape
  // it selected, which is why the cast is the narrowest honest statement available.
  return (await db.execute(query)) as unknown as T[];
}

/** The derived population, read once; empty only when this file has no database. */
const RELATIONS: readonly DerivedRelation[] = reachable ? await readTenantRelations(onCatalog) : [];

/** The one tenant relation the `stack_id` derivation cannot reach: it keys on its own id. */
const SELF_TENANT_RELATION = "public.stacks";

/** The two RLS flags on {@link SELF_TENANT_RELATION}, read from `pg_class` and nowhere else. */
const SELF_TENANT_FLAGS_QUERY = sql`
  select c.relrowsecurity as "rowSecurityEnabled",
         c.relforcerowsecurity as "rowSecurityForced"
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'stacks'
    and c.relkind = 'r'
`;

/** One {@link SELF_TENANT_FLAGS_QUERY} row. */
interface RowSecurityFlags {
  readonly rowSecurityEnabled: boolean;
  readonly rowSecurityForced: boolean;
}

afterAll(async () => {
  await harness.cleanup();
});

it.skipIf(!reachable)("derives a non-empty, duplicate-free relation set", async () => {
  expect(
    RELATIONS.length,
    "the catalog must report at least one table with a live stack_id column, or every case " +
      "below asserts nothing",
  ).toBeGreaterThan(0);
  const identifiers = RELATIONS.map((relation) => relation.identifier);
  expect(new Set(identifiers).size, "the derivation must not report a relation twice").toBe(
    identifiers.length,
  );
}, 60_000);

it.skipIf(!reachable)("enables and FORCES row-level security on every derived relation", async () => {
  for (const relation of RELATIONS) {
    // Asserted HERE rather than used to filter the derivation: a flag that filtered the set
    // would make a dropped `force row level security` reduce the iteration count instead of
    // failing, which is the defect this pair of suites was rewritten to remove.
    expect(
      relation.rowSecurityEnabled,
      `${relation.identifier}: row-level security must be ENABLED (pg_class.relrowsecurity) on ` +
        `every relation keyed by stack_id, or nothing refuses a tenant write to it`,
    ).toBe(true);
    expect(
      relation.rowSecurityForced,
      `${relation.identifier}: row-level security must be FORCED (pg_class.relforcerowsecurity), ` +
        `or the policies do not bind the table owner`,
    ).toBe(true);
  }
}, 60_000);

it.skipIf(!reachable)("enables and FORCES row-level security on public.stacks itself", async () => {
  const [stacksTable] = await onCatalog<RowSecurityFlags>(SELF_TENANT_FLAGS_QUERY);
  // A missing row would make both assertions below vacuous, so it fails here instead of
  // reading as a database that simply has nothing to check.
  expect(
    stacksTable,
    `${SELF_TENANT_RELATION}: pg_class reports no such relation, so its row-level security ` +
      `cannot be asserted at all`,
  ).toBeDefined();
  expect(
    stacksTable?.rowSecurityEnabled,
    `${SELF_TENANT_RELATION}: row-level security must be ENABLED (pg_class.relrowsecurity), ` +
      `or its tenant_isolation policy governs nothing it writes`,
  ).toBe(true);
  expect(
    stacksTable?.rowSecurityForced,
    `${SELF_TENANT_RELATION}: row-level security must be FORCED (pg_class.relforcerowsecurity), ` +
      `or its tenant_isolation policy would not bind the table owner`,
  ).toBe(true);
}, 60_000);

it.skipIf(!reachable)("covers both INSERT and UPDATE on every derived relation", async () => {
  for (const relation of RELATIONS) {
    // Coverage, not `cmd = 'ALL'`: splitting one `FOR ALL` policy into `FOR INSERT` plus `FOR
    // UPDATE` is equally strong and must not fail here. `SELECT` alone fails, and so does
    // `SELECT` plus `INSERT` — the update half would be governed by no policy at all.
    const uncovered = uncoveredWriteCommands(relation.commands);
    expect(
      uncovered,
      `${relation.identifier}: no policy covers ${uncovered.join(" and ")}, so that write is ` +
        `ungoverned; its policy commands are [${relation.commands.join(", ")}], and it needs ` +
        `either one ALL policy or one INSERT plus one UPDATE policy`,
    ).toHaveLength(0);
  }
}, 60_000);
