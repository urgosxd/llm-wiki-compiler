/**
 * @file test/dimensions/wiki-store-dimension.test.ts
 * @description The database-backed wiki dimension (W3.2), asserting the three
 * protections `saveSource` carries so that moving to the database does not quietly
 * lose them.
 *
 * WHY THESE THREE, AND WHY AGAINST A REAL DATABASE. Each rule exists because
 * breaking it produced a real bug on the filesystem: an empty slug wrote
 * `sources/.md`; two sources sharing a title overwrote each other; a renamed title
 * forked a duplicate page. A unit test with a fake store would assert that this
 * module calls an upsert — it could not show that the SECOND source with the same
 * title ends up on a different slug, which is the property that matters.
 *
 * The suite skips loudly when the schema or database is absent rather than passing
 * vacuously.
 */
import { afterAll, describe, expect, it } from "vitest";

import { createWikiStoreDimension } from "../../src/dimensions/wiki/store-dimension.js";
import { listStoredPages } from "../../src/dimensions/wiki/page-store.js";
import type { DimensionInput } from "../../src/dimensions/types.js";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";

const harness = await createKgPostgresHarness("wiki-store-dim");
const other = await createKgPostgresHarness("wiki-store-dim-other");

const provisioned = await (async (): Promise<boolean> => {
  if (!harness.reachable) return false;
  try {
    const rows = await harness.db.execute<{ n: number }>(
      "select count(*)::int as n from information_schema.columns where table_schema='wiki' and table_name='pages'",
    );
    return ((rows[0] as { n: number } | undefined)?.n ?? 0) > 0;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await harness.cleanup();
  await other.cleanup();
});

/** An ingest input with the fields the dimension reads. */
function inputOf(title: string, source: string, body = `body for ${title}`): DimensionInput {
  return { source, title, document: `---\ntitle: ${title}\n---\n${body}`, body };
}

/** The dimension under test, bound to the primary tenant. */
function dimension() {
  return createWikiStoreDimension({ stackId: harness.stackId, db: harness.db });
}

/** Prepare then commit, the way the coordinator drives a dimension. */
async function write(dim: ReturnType<typeof dimension>, input: DimensionInput) {
  const prepared = await dim.prepare(input);
  return dim.commit(prepared);
}

describe("the stored wiki dimension", () => {
  it.skipIf(!provisioned)("writes a page and reports created", async () => {
    const committed = await write(dimension(), inputOf("Stored One", "src://one"));
    expect(committed.writeStatus).toBe("created");
    const pages = await listStoredPages(harness.db, harness.stackId, 50);
    expect(pages.map((page) => page.slug)).toContain("stored-one");
  }, 30_000);

  it.skipIf(!provisioned)("refuses a title with no letters or digits", async () => {
    // The empty-slug guard: without it the page lands under a slug no reader lists.
    await expect(write(dimension(), inputOf("!!!", "src://punct"))).rejects.toThrow(
      /no letter or number characters/,
    );
  }, 30_000);

  it.skipIf(!provisioned)("suffixes a second source that shares a title", async () => {
    // Basename-collision suffixing: two sources, one title, two pages.
    await write(dimension(), inputOf("Shared Title", "src://first"));
    await write(dimension(), inputOf("Shared Title", "src://second"));
    const slugs = (await listStoredPages(harness.db, harness.stackId, 200)).map((page) => page.slug);
    expect(slugs).toContain("shared-title");
    expect(slugs).toContain("shared-title-1");
  }, 30_000);

  it.skipIf(!provisioned)("updates in place when the same source is re-ingested under a new title", async () => {
    // Source identity is the key, not the slug: a rename must not fork.
    await write(dimension(), inputOf("Original Name", "src://renamed"));
    const committed = await write(dimension(), inputOf("New Name", "src://renamed"));
    expect(committed.writeStatus).toBe("updated");
    const pages = await listStoredPages(harness.db, harness.stackId, 200);
    const forSource = pages.filter((page) => page.slug === "original-name" || page.slug === "new-name");
    expect(forSource).toHaveLength(1);
    expect(forSource[0]?.title).toBe("New Name");
  }, 30_000);

  it.skipIf(!provisioned)("reports unchanged without writing when content is identical", async () => {
    await write(dimension(), inputOf("Idempotent", "src://idem"));
    const again = await write(dimension(), inputOf("Idempotent", "src://idem"));
    expect(again.writeStatus).toBe("unchanged");
  }, 30_000);

  it.skipIf(!provisioned)("does not write into another tenant", async () => {
    const theirs = createWikiStoreDimension({ stackId: other.stackId, db: other.db });
    await write(theirs, inputOf("Theirs Only", "src://theirs"));
    const mine = (await listStoredPages(harness.db, harness.stackId, 200)).map((page) => page.slug);
    expect(mine).not.toContain("theirs-only");
  }, 30_000);

  it.skipIf(!provisioned)("forget is a no-op, leaving the page to the orphan rules", async () => {
    // Deliberate: `compile` owns wiki removal via orphan marking. Deleting here
    // would be a second, disagreeing answer.
    await write(dimension(), inputOf("Forgotten", "src://forget"));
    await dimension().forget({ source: "src://forget" });
    const slugs = (await listStoredPages(harness.db, harness.stackId, 200)).map((page) => page.slug);
    expect(slugs).toContain("forgotten");
  }, 30_000);
});
