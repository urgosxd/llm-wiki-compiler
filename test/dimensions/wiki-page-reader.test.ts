/**
 * @file test/dimensions/wiki-page-reader.test.ts
 * @description The database-backed wiki reader: does it answer the SAME questions
 * the filesystem reader answers, and only for its own tenant?
 *
 * WHY THIS IS NOT A UNIT TEST OF MAPPING. W3.4 requires the file-backed
 * implementation to stay selectable behind the same port, and that requirement is
 * only meaningful if the two backends are interchangeable. So the assertions here
 * are about the CONTRACT -- same entity shape, same `not_found` for a missing
 * name, same empty relationships -- rather than about this module's internals.
 *
 * Isolation is asserted against a real second tenant for the reason recorded in
 * `page-store.ts`: RLS alone was inert under the harness's role, so only a real
 * cross-tenant read proves the filter is there.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { createWikiPageReader } from "../../src/dimensions/wiki/database.js";
import { upsertStoredPage } from "../../src/dimensions/wiki/page-store.js";
import type { Page } from "../../src/pages/list.js";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";

const harness = await createKgPostgresHarness(`wiki-reader-${randomUUID().slice(0, 8)}`);
const other = await createKgPostgresHarness(`wiki-reader-other-${randomUUID().slice(0, 8)}`);

const provisioned = await (async (): Promise<boolean> => {
  if (!harness.reachable) return false;
  try {
    const rows = await harness.db.execute<{ n: number }>(
      // Ask for the tables the suite actually uses rather than a total. Counting every
      // table in the schema made this probe silently disable 15 tests the moment an
      // unrelated wiki table was added -- a skip is silent, so the guard has to be
      // about presence, never about a total that other work can change.
      "select count(*)::int as n from information_schema.tables where table_schema = 'wiki' and table_name in ('pages', 'concept_aliases')",
    );
    return (rows[0] as { n: number } | undefined)?.n === 2 /* both required tables present */;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await harness.cleanup();
  await other.cleanup();
});

/** A minimal page fixture. */
function pageOf(slug: string, overrides: Partial<Page> = {}): Page {
  return {
    slug,
    pageDirectory: "concepts",
    title: `Title ${slug}`,
    summary: `summary about ${slug}`,
    tags: [],
    links: [],
    orphaned: false,
    archived: false,
    body: `body ${slug}`,
    ...overrides,
  };
}

describe("the database-backed wiki reader", () => {
  it.skipIf(!provisioned)("lists pages as dimension entities", async () => {
    await upsertStoredPage(harness.db, harness.stackId, pageOf("listed"));
    const reader = createWikiPageReader({ stackId: harness.stackId, db: harness.db });
    const result = await reader.read({ limit: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entity = result.value.entities.find((item) => item.id === "listed");
    expect(entity).toEqual({
      id: "listed",
      name: "Title listed",
      kind: "concepts",
      description: "summary about listed",
    });
  }, 30_000);

  it.skipIf(!provisioned)("reports an unknown name as not_found", async () => {
    const reader = createWikiPageReader({ stackId: harness.stackId, db: harness.db });
    const result = await reader.read({ name: "nothing-like-this" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_found");
  }, 30_000);

  it.skipIf(!provisioned)("finds a page by exact title, then by substring", async () => {
    await upsertStoredPage(harness.db, harness.stackId, pageOf("vector-db", { title: "Vector DB" }));
    const reader = createWikiPageReader({ stackId: harness.stackId, db: harness.db });
    const exact = await reader.read({ name: "Vector DB" });
    expect(exact.ok && exact.value.entities[0]?.id).toBe("vector-db");
    const partial = await reader.read({ name: "vector" });
    expect(partial.ok && partial.value.entities[0]?.id).toBe("vector-db");
  }, 30_000);

  it.skipIf(!provisioned)("never invents relationships it cannot back", async () => {
    const reader = createWikiPageReader({ stackId: harness.stackId, db: harness.db });
    const result = await reader.read({ limit: 10 });
    expect(result.ok && result.value.relationships).toEqual([]);
  }, 30_000);

  it.skipIf(!provisioned)("does not see another tenant's page", async () => {
    await upsertStoredPage(other.db, other.stackId, pageOf("theirs", { title: "Theirs" }));
    const reader = createWikiPageReader({ stackId: harness.stackId, db: harness.db });
    const byName = await reader.read({ name: "Theirs" });
    expect(byName.ok).toBe(false);
    const listing = await reader.read({ limit: 200 });
    const ids = listing.ok ? listing.value.entities.map((entity) => entity.id) : [];
    expect(ids).not.toContain("theirs");
  }, 30_000);

  it.skipIf(!provisioned)("restricts to the requested kinds", async () => {
    await upsertStoredPage(harness.db, harness.stackId, pageOf("a-query", {
      pageDirectory: "queries",
      title: "A Query",
    }));
    const reader = createWikiPageReader({ stackId: harness.stackId, db: harness.db });
    const result = await reader.read({ kinds: ["queries"], limit: 50 });
    const kinds = result.ok ? result.value.entities.map((entity) => entity.kind) : [];
    expect(kinds.every((kind) => kind === "queries")).toBe(true);
  }, 30_000);

  it.skipIf(!provisioned)("says unavailable for text search rather than nothing matched", async () => {
    // The honest answer matters: an empty result would read as "no matches".
    const reader = createWikiPageReader({ stackId: harness.stackId, db: harness.db });
    const result = await reader.read({ text: "anything" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unavailable");
  }, 30_000);
});
