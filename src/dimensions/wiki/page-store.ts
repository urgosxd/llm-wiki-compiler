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
import type { Database } from "@repo/kg";
import { toArrayLiteral } from "./sql-array.js";
import { stringList } from "./page-string-list.js";

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
  readonly aliases: unknown;
  readonly attribution_gaps: unknown;
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
    // A per-page fact stored as a `jsonb` array, so a page that survived a round trip
    // through these columns answers with the same aliases and attribution gaps the
    // file path reads out of its frontmatter (S2, S5).
    aliases: stringList(row.aliases),
    attributionGaps: stringList(row.attribution_gaps),
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
 * ## The `callerTx` parameter, and why it is not optional sugar
 *
 * Atomic ingest needs the wiki's row writes and the graph's row writes in ONE
 * transaction. Opening a nested `db.transaction` here would break that: drizzle's
 * pool hands the inner call a DIFFERENT connection, so the inner writes commit
 * separately and a later failure leaves half the ingest visible. Measured in
 * `test/dimensions/kg-runtime-savepoint-binding.test.ts`, which exists because a
 * first attempt reached the opposite conclusion by measuring exactly that mistake.
 *
 * So when the coordinator supplies a handle, the statements run on IT. The tenant
 * is still bound here rather than by the caller: this module owns the rule that a
 * tenanted statement must run bound, and moving the bind out would make it
 * forgettable at every call site.
 *
 * With no handle the behaviour is unchanged -- `db.transaction` opens the scope.
 *
 * @param db - Database handle (the pooled one, or a test's own).
 * @param stackId - The tenant to bind.
 * @param work - Statements to run under that binding.
 * @param callerTx - Ambient transaction to join, when the coordinator owns one.
 * @returns Whatever `work` produced.
 */
export async function withTenant<T>(
  db: Database,
  stackId: string,
  work: (tx: Database) => Promise<T>,
  callerTx?: Database,
): Promise<T> {
  if (callerTx !== undefined) {
    await callerTx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    return work(callerTx);
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    return work(tx as unknown as Database);
  });
}


/**
 * Render a per-page string list as the `jsonb` literal the column stores.
 *
 * One parameter holding JSON text rather than a drizzle array: drizzle expands a JS
 * array into a ROW constructor, which is neither a `jsonb` value nor valid for more
 * than one element (`sql-array.ts` documents the same defect for `text[]`).
 *
 * @param values - The list to store; absent means the empty list the column defaults to.
 * @returns A JSON array literal, safe to cast to `jsonb`.
 */
function toJsonbLiteral(values: readonly string[] | undefined): string {
  return JSON.stringify(values ?? []);
}

/**
 * Columns a listing needs; `body` is excluded because a listing rarely shows it.
 *
 * `aliases` and `attribution_gaps` ARE included: they are page facts a reader of a
 * listing must be able to answer for (an alias resolves to its page), and a projection
 * that dropped them would make every listed page report as carrying none.
 */
const PAGE_LISTING_COLUMNS = sql`
  page_directory, slug, title, summary, tags, links,
  orphaned, archived, aliases, attribution_gaps, created_at, updated_at
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
             orphaned, archived, body, aliases, attribution_gaps, created_at, updated_at
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
             orphaned, archived, aliases, attribution_gaps, created_at, updated_at
      from wiki.pages
      where stack_id = ${stackId}
        and page_directory = ${pageDirectory} and slug = ${slug}
    `);
    const row = rows[0];
    return row === undefined ? undefined : toPage(row);
  });
}

/** One page identity as the caller asks for it, before it is narrowed to a directory. */
export interface StoredPageKey {
  readonly pageDirectory: PageDirectory;
  readonly slug: string;
}

/**
 * Many pages of one tenant in ONE round trip, body included.
 *
 * ## Why this is not `getStoredPage` in a loop
 *
 * `getStoredPage` opens its own `withTenant` transaction, so N pages cost N
 * transactions plus N `set_config` calls. Measured on 90 candidates against a real
 * Stack: ~3.5ms each, ~316ms total, against ~4ms for the single query below. The
 * retrieval freshness walk asks for exactly this shape (a ranked candidate batch),
 * and paying a transaction per candidate made freshness look like an
 * architectural limit when it was an adapter defect.
 *
 * ## Why `unnest` instead of an `IN` list
 *
 * Two parallel arrays keep the query at one parameter pair regardless of batch
 * size, so there is no bind-parameter ceiling or literal-length cliff to chunck
 * around. It also keeps the identity pair explicit: `(page_directory, slug)` is
 * the primary key, and a slug alone is not unique across directories.
 *
 * An orphaned or archived page is still returned. This reader's contract is "the
 * rows that exist": the callers that exclude those apply their own rule, and a
 * pre-filtered batch could not recover a row it never returned.
 *
 * @param db - Database handle.
 * @param stackId - The tenant that owns the pages.
 * @param keys - Identities to fetch; duplicates collapse to one row each.
 * @returns A map from `directory/slug` to page, for the identities that exist.
 */
export async function getStoredPagesByKey(
  db: Database,
  stackId: string,
  keys: readonly StoredPageKey[],
): Promise<Map<string, Page>> {
  const pages = new Map<string, Page>();
  if (keys.length === 0) return pages;

  const directories = keys.map((key) => key.pageDirectory);
  const slugs = keys.map((key) => key.slug);
  const rows = await withTenant(db, stackId, async (tx) =>
    tx.execute<WikiPageRow>(sql`
      select page_directory, slug, title, summary, tags, links, body,
             orphaned, archived, aliases, attribution_gaps, created_at, updated_at
      from wiki.pages
      where stack_id = ${stackId}
        and (page_directory, slug) in (
          select unnest(${toArrayLiteral(directories)}::text[]),
                 unnest(${toArrayLiteral(slugs)}::text[])
        )
    `),
  );

  for (const row of rows) {
    const page = toPage(row);
    if (page !== undefined) pages.set(`${page.pageDirectory}/${page.slug}`, page);
  }
  return pages;
}

/**
 * Insert or update one page.
 *
 * `updated_at` is set on conflict because the listing orders by it: a page whose
 * content changed but whose timestamp did not would sink to the bottom of a
 * "newest first" view, which reads as "this page was not updated".
 *
 * THE `callerTx` PARAMETER IS WHAT MAKES A BATCH ATOMIC. Without it each page opens
 * its own transaction, so a batch of five pages is five commits and a failure on the
 * fifth leaves the first four durable. `withTenant` accepts a caller's transaction
 * for exactly this reason (see its docstring: a nested `db.transaction` gets a
 * DIFFERENT pooled connection, so the inner writes commit separately). It was
 * written for the ingest coordinator, which passes the shared `scope.tx` to every
 * dimension; the row page batch reuses it, with
 * `activePageBatchTransaction()` supplying the handle
 * (`src/dimensions/wiki/page-write-sink.ts:60-66`).
 *
 * @param db - Database handle.
 * @param stackId - The tenant that owns the page.
 * @param page - The page to store; its `pageDirectory` and `slug` are its identity.
 * @param callerTx - Batch transaction to join, when the caller owns one.
 */
export async function upsertStoredPage(
  db: Database,
  stackId: string,
  page: Page,
  callerTx?: Database,
): Promise<void> {
  await withTenant(db, stackId, async (tx) => {
    await tx.execute(sql`
      insert into wiki.pages
        (stack_id, page_directory, slug, title, summary, tags, links, body, orphaned, archived,
         aliases, attribution_gaps)
      values (
        ${stackId}, ${page.pageDirectory}, ${page.slug}, ${page.title},
        ${page.summary}, ${toArrayLiteral(page.tags)}::text[],
        ${toArrayLiteral(page.links)}::text[], ${page.body ?? ""},
        ${page.orphaned}, ${page.archived},
        ${toJsonbLiteral(page.aliases)}::jsonb, ${toJsonbLiteral(page.attributionGaps)}::jsonb
      )
      on conflict (stack_id, page_directory, slug) do update set
        title = excluded.title,
        summary = excluded.summary,
        tags = excluded.tags,
        links = excluded.links,
        body = excluded.body,
        orphaned = excluded.orphaned,
        archived = excluded.archived,
        -- Overwritten, not preserved: the row mirrors the page that was rendered, and a
        -- page written without these fields is a page that no longer declares them --
        -- exactly what rewriting a file without them does on the file path.
        aliases = excluded.aliases,
        attribution_gaps = excluded.attribution_gaps,
        updated_at = now()
    `);
  }, callerTx);
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
 * @param callerTx - Batch transaction to join, when the caller owns one.
 */
export async function deleteStoredPage(
  db: Database,
  stackId: string,
  pageDirectory: PageDirectory,
  slug: string,
  callerTx?: Database,
): Promise<void> {
  await withTenant(db, stackId, async (tx) => {
    await tx.execute(sql`
      delete from wiki.pages
      where stack_id = ${stackId}
        and page_directory = ${pageDirectory} and slug = ${slug}
    `);
  }, callerTx);
}
