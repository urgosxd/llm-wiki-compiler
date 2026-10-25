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
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createWikiStoreDimension } from "../../src/dimensions/wiki/database.js";
import { listStoredPages } from "../../src/dimensions/wiki/page-store.js";
import type { DimensionInput } from "../../src/dimensions/types.js";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";

/**
 * A scratch project root for the L1 bridge.
 *
 * The dimension writes the raw markdown to `sources/` as well as the row, so it
 * needs a real directory. Created eagerly because the factory requires `root`.
 */
const bridgeRoot = await mkdtemp(path.join(tmpdir(), "wiki-store-bridge-"));

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
function dimension(root = bridgeRoot) {
  return createWikiStoreDimension({ stackId: harness.stackId, db: harness.db, root });
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
    const theirs = createWikiStoreDimension({
      stackId: other.stackId,
      db: other.db,
      root: bridgeRoot,
    });
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

describe("the L1 bridge that keeps ingest->compile alive", () => {
  it.skipIf(!provisioned)("returns artifactPath, because ingest throws without one", async () => {
    // services/ingest/service.ts:120 refuses an outcome with no artifactPath, so
    // a dimension that returned none would break EVERY ingest.
    const committed = await write(dimension(), inputOf("Bridge Artefact", "src://bridge-a"));
    expect(committed.artifactPath).toBeDefined();
    expect(committed.artifactPath?.endsWith(".md")).toBe(true);
  }, 30_000);

  it.skipIf(!provisioned)("actually writes the markdown under sources/", async () => {
    // compile discovers work by hashing sources/ (compiler/hasher.ts:34-43).
    // A row with no file is invisible to it, which is the silent death this
    // bridge exists to prevent.
    const committed = await write(dimension(), inputOf("Bridge On Disk", "src://bridge-b"));
    const text = await readFile(committed.artifactPath ?? "", "utf-8");
    expect(text).toContain("Bridge On Disk");
  }, 30_000);
});

describe("commit idempotency, which the port now REQUIRES", () => {
  // `reconcileOutbox` finishes a committed-but-unpaired ingest by replaying it,
  // so a second commit with the same input must not duplicate a row and must not
  // fork the slug. Measured with a probe before these assertions were written:
  // the second commit reports `unchanged` and the row count stays 1, because
  // `prepare` finds the page by `source_identity` and the insert is
  // `on conflict (stack_id, page_directory, slug) do update`.
  it.skipIf(!provisioned)("a second commit of the same input keeps one row and one slug", async () => {
    const dim = dimension(bridgeRoot);
    const input = inputOf("Idempotent Twice", "src://idem-twice");

    const first = await write(dim, input);
    const second = await write(dim, input);

    expect(first.writeStatus).toBe("created");
    // The second run finds the page by source identity, so it is a no-op rather
    // than an update or a new row.
    expect(second.writeStatus).toBe("unchanged");

    const pages = await listStoredPages(harness.db, harness.stackId, 200);
    const matching = pages.filter((page) => page.title === "Idempotent Twice");
    expect(matching).toHaveLength(1);
    // And no `-1` suffix: the slug did not fork.
    expect(matching[0]?.slug).toBe("idempotent-twice");
  }, 30_000);

  it.skipIf(!provisioned)("a replayed commit after forget does not duplicate the page", async () => {
    // `forget` is deliberately a NO-OP for the wiki (compile owns removal via
    // orphan marking), so it does not delete the row. What this asserts is the
    // narrower true statement: forget followed by a replay leaves ONE row, and
    // the replay reports `unchanged` rather than writing again.
    const dim = dimension(bridgeRoot);
    const input = inputOf("Forgotten Then Replayed", "src://forget-replay");

    await write(dim, input);
    await dim.forget({ source: "src://forget-replay" });
    const replayed = await write(dim, input);

    expect(replayed.writeStatus).toBe("unchanged");
    const pages = await listStoredPages(harness.db, harness.stackId, 200);
    expect(pages.filter((page) => page.title === "Forgotten Then Replayed")).toHaveLength(1);
  }, 30_000);

  it.skipIf(!provisioned)("a replay DOES recreate a row that something else deleted", async () => {
    // THIS IS NOT RESURRECTION OF FORGOTTEN WORK, and the distinction matters
    // for the port's promise. `forget` never removes the row, so nothing here
    // undoes a removal the dimension performed. When the row is gone because a
    // DIFFERENT actor deleted it, a replay re-creates it -- which is correct for
    // reconciliation (the record says the ingest committed) but would be wrong if
    // it re-created a page a real forget had retired.
    //
    // Pinned so that when W3.1 gives `forget` teeth, whoever does it sees this
    // case go red rather than discovering the interaction in production.
    const dim = dimension(bridgeRoot);
    const input = inputOf("Deleted Behind Our Back", "src://deleted");
    await write(dim, input);

    await harness.db.execute(
      `delete from wiki.pages where stack_id = '${harness.stackId}' and title = 'Deleted Behind Our Back'`,
    );
    const before = await listStoredPages(harness.db, harness.stackId, 200);
    expect(before.filter((page) => page.title === "Deleted Behind Our Back")).toHaveLength(0);

    const replayed = await write(dim, input);
    expect(replayed.writeStatus).toBe("created");
    const after = await listStoredPages(harness.db, harness.stackId, 200);
    expect(after.filter((page) => page.title === "Deleted Behind Our Back")).toHaveLength(1);
  }, 30_000);
});
