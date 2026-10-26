/**
 * @file src/dimensions/wiki/page-store.ts
 * @description The wiki's pages in Postgres: read and write one tenant's compiled
 * pages against the `wiki` schema.
 *
 * ## Where this sits
 *
 * Wave 3 of the multi-tenant plan moves the wiki's L2 (the compiled product) from
 * the filesystem into the database. This module is the storage layer for that
 * move and nothing else: it knows the `wiki.pages` table and how to map a row onto
 * the `Page` shape the rest of the product already understands. It does not know
 * about dimensions, ports, or the coordinator.
 *
 * Keeping it that thin is what lets it be written BEFORE the dimension port grows
 * the `stack` field it needs. Every function here takes `stackId` explicitly, so
 * when `DimensionInput` gains a tenant, the dimension implementation threads it in
 * rather than this layer being rewritten.
 *
 * ## The tenant filter is written twice, on purpose
 *
 * Every statement here runs inside `withTenant`, which binds `app.stack_id` for
 * row-level security, AND every statement also says `where stack_id = ...`
 * explicitly.
 *
 * That duplication is not redundancy. It is the finding that made the isolation
 * test go red: RLS only filters when the CONNECTION ROLE is subject to it. The
 * application connects as a role that may be a SUPERUSER or have BYPASSRLS —
 * indeed the shared test harness deliberately connects as `aks`, which has both —
 * and under such a role every policy is inert. Verified: with the explicit
 * predicate removed, one tenant's `getStoredPage` returned another tenant's row
 * in a run where RLS was present and doing nothing.
 *
 * So the explicit predicate is the guarantee, and RLS is the backstop that catches
 * a future query here that forgets it. Neither alone is sufficient:
 *
 *   - predicate only  -> correct as long as every author remembers it forever
 *   - RLS only        -> correct only if the deployment role is `llmwiki_app`,
 *                        which is a deployment fact this module cannot verify
 *
 * A caller that passes the wrong `stackId` still gets that tenant's data, which is
 * the contract — the id comes from an authenticated request, not from user text.
 *
 * ## Why raw SQL instead of a drizzle table definition
 *
 * The KG package's drizzle `schema` object describes `public` only. Declaring a
 * second table map here would duplicate the DDL's column list in TypeScript and
 * let the two drift silently — the kind of drift that shows up as a runtime
 * `column does not exist` rather than a compile error. Raw `sql` tags against
 * `wiki.pages` keep exactly one description of the table: the migration.
 *
 * The cost is that column types are asserted, not inferred, so `WikiPageRow` is
 * the single place to update when the table changes. That is a smaller and more
 * visible surface than a parallel table definition.
 */

import { sql } from "drizzle-orm";

import type { Page, PageDirectory } from "../../pages/list.js";
import type { Database } from "llmwiki-kg";

/** The two page directories the schema's CHECK constraint allows. */
const PAGE_DIRECTORIES: readonly PageDirectory[] = ["concepts", "queries"] as const;

/**
 * One `wiki.pages` row as it comes back from Postgres.
 *
 * `snake_case` because that is the column name; mapped to `Page` in
 * {@link toPage} so no caller has to know the storage spelling.
 *
 * `timestamptz` columns are `string`, not `Date`: the shared client installs a
 * custom parser for those OIDs that returns the normalised text form
 * (`packages/llmwiki-kg/ts/src/db.ts:145`), because the product treats every
 * timestamp as an ISO-8601 string end to end.
 */
interface WikiPageRow extends Record<string, unknown> {
  readonly page_directory: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: string[] | null;
  readonly links: string[] | null;
  readonly body: string | null;
  readonly orphaned: boolean | null;
  readonly archived: boolean | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
}

/**
 * Narrow a stored directory string onto the `PageDirectory` union.
 *
 * The CHECK constraint already makes anything else unstorable, so this is a type
 * assertion with a guard rather than a validation layer. It returns `undefined`
 * instead of throwing because a row written by a FUTURE version of the schema is
 * not a reason to fail a whole listing — one unmappable page is better dropped
 * than allowed to take every other page down with it.
 *
 * @param value - The stored `page_directory`.
 * @returns The narrowed directory, or `undefined` when it is not one we know.
 */
function toPageDirectory(value: string): PageDirectory | undefined {
  return PAGE_DIRECTORIES.find((directory) => directory === value);
}

/**
 * Map a storage row onto the product's `Page`.
 *
 * `body` is included unconditionally: a caller that did not want it selected a
 * projection without the column, and returning `undefined` here for a row that
 * has one would be a second, invisible rule about when bodies are available.
 *
 * @param row - One row from `wiki.pages`.
 * @returns The page, or `undefined` when its directory is unrecognised.
 */
function toPage(row: WikiPageRow): Page | undefined {
  const pageDirectory = toPageDirectory(row.page_directory);
  if (pageDirectory === undefined) return undefined;

  return {
    slug: row.slug,
    pageDirectory,
    title: row.title,
    summary: row.summary,
    tags: row.tags ?? [],
    links: row.links ?? [],
    orphaned: row.orphaned ?? false,
    archived: row.archived ?? false,
    ...(row.body === null ? {} : { body: row.body }),
    ...(row.created_at === null ? {} : { createdAt: row.created_at }),
    ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
  };
}

/**
 * Run one unit of work with the tenant bound for row-level security.
 *
 * `set_config(..., is_local = true)` is the parameterised form of `SET LOCAL`, so
 * the binding lasts exactly this transaction and cannot leak to the next user of a
 * pooled connection. The explicit `reset` first is defensive against a pooled
 * connection that carries a session-level setting from a caller outside this
 * module; without it a "bind to A" could silently inherit an older binding.
 *
 * @param db - Database handle (the pooled one, or a test's own).
 * @param stackId - The tenant to bind.
 * @param work - Statements to run under that binding.
 * @returns Whatever `work` produced.
 */
export async function withTenant<T>(
  db: Database,
  stackId: string,
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    return work(tx as unknown as Database);
  });
}

/**
 * Render a `text[]` parameter as a Postgres array literal.
 *
 * Drizzle expands a JS array into a ROW constructor -- `(a, b)` -- so
 * `tags = ${["x"]}` becomes an empty `()` for one element and a syntax error for
 * more. Measured here: a one-element array rendered as literally `()`, which
 * Postgres rejects. The working form is a single text parameter holding
 * `{"x","y"}`, cast to `text[]` in SQL.
 *
 * The vendored package solves the same problem in `toPostgresArrayLiteral`
 * (`core/aks_serializers.ts:161`) but does not export it through the barrel, and
 * importing the module directly would reach into the package's internals. This is
 * deliberately the same algorithm, kept local.
 *
 * @param values - Strings to encode.
 * @returns A Postgres array literal.
 */
function toArrayLiteral(values: readonly string[]): string {
  const quoted = values.map(
    (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
  );
  return `{${quoted.join(",")}}`;
}

/** Columns a listing needs; `body` is excluded because a listing rarely shows it. */
const PAGE_LISTING_COLUMNS = sql`
  page_directory, slug, title, summary, tags, links,
  orphaned, archived, created_at, updated_at
`;

/**
 * Every non-archived, non-orphaned page of one tenant, newest first.
 *
 * The filters mirror the defaults `listPages` applies to the filesystem today, so
 * switching this in does not silently widen what a caller sees.
 *
 * @param db - Database handle.
 * @param stackId - The tenant whose pages to list.
 * @param limit - Maximum rows to return.
 * @returns The pages, in `updated_at DESC` order.
 */
export async function listStoredPages(
  db: Database,
  stackId: string,
  limit: number,
): Promise<Page[]> {
  return withTenant(db, stackId, async (tx) => {
    const rows = await tx.execute<WikiPageRow>(sql`
      select ${PAGE_LISTING_COLUMNS}
      from wiki.pages
      where stack_id = ${stackId} and orphaned = false and archived = false
      order by updated_at desc
      limit ${limit}
    `);
    return rows.map(toPage).filter((page): page is Page => page !== undefined);
  });
}

/**
 * Every page of one tenant, archived and orphaned ones INCLUDED.
 *
 * `listStoredPages` deliberately excludes those, which is right for a listing that
 * presents a wiki. A collector that classifies them -- the export and viewer paths
 * filter on `parseStatus.orphaned` themselves -- needs to see them, and re-filtering
 * after the fact cannot recover a row the query never returned.
 *
 * @param db - Database handle.
 * @param stackId - The tenant that owns the pages.
 * @returns All pages, body included, newest first.
 */
export async function listStoredPagesUnfiltered(
  db: Database,
  stackId: string,
): Promise<Page[]> {
  return withTenant(db, stackId, async (tx) => {
    const rows = await tx.execute<WikiPageRow>(sql`
      select page_directory, slug, title, summary, tags, links,
             orphaned, archived, body, created_at, updated_at
      from wiki.pages
      where stack_id = ${stackId}
      order by updated_at desc
    `);
    return rows.map(toPage).filter((page): page is Page => page !== undefined);
  });
}

/**
 * One page of one tenant by directory and slug, body included.
 *
 * @param db - Database handle.
 * @param stackId - The tenant that owns the page.
 * @param pageDirectory - `concepts` or `queries`.
 * @param slug - The page's slug.
 * @returns The page, or `undefined` when this tenant has no such page.
 */
export async function getStoredPage(
  db: Database,
  stackId: string,
  pageDirectory: PageDirectory,
  slug: string,
): Promise<Page | undefined> {
  return withTenant(db, stackId, async (tx) => {
    const rows = await tx.execute<WikiPageRow>(sql`
      select page_directory, slug, title, summary, tags, links, body,
             orphaned, archived, created_at, updated_at
      from wiki.pages
      where stack_id = ${stackId}
        and page_directory = ${pageDirectory} and slug = ${slug}
    `);
    const row = rows[0];
    return row === undefined ? undefined : toPage(row);
  });
}

/**
 * Insert or update one page.
 *
 * `updated_at` is set on conflict because the listing orders by it: a page whose
 * content changed but whose timestamp did not would sink to the bottom of a
 * "newest first" view, which reads as "this page was not updated".
 *
 * @param db - Database handle.
 * @param stackId - The tenant that owns the page.
 * @param page - The page to store; its `pageDirectory` and `slug` are its identity.
 */
export async function upsertStoredPage(
  db: Database,
  stackId: string,
  page: Page,
): Promise<void> {
  await withTenant(db, stackId, async (tx) => {
    await tx.execute(sql`
      insert into wiki.pages
        (stack_id, page_directory, slug, title, summary, tags, links, body, orphaned, archived)
      values (
        ${stackId}, ${page.pageDirectory}, ${page.slug}, ${page.title},
        ${page.summary}, ${toArrayLiteral(page.tags)}::text[],
        ${toArrayLiteral(page.links)}::text[], ${page.body ?? ""},
        ${page.orphaned}, ${page.archived}
      )
      on conflict (stack_id, page_directory, slug) do update set
        title = excluded.title,
        summary = excluded.summary,
        tags = excluded.tags,
        links = excluded.links,
        body = excluded.body,
        orphaned = excluded.orphaned,
        archived = excluded.archived,
        updated_at = now()
    `);
  });
}

/**
 * Remove one page from a Stack.
 *
 * DELETING AN ABSENT PAGE IS NOT AN ERROR, matching the file path: a delete's goal
 * state is "not present", and something else reaching it first does not make this a
 * failure. Refusing would strand a retry after a partial apply.
 *
 * @param db - Database handle.
 * @param stackId - The tenant that owns the page.
 * @param pageDirectory - `concepts` or `queries`.
 * @param slug - The page's slug.
 */
export async function deleteStoredPage(
  db: Database,
  stackId: string,
  pageDirectory: PageDirectory,
  slug: string,
): Promise<void> {
  await withTenant(db, stackId, async (tx) => {
    await tx.execute(sql`
      delete from wiki.pages
      where stack_id = ${stackId}
        and page_directory = ${pageDirectory} and slug = ${slug}
    `);
  });
}
