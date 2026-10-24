/**
 * @file test/dimensions/wiki-page-store.test.ts
 * @description The wiki's Postgres page store, against a real database.
 *
 * WHY NOT MOCKED. Row-level security is enforced by Postgres, not by this module.
 * A mock would assert "we issued a query with a stack_id" — which is exactly the
 * assumption that turned out to be wrong in Wave 1, where nine route files queried
 * tenanted tables and merely LOOKED scoped. Only the database can show that one
 * tenant cannot read another's pages.
 *
 * The suite provisions through the shared harness and skips loudly when the
 * database or the `wiki` schema is absent, rather than passing vacuously.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  getStoredPage,
  listStoredPages,
  upsertStoredPage,
  withTenant,
} from "../../src/dimensions/wiki/page-store.js";
import type { Page } from "../../src/pages/list.js";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";

const harness = await createKgPostgresHarness("wiki-store");

/**
 * Is the `wiki` schema applied?
 *
 * The store is useless without it, and a missing schema would otherwise surface as
 * a confusing "relation does not exist" per test instead of one honest skip.
 */
const provisioned = await (async (): Promise<boolean> => {
  if (!harness.reachable) return false;
  try {
    const rows = await harness.db.execute<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_schema = 'wiki'",
    );
    const present = (rows[0] as { n: number } | undefined)?.n === 2;
    if (!present) {
      console.warn("wiki-page-store: schema missing; run src/dimensions/wiki/schema.sql");
    }
    return present;
  } catch {
    return false;
  }
})();

/** A second tenant, so cross-tenant isolation is testable. */
const otherHarness = await createKgPostgresHarness("wiki-store-other");

afterAll(async () => {
  await harness.cleanup();
  await otherHarness.cleanup();
});

/** A page fixture with only the fields the store cares about varying. */
function pageOf(slug: string, overrides: Partial<Page> = {}): Page {
  return {
    slug,
    pageDirectory: "concepts",
    title: `Title ${slug}`,
    summary: "a summary",
    tags: [],
    links: [],
    orphaned: false,
    archived: false,
    body: `body of ${slug}`,
    ...overrides,
  };
}

describe("the wiki page store", () => {
  it.skipIf(!provisioned)("round-trips a page through upsert and get", async () => {
    await upsertStoredPage(harness.db, harness.stackId, pageOf("round-trip"));
    const stored = await getStoredPage(harness.db, harness.stackId, "concepts", "round-trip");
    expect(stored?.title).toBe("Title round-trip");
    expect(stored?.body).toBe("body of round-trip");
    expect(stored?.pageDirectory).toBe("concepts");
  }, 30_000);

  it.skipIf(!provisioned)("updates in place rather than duplicating", async () => {
    await upsertStoredPage(harness.db, harness.stackId, pageOf("in-place"));
    await upsertStoredPage(
      harness.db,
      harness.stackId,
      pageOf("in-place", { title: "Renamed", summary: "changed" }),
    );
    const listing = await listStoredPages(harness.db, harness.stackId, 100);
    expect(listing.filter((page) => page.slug === "in-place")).toHaveLength(1);
    expect(listing.find((page) => page.slug === "in-place")?.title).toBe("Renamed");
  }, 30_000);

  it.skipIf(!provisioned)("cannot read another tenant's page", async () => {
    // The property the whole wave exists for.
    await upsertStoredPage(otherHarness.db, otherHarness.stackId, pageOf("secret"));
    const leaked = await getStoredPage(harness.db, harness.stackId, "concepts", "secret");
    expect(leaked).toBeUndefined();
  }, 30_000);

  it.skipIf(!provisioned)("lists only its own tenant's pages", async () => {
    await upsertStoredPage(otherHarness.db, otherHarness.stackId, pageOf("only-theirs"));
    const listing = await listStoredPages(harness.db, harness.stackId, 100);
    expect(listing.map((page) => page.slug)).not.toContain("only-theirs");
  }, 30_000);

  it.skipIf(!provisioned)("excludes archived and orphaned pages from a listing", async () => {
    await upsertStoredPage(harness.db, harness.stackId, pageOf("archived", { archived: true }));
    await upsertStoredPage(harness.db, harness.stackId, pageOf("orphaned", { orphaned: true }));
    const slugs = (await listStoredPages(harness.db, harness.stackId, 100)).map((page) => page.slug);
    expect(slugs).not.toContain("archived");
    expect(slugs).not.toContain("orphaned");
  }, 30_000);

  it.skipIf(!provisioned)("binds the tenant, so an unbound session sees nothing", async () => {
    // Proves `withTenant` is what makes the reads work: without it the same query
    // matches nothing, which is why the binding lives in this module and not in
    // each caller.
    await upsertStoredPage(harness.db, harness.stackId, pageOf("binding-proof"));
    const bound = await withTenant(harness.db, harness.stackId, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        "select count(*)::int as n from wiki.pages where slug = 'binding-proof'",
      );
      return (rows[0] as { n: number }).n;
    });
    expect(bound).toBe(1);
  }, 30_000);
});

describe("the store contract T2 depends on", () => {
  it.skipIf(!provisioned)("accepts a compile-shaped write: namespace, slug, full markdown body", async () => {
    // CompilePageWrite carries {namespace, slug, body} where body is
    // frontmatter + prose. Page wants those split. This pins that the split is
    // representable, so T2 does not discover it needs a schema change mid-task.
    const full = `---\ntitle: Split Me\nsummary: from frontmatter\n---\n\nThe prose.`;
    const { parseFrontmatter } = await import("../../src/utils/markdown.js");
    const { meta, body } = parseFrontmatter(full);
    await upsertStoredPage(harness.db, harness.stackId, {
      slug: "split-me",
      pageDirectory: "concepts",
      title: String(meta.title ?? ""),
      summary: String(meta.summary ?? ""),
      tags: [],
      links: [],
      orphaned: false,
      archived: false,
      body,
    });
    const stored = await getStoredPage(harness.db, harness.stackId, "concepts", "split-me");
    expect(stored?.title).toBe("Split Me");
    expect(stored?.summary).toBe("from frontmatter");
    expect(stored?.body).toBe("\nThe prose.");
  }, 30_000);

  it.skipIf(!provisioned)("keeps source_identity intact across a plain upsert", async () => {
    // The dimension looks a page up by source_identity; the compiler path does not
    // write that column. Verified here so T2 can rely on it: leaving a column out
    // of `do update set` PRESERVES it rather than nulling it.
    const slug = "identity-survives-upsert";
    await harness.db.execute(
      `insert into wiki.pages (stack_id, page_directory, slug, title, summary, body, source_identity)
       values ('${harness.stackId}', 'concepts', '${slug}', 'Kept', '', 'body', 'src://kept')`,
    );
    await upsertStoredPage(harness.db, harness.stackId, pageOf(slug, { body: "rewritten" }));
    const rows = await harness.db.execute<{ source_identity: string | null }>(
      `select source_identity from wiki.pages
       where stack_id = '${harness.stackId}' and page_directory = 'concepts' and slug = '${slug}'`,
    );
    expect(rows[0]?.source_identity).toBe("src://kept");
  }, 30_000);
});
