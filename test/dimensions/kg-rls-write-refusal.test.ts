/**
 * @file test/dimensions/kg-rls-write-refusal.test.ts
 * @description The WRITE half of tenant isolation, asserted against a real database as the
 * non-superuser application role.
 *
 * ## The gap this closes
 *
 * Every row-level-security assertion in this repository was READ-only: a bound session
 * counts zero rows owned by another tenant. Nothing asserted that a cross-tenant INSERT or
 * UPDATE is REFUSED, so a policy narrowed to `FOR SELECT` — or a dropped `FORCE ROW LEVEL
 * SECURITY` — would leave every existing suite green while tenant isolation for writes was
 * gone. This file asserts the write half, generically, on every relation the catalog says is
 * tenant-isolated.
 *
 * ## Why the relation list is derived by COLUMN PRESENCE, never by enforcement
 *
 * The population comes from `test/fixtures/rls-catalog.ts`, which asks the catalog for a live
 * `stack_id` column and nothing else. Deriving on an enforcement flag was MEASURED to defeat the
 * point: dropping `force row level security` on `wiki.pages` did not fail this file, it removed
 * the relation from the derived set (29 -> 28) while the non-empty guard still passed. A suite
 * that reports coverage by shrinking its own scope is a `skipIf` that never runs.
 *
 * ## What is asserted in `kg-rls-tenant-catalog.test.ts` instead, and why
 *
 * Two properties of the same population cannot be proven behaviourally, so they are read from
 * the catalog there: `FORCE ROW LEVEL SECURITY` binds the table OWNER and the application role is
 * not the owner, and a table with NO applicable permissive policy still refuses an INSERT — so a
 * write probe answers "was this refused", not "is this write governed". That file also asserts
 * that every derived relation has row-level security ENABLED, so an unenforced tenant table is
 * reported rather than filtered out of scope.
 *
 * `public.stacks` carries its tenant as its own primary key and its policy matches `id` OR
 * `domain`, so it has no `stack_id` column and no derivation can reach it. Its own explicit
 * cases below cover its write behaviour.
 *
 * ## What makes write isolation work, measured, not assumed
 *
 * Every policy on those relations is `FOR ALL` with `USING` and no `WITH CHECK`
 * (`pg_policies.cmd = 'ALL'`, `with_check` null). For a `FOR ALL` policy an omitted
 * `WITH CHECK` falls back to `USING`, so the read predicate is re-evaluated against the NEW
 * row and refuses a write that moves it to another tenant. Write isolation therefore comes
 * from `packages/llmwiki-kg/db/migration_rls_tenancy.sql` and the wiki DDL alone; there is
 * no separate write-policies migration, and `db/migration_rls_write_policies.sql` was
 * removed because it was never applied and did nothing.
 *
 * ## Why the role drop is not taken on trust
 *
 * The shared harness connects as `aks`, a SUPERUSER with BYPASSRLS, under which every policy
 * is inert and every assertion below would pass for the wrong reason. Dropping to
 * `llmwiki_app` with `set local role` is only half the proof: a statement that silently did
 * nothing would look identical. So the suite asserts the EFFECTIVE identity from the
 * catalog inside the transaction (`current_user`, `rolsuper`, `rolbypassrls`), and asserts
 * that the OUTER connection really can bypass RLS — otherwise an accidentally unprivileged
 * harness would make the drop meaningless instead of meaningful.
 *
 * ## Fail closed, and fail loudly
 *
 * A missing binding must reach no row rather than every row, so an unbound INSERT is refused
 * and an unbound UPDATE changes nothing.
 *
 * ## The three database conditions, and which of them is allowed to skip
 *
 * Two of them are NOT the same condition, and the difference is the whole point of this
 * section:
 *
 *  - the DATABASE cannot be reached — `createKgPostgresHarness` decides this and owns the
 *    wording (`test/fixtures/kg-postgres.ts` -> `missingTestDatabase`). Without the one
 *    documented opt-out `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` it THROWS the repository's
 *    actionable failure before a single case is collected; with the opt-out set it warns with
 *    that same text and reports `reachable === false`, and this file registers itself as
 *    SKIPPED rather than asserting nothing.
 *  - the `llmwiki_app` ROLE is ABSENT while the database answers — always a hard failure,
 *    opt-out or not. The role is created by `migration_rls_tenancy.sql`, which IS in
 *    `SCHEMA_FILES`, so its absence means the schema build was incomplete, and an incomplete
 *    schema build is exactly what this suite exists to report.
 *
 * An earlier revision rebuilt an `Error` from `missing.message` at both sites, which discarded
 * `missing.error === undefined` — the branch that only exists when the run opted out. The file
 * then failed with an error whose own text said to set `LLMWIKI_TEST_ALLOW_NO_DATABASE=1`, and
 * setting it changed nothing. The opt-out is now honoured where the repository already honours
 * it, in the harness, and no site here re-implements that decision.
 */

import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";

import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import {
  insertOwnedBy,
  readTenantRelations,
  type TenantRelation,
} from "../fixtures/rls-catalog.js";
import {
  APP_ROLE,
  asAppRole,
  connectionBypassesRls,
  sqlStateOf,
  type AppRoleExecutor,
} from "./kg-runtime-app-role.js";

/** SQLSTATE a refused row-level security check raises (`insufficient_privilege`). */
const POLICY_REFUSAL = "42501";

/** The file that creates the application role, and the reason its absence is a broken build. */
const ROLE_MIGRATION = "packages/llmwiki-kg/db/migration_rls_tenancy.sql";

/** Title every probe row is seeded with, so an unbound UPDATE can be measured. */
const PROBE_TITLE = "rls-probe";

/** Title an UPDATE would write if row-level security let it through. */
const MUTATED_TITLE = "rls-probe-mutated";

/** A tenant GUC the policies read. */
type TenantBinding = "app.stack_id" | "app.stack_domain";

const harness = await createKgPostgresHarness("kg-rls-write-refusal");
const { db, stackId, reachable } = harness;

/** A message from an unknown thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one statement on the harness connection, keeping a dead server actionable.
 *
 * The no-database decision is NOT taken here. `createKgPostgresHarness` takes it, at import,
 * before any case is collected — which is the only place a skip can still be honest — so
 * reaching this function at all means the database answered. A statement failing now is a
 * mid-run failure and is always loud; the opt-out is a decision about a database that was
 * never there, not about one that broke after the suite began asserting.
 *
 * @param query - Statement to run on the bypassing connection.
 * @returns Its rows.
 * @throws When the statement fails, naming what was being measured.
 */
async function onHarness<T>(query: SQL): Promise<T[]> {
  try {
    // The driver's result type is a `RowList` of generic rows; every caller here names the
    // shape it selected, which is why the cast is the narrowest honest statement available.
    return (await db.execute(query)) as unknown as T[];
  } catch (error) {
    throw new Error(
      `kg-rls-write-refusal: a statement on the harness connection failed and the database is ` +
        `no longer usable — ${describeError(error)}`,
    );
  }
}

/**
 * Fail unless the schema build created the application role.
 *
 * NOT a skip and not a `skipIf`: `llmwiki_app` is created by {@link ROLE_MIGRATION}, which
 * IS a member of `SCHEMA_FILES` in `scripts/apply-schemas.sh`, so a database without it was
 * not built by the repository's own schema runner. Skipping would report green while every
 * write-isolation assertion below asserted nothing, and the documented opt-out does not reach
 * here either: a reachable database that is missing the role is a broken schema build, which
 * is what this suite exists to report.
 */
async function requireAppRole(): Promise<void> {
  const rows = await onHarness<{ present: number }>(
    sql`select count(*)::int as present from pg_roles where rolname = ${APP_ROLE}`,
  );
  if ((rows[0]?.present ?? 0) > 0) return;
  throw new Error(
    `the schema build was incomplete: role "${APP_ROLE}" does not exist. It is created by ` +
      `${ROLE_MIGRATION}, which IS a member of SCHEMA_FILES in scripts/apply-schemas.sh, so a ` +
      `database without it was not built by the repository's own schema runner; re-run ` +
      `./scripts/apply-schemas.sh. This suite does not skip over it: a skip is reported as a ` +
      `pass while asserting nothing, and every assertion below needs that role.`,
  );
}

/** Bind one tenant GUC for the rest of the app-role transaction. */
async function bind(tx: AppRoleExecutor, name: TenantBinding, value: string): Promise<void> {
  await tx.execute(sql`select set_config(${name}, ${value}, true)`);
}

/** Run `work` as the app role and return the error it raised, or `undefined` when it did not. */
async function attempted(work: (tx: AppRoleExecutor) => Promise<unknown>): Promise<unknown> {
  try {
    await asAppRole(harness, work);
    return undefined;
  } catch (error) {
    return error;
  }
}

/** A slug no other run or test can collide with. */
function probeSlug(label: string): string {
  return `rls-write-${label}-${randomUUID().slice(0, 8)}`;
}

/** One page row, as the bypassing connection sees it. */
async function storedPage(slug: string): Promise<{ stackId: string; title: string } | undefined> {
  const rows = await onHarness<{ stack_id: string; title: string }>(
    sql`select stack_id, title from wiki.pages where slug = ${slug}`,
  );
  const row = rows[0];
  return row === undefined ? undefined : { stackId: row.stack_id, title: row.title };
}

/** A Stack's stored name, as the bypassing connection sees it. */
async function storedStackName(id: string): Promise<string | undefined> {
  const rows = await onHarness<{ name: string }>(
    sql`select name from public.stacks where id = ${id}::uuid`,
  );
  return rows[0]?.name;
}

/** Insert one own-tenant page as the app role, the write path this suite owns. */
async function ownPageInsert(slug: string): Promise<unknown> {
  return attempted((tx) =>
    bind(tx, "app.stack_id", stackId).then(() =>
      tx.execute(sql`
        insert into wiki.pages (stack_id, page_directory, slug, title)
        values (${stackId}::uuid, 'concepts', ${slug}, ${PROBE_TITLE})
      `),
    ),
  );
}

/** One new Stack row: the write where the row IS the tenant. */
function newStackRow(id: string, domain: string): SQL {
  return sql`insert into public.stacks (id, name, domain) values (${id}::uuid, ${PROBE_TITLE}, ${domain})`;
}

/** The derived set every generic loop below iterates, sorted by name. */
let RELATIONS: readonly TenantRelation[] = [];

/** A real Stack this suite never binds, so every "foreign" row is owned by a real tenant. */
const FOREIGN_STACK_ID = randomUUID();

/** Provision the foreign Stack on the bypassing connection, so no foreign key can explain a refusal. */
async function provisionForeignStack(): Promise<void> {
  const domain = `rls-write-foreign-${FOREIGN_STACK_ID.slice(0, 8)}`;
  await onHarness(sql`
    insert into public.stacks (id, name, domain)
    values (${FOREIGN_STACK_ID}::uuid, ${"rls-write-foreign"}, ${domain})
  `);
}

/**
 * Everything a case needs before it can assert: the application role, the derived population, a
 * foreign tenant.
 *
 * Never called without a database, because the harness has already decided that case and the
 * cases below are registered as skipped when there is none.
 */
async function prepare(): Promise<void> {
  await requireAppRole();
  await provisionForeignStack();
  RELATIONS = await readTenantRelations(onHarness);
}

if (reachable) await prepare();

afterAll(async () => {
  // Hygiene, not isolation: this process owns its database, and the delete cascades to every
  // row keyed by the stacks this file created. Ordered before the harness's own cleanup so
  // an error there cannot leave these rows for a re-provisioning run to read as its own.
  await db
    .execute(
      sql`delete from public.stacks
          where domain like ${'rls-write-foreign-%'} or domain like ${'rls-probe-%'}`,
    )
    .catch(() => undefined);
  await harness.cleanup();
});

it.skipIf(!reachable)("runs every assertion as a non-superuser role, not as the bypassing connection", async () => {
  // The OUTER connection must be capable of bypassing RLS. If it were not, the privilege drop
  // below would be decoration: an already-unprivileged harness would prove nothing by dropping.
  expect(await connectionBypassesRls(harness), "the harness connection must bypass RLS").toBe(true);

  const identity = await asAppRole(harness, (tx) =>
    tx.execute<{ role: string; is_super: boolean; bypasses: boolean }>(sql`
      select current_user as role,
             (select rolsuper from pg_roles where rolname = current_user) as is_super,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypasses
    `),
  );

  // The EFFECTIVE identity, read from the catalog INSIDE the transaction: issuing
  // `set local role` and trusting it is not evidence that the policy will run.
  expect(identity[0]?.role, "current_user inside the app-role transaction").toBe(APP_ROLE);
  expect(identity[0]?.is_super, `${APP_ROLE} must not be a superuser`).toBe(false);
  expect(identity[0]?.bypasses, `${APP_ROLE} must not bypass row-level security`).toBe(false);
}, 60_000);

it.skipIf(!reachable)("refuses a cross-tenant INSERT on every derived relation", async () => {
  for (const relation of RELATIONS) {
    const error = await attempted((tx) =>
      bind(tx, "app.stack_id", stackId).then(() =>
        tx.execute(insertOwnedBy(relation, FOREIGN_STACK_ID)),
      ),
    );
    expect(
      sqlStateOf(error),
      `${relation.identifier}: INSERT of a row owned by stack ${FOREIGN_STACK_ID} while ` +
        `app.stack_id = ${stackId} must be refused with ${POLICY_REFUSAL} — observed ${describeError(error)}`,
    ).toBe(POLICY_REFUSAL);
  }
}, 300_000);

it.skipIf(!reachable)("refuses an unbound INSERT on every derived relation, failing closed", async () => {
  for (const relation of RELATIONS) {
    // No binding at all: a fresh app-role transaction has `app.stack_id` NULL (measured), and
    // the policy's NULLIF turns both NULL and the empty string a RESET leaves into NULL, so
    // the predicate is NULL and the write is refused rather than allowed for every tenant.
    const error = await attempted((tx) => tx.execute(insertOwnedBy(relation, stackId)));
    expect(
      sqlStateOf(error),
      `${relation.identifier}: an unbound INSERT of an own-tenant row must fail closed with ` +
        `${POLICY_REFUSAL} — observed ${describeError(error)}`,
    ).toBe(POLICY_REFUSAL);
  }
}, 300_000);

it.skipIf(!reachable)("accepts an own-tenant page write, then refuses to hand that row to another tenant", async () => {
  const slug = probeSlug("update");
  const accepted = await ownPageInsert(slug);
  expect(
    sqlStateOf(accepted),
    `wiki.pages: own-tenant INSERT with app.stack_id = ${stackId} must be ACCEPTED — observed ${describeError(accepted)}`,
  ).toBeUndefined();
  expect(await storedPage(slug), `the page ${slug} must exist after the accepted insert`).toEqual({
    stackId,
    title: PROBE_TITLE,
  });

  const refused = await attempted((tx) =>
    bind(tx, "app.stack_id", stackId).then(() =>
      tx.execute(sql`
        update wiki.pages set stack_id = ${FOREIGN_STACK_ID}::uuid where slug = ${slug}
      `),
    ),
  );
  expect(
    sqlStateOf(refused),
    `wiki.pages: UPDATE moving ${slug} to stack ${FOREIGN_STACK_ID} while app.stack_id = ${stackId} ` +
      `must be refused with ${POLICY_REFUSAL} — observed ${describeError(refused)}`,
  ).toBe(POLICY_REFUSAL);
  expect((await storedPage(slug))?.stackId, "the refused UPDATE must not have moved the row").toBe(
    stackId,
  );
}, 120_000);

it.skipIf(!reachable)("fails closed on an unbound page UPDATE, leaving the stored row unchanged", async () => {
  const slug = probeSlug("unbound");
  expect(sqlStateOf(await ownPageInsert(slug)), "the seed write must be accepted").toBeUndefined();

  const changed = await asAppRole(harness, (tx) =>
    tx.execute(sql`
      update wiki.pages set title = ${MUTATED_TITLE} where slug = ${slug} returning slug
    `),
  );

  expect(
    changed,
    "an unbound UPDATE must reach no row, rather than raise an error that hides a write",
  ).toHaveLength(0);
  expect((await storedPage(slug))?.title, "the stored title must be unchanged").toBe(PROBE_TITLE);
}, 120_000);

it.skipIf(!reachable)("refuses a Stack INSERT bound only by app.stack_id, and accepts it when its domain is bound", async () => {
  const id = randomUUID();
  const domain = `rls-probe-${id.slice(0, 8)}`;

  const byIdOnly = await attempted((tx) =>
    bind(tx, "app.stack_id", stackId).then(() => tx.execute(newStackRow(id, domain))),
  );
  expect(
    sqlStateOf(byIdOnly),
    `public.stacks: INSERT of stack ${id} (domain ${domain}) with only app.stack_id = ${stackId} ` +
      `bound must be refused with ${POLICY_REFUSAL} — observed ${describeError(byIdOnly)}`,
  ).toBe(POLICY_REFUSAL);

  // The documented bootstrap path: creating a Stack is the one write where the row IS the
  // tenant, so `id = app.stack_id OR domain = app.stack_domain` can only be satisfied by the
  // domain half. Measured: the same insert is ACCEPTED once app.stack_domain names it.
  const byDomain = await attempted((tx) =>
    bind(tx, "app.stack_domain", domain).then(() => tx.execute(newStackRow(id, domain))),
  );
  expect(
    sqlStateOf(byDomain),
    `public.stacks: the same INSERT with app.stack_domain = ${domain} bound must be ACCEPTED, ` +
      `which is what makes creating a Stack possible — observed ${describeError(byDomain)}`,
  ).toBeUndefined();
  expect(await storedStackName(id), `stack ${id} must exist after the accepted insert`).toBe(
    PROBE_TITLE,
  );
}, 120_000);

it.skipIf(!reachable)("refuses a cross-tenant UPDATE on public.stacks", async () => {
  const before = await storedStackName(stackId);
  const refused = await attempted((tx) =>
    bind(tx, "app.stack_id", stackId).then(() =>
      tx.execute(sql`
        update public.stacks set id = ${FOREIGN_STACK_ID}::uuid where id = ${stackId}::uuid
      `),
    ),
  );
  expect(
    sqlStateOf(refused),
    `public.stacks: UPDATE re-pointing stack ${stackId} to id ${FOREIGN_STACK_ID} while ` +
      `app.stack_id = ${stackId} must be refused with ${POLICY_REFUSAL} — observed ${describeError(refused)}`,
  ).toBe(POLICY_REFUSAL);
  expect(
    await storedStackName(stackId),
    "the harness stack must still exist under its own id",
  ).toBe(before);
}, 120_000);

it.skipIf(!reachable)("fails closed on an unbound UPDATE of a Stack, leaving the stored name unchanged", async () => {
  const before = await storedStackName(stackId);
  expect(before, `the harness stack ${stackId} must be stored`).toBeDefined();

  const changed = await asAppRole(harness, (tx) =>
    tx.execute(sql`
      update public.stacks set name = ${MUTATED_TITLE} where id = ${stackId}::uuid returning id
    `),
  );

  expect(changed, "an unbound UPDATE of public.stacks must reach no row").toHaveLength(0);
  expect(await storedStackName(stackId), "the stored Stack name must be unchanged").toBe(before);
}, 120_000);
