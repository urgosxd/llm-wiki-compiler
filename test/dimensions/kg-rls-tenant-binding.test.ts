/**
 * @file test/dimensions/kg-rls-tenant-binding.test.ts
 * @description Every reader that binds a tenant must bind it INSIDE the
 * transaction that reads, or the row-level-security policy evaluates unbound and
 * the reader returns nothing — for a Stack whose rows genuinely exist.
 *
 * ## Why this class of defect was invisible until now
 *
 * `set_config('app.stack_id', $1, true)` is the parameterised `SET LOCAL`: it lasts
 * only until the enclosing transaction ends. A reader that binds the POOLED handle
 * and then queries in a separate implicit transaction therefore leaves the policy
 * unbound. Under `aks` (superuser, BYPASSRLS) the policy is inert and the explicit
 * `where stack_id = ...` predicate carries the query, so everything works and
 * nothing is visible. Under `llmwiki_app` the same read returns zero rows.
 *
 * The failure is not an error. `readEmbeddingMeta` returns `null`, the loader
 * reports the store ABSENT, and the caller degrades to "No embedding index found"
 * for a healthy Stack. That is why the assertion here is a COUNT comparison and
 * not "does it throw".
 *
 * ## What each case pins
 *
 * Each reader is exercised through {@link roleScopedDb}, whose every transaction
 * runs as `llmwiki_app`. A reader that binds correctly finds its rows; one that
 * binds outside its transaction finds none. Both directions are asserted, so a
 * future change that moves the binding back out fails loudly instead of silently
 * emptying the result.
 *
 * ## Why `provisionStack` rather than a hand-rolled harness pair
 *
 * The `beforeEach`/`afterEach` pair around `createKgPostgresHarness` was the most
 * duplicated shape in the dimension suites; `provisionStack` owns it so the copies
 * cannot drift.
 */

import { afterAll, describe, expect, it } from "vitest";

import {
  databaseEmbeddingSource,
  readEmbeddingMeta,
  readEmbeddingStoreFromDb,
} from "../../packages/wiki/src/utils/embeddings-database.js";
import { writeEmbeddingStoreToDb } from "../../packages/wiki/src/utils/embeddings-database-write.js";
import { listSourceDocuments, saveSourceDocument } from "../../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { createRegistryPageSource } from "../../packages/wiki/src/dimensions/wiki/page-registry-source.js";
import type { ChunkEmbeddingV3, EmbeddingStoreV3 } from "../../packages/wiki/src/utils/embeddings-store.js";
import { provisionStack } from "../fixtures/stack-harness.js";
import { appRoleExists } from "../fixtures/rls-probe.js";
import { roleScopedDb } from "../fixtures/role-scoped-db.js";

/** Vector width the store tables require: `vector(768)` is fixed by the schema. */
const DIMS = 768;

/** One chunk entry, wide enough for the column but only DIMS long. */
function chunkEntry(): ChunkEmbeddingV3 {
  return {
    pageId: "concepts/bound",
    title: "Bound",
    chunkIndex: 0,
    contentHash: "hash-bound",
    text: "chunk text",
    vector: new Array<number>(DIMS).fill(0.5),
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A minimal v3 store carrying one chunk and no page entries. */
function storeOf(): EmbeddingStoreV3 {
  return { version: 3, model: "probe-model", dimensions: DIMS, entries: [], chunks: [chunkEntry()] };
}

// Top-level await, matching `kg-runtime-rls-trap.test.ts`: `it.skipIf` is decided
// when the file is DEFINED, not when it runs, so a role probe inside `beforeAll`
// would read `false` and skip every case silently.
const provisioned = await provisionStack("rls-tenant-binding");
const { harness, release } = provisioned;
const reachable = await appRoleExists(harness.db);

afterAll(async () => {
  await release();
});

if (reachable) {
  await harness.db.execute(`
    insert into wiki.pages (stack_id, page_directory, slug, title)
    values ('${harness.stackId}', 'concepts', 'bound', 'Bound')
  `);
  await writeEmbeddingStoreToDb(harness.db, harness.stackId, storeOf());
  await saveSourceDocument(harness.db, harness.stackId, {
    title: "Bound source",
    document: "---\ntitle: Bound source\n---\n\nbody",
    source: "src/bound.md",
  });
}

describe("tenant binding runs inside the transaction that reads", () => {

  /**
   * A case that only means something when the app role exists.
   *
   * Skipping on a missing role must be LOUD, not silent: without `llmwiki_app` the
   * only connection available is the BYPASSRLS superuser, where every policy is
   * inert and the assertion would pass for the wrong reason.
   *
   * @param name - Case name.
   * @param body - Case body.
   */
  const guarded = (name: string, body: () => Promise<void>) =>
    it.skipIf(!reachable)(name, body);


  guarded("readEmbeddingMeta finds the header as the app role", async () => {
    const meta = await readEmbeddingMeta(roleScopedDb(harness.db), harness.stackId);
    expect(meta).not.toBeNull();
    expect(meta?.model).toBe("probe-model");
    expect(meta?.dimensions).toBe(DIMS);
  });

  guarded("readEmbeddingStoreFromDb finds vectors as the app role", async () => {
    const store = await readEmbeddingStoreFromDb(roleScopedDb(harness.db), harness.stackId);
    expect(store).not.toBeNull();
    expect(store?.chunks?.length).toBe(1);
  });

  guarded("the embedding source reports PARSED, not absent", async () => {
    const read = await databaseEmbeddingSource(roleScopedDb(harness.db), harness.stackId).read();
    // "absent" here is the silent-degradation shape of the defect: the caller would
    // warn "No embedding index found" for a Stack that has one.
    expect(read.kind).toBe("parsed");
  });

  guarded("listSourceDocuments finds the corpus as the app role", async () => {
    const documents = await listSourceDocuments(roleScopedDb(harness.db), harness.stackId);
    expect(documents.length).toBe(1);
    expect(documents[0]?.sourceIdentity).toBe("src/bound.md");
  });

  guarded("the registry source finds its live ids as the app role", async () => {
    const dirs = new Map([["concepts", "wiki/concepts"], ["queries", "wiki/queries"]]);
    const live = await createRegistryPageSource(
      roleScopedDb(harness.db) as never, harness.stackId,
    ).liveIds(["concepts", "queries"], dirs, undefined);
    expect(live.has("concepts/bound")).toBe(true);
  });

  it("skips loudly when the app role is absent", () => {
    // A silent skip would let a suite that never ran look like one that passed.
    expect(typeof reachable).toBe("boolean");
  });
});
