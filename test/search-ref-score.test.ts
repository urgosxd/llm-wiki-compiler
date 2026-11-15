/**
 * @file test/search-ref-score.test.ts
 * @description Field 1 — a search result ref carries the similarity score the
 * retrieval ALREADY used to rank it.
 *
 * The score is not re-derived here and must not be: a number that disagrees with
 * the ranking is worse than no number, because an agent would threshold on a value
 * the pipeline never used. So every assertion below is against the RANKING the refs
 * arrive in, not against the presence of a field:
 *
 *  - the seeded vectors give distinct cosine similarities, so the expected order is
 *    known independently of the implementation;
 *  - the scores must be monotonically NON-INCREASING across the returned order;
 *  - the highest-similarity page must come first;
 *  - the pre-existing fields of every ref must be unchanged (the change is additive);
 *  - `kind:"index"` refs — the LLM-over-index fallback, which computes no similarity
 *    at all — must OMIT the key rather than carry a fabricated 0 or null.
 *
 * Chunk-level and page-level refs are both exercised: they are two separate
 * construction sites in `retrieval.ts`, and only one of them breaking would still
 * look like a working feature from the other's test.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { seedFallbackProject, stubSelectPages } from "./fixtures/fallback-stub.js";
import {
  chunkOf,
  mockQueryVector,
  pageEntryOf,
  tempRootRegistry,
  writeChunkStore,
  writePageStore,
} from "./fixtures/typed-grounding.js";
import { pickSearchRefs } from "../packages/wiki/src/search/retrieval.js";
import type { SelectedPageRef } from "../packages/wiki/src/search/retrieval.js";

// File-wide: the embedding path never selects pages with the LLM, so a ref set
// that reaches the stub means retrieval degraded — and the assertions below fail
// loudly instead of silently testing the fallback.
vi.mock("../packages/wiki/src/utils/llm.js", () => ({ callClaude: vi.fn() }));

const tempRoots = tempRootRegistry();

afterEach(async () => {
  vi.restoreAllMocks();
  await tempRoots.cleanup();
});

/** The query vector all fixtures are scored against. */
const QUERY_VECTOR = [1, 0];

/** Similarity of the seeded vectors against {@link QUERY_VECTOR}: 1.0 and 0.6. */
const NEAR_VECTOR = [1, 0];
const MID_VECTOR = [0.6, 0.8];
const FAR_VECTOR = [0, 1];

/**
 * Assert that the refs are ordered by descending score, which is the only thing
 * that makes an exposed score trustworthy: the retrieval sorted by exactly this
 * value, so the array must be non-increasing.
 *
 * @param refs - Refs in returned order.
 */
function expectMonotonicScores(refs: readonly SelectedPageRef[]): void {
  expect(refs.length, "no refs to check ordering on").toBeGreaterThan(1);
  for (let index = 1; index < refs.length; index += 1) {
    const previous = refs[index - 1];
    const current = refs[index];
    expect(previous.score, `ref ${previous.pageId} carries no score`).toBeTypeOf("number");
    expect(current.score, `ref ${current.pageId} carries no score`).toBeTypeOf("number");
    expect(
      previous.score,
      `refs are not ordered by descending score: ${previous.pageId} (${previous.score}) before ${current.pageId} (${current.score})`,
    ).toBeGreaterThanOrEqual(current.score as number);
  }
}

/** The pre-existing fields of a ref, ignoring any score. */
function identityOf(ref: SelectedPageRef): Pick<SelectedPageRef, "pageId" | "slug" | "title" | "kind"> {
  return { pageId: ref.pageId, slug: ref.slug, title: ref.title, kind: ref.kind };
}

/**
 * A temp wiki root primed for a ranking fixture.
 *
 * Both ranking fixtures need the same four things before the store matters — an
 * `index.md` for the lexical fallback, the internal `.llmwiki` directory, a tracked
 * temp root, and the concept pages on disk — so those live here once and only the
 * STORE differs between the page-level and chunk-level fixtures.
 *
 * @param prefix - Identifies the fixture's temp directory.
 * @param seeded - Concept pages to write, with the metadata each fixture asserts on.
 * @returns The temp root, already tracked for cleanup.
 */
async function seedConceptCorpus(
  prefix: string,
  seeded: ReadonlyArray<{ slug: string; title: string; summary: string; body: string }>,
): Promise<string> {
  const root = await makeTempRoot(prefix);
  tempRoots.track(root);
  await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  for (const page of seeded) {
    await writePage(path.join(root, "wiki/concepts"), page.slug, { title: page.title, summary: page.summary }, page.body);
  }
  return root;
}

/** Seed three concept pages whose page embeddings give distinct similarities. */
async function seedRankedPages(): Promise<string> {
  const seeded = [
    { slug: "alpha", title: "Alpha", summary: "a", vec: NEAR_VECTOR, body: "ALPHA_BODY fact." },
    { slug: "beta", title: "Beta", summary: "b", vec: MID_VECTOR, body: "BETA_BODY fact." },
    { slug: "gamma", title: "Gamma", summary: "g", vec: FAR_VECTOR, body: "GAMMA_BODY fact." },
  ];
  const root = await seedConceptCorpus("ref-score-pages", seeded);
  await writePageStore(
    root,
    seeded.map((page) => pageEntryOf(`concepts/${page.slug}`, page.title, page.summary, page.vec)),
  );
  return root;
}

/** Seed two concept pages whose CHUNK embeddings give distinct similarities. */
async function seedRankedChunks(): Promise<string> {
  const seeded = [
    { slug: "alpha", title: "alpha", summary: "s", vec: NEAR_VECTOR, body: "ALPHA_BODY fact." },
    { slug: "beta", title: "beta", summary: "s", vec: MID_VECTOR, body: "BETA_BODY fact." },
  ];
  const root = await seedConceptCorpus("ref-score-chunks", seeded);
  await writeChunkStore(
    root,
    seeded.map((page) => chunkOf(`concepts/${page.slug}`, page.body, page.vec)),
  );
  return root;
}

describe("search refs carry the score the retrieval ranked by — chunk level", () => {
  it("exposes descending cosine similarity in the ranked order, best first", async () => {
    const root = await seedRankedChunks();
    mockQueryVector(QUERY_VECTOR);

    const { refs } = await pickSearchRefs(root, "alpha?");

    expect(refs.map((ref) => ref.kind)).toEqual(["chunk", "chunk"]);
    expectMonotonicScores(refs);
    expect(refs[0].pageId, "the near-identical chunk must rank first").toBe("concepts/alpha");
    expect(refs[0].score).toBeCloseTo(1, 6);
    expect(refs[1].score).toBeCloseTo(0.6, 6);
    expect(new Set(refs.map((ref) => ref.score)).size, "scores collapsed to one value").toBeGreaterThan(1);
  });

  it("keeps every pre-existing ref field unchanged and still blank-titles chunk refs", async () => {
    const root = await seedRankedChunks();
    mockQueryVector(QUERY_VECTOR);

    const { refs } = await pickSearchRefs(root, "alpha?");

    expect(refs.map(identityOf)).toEqual([
      { pageId: "concepts/alpha", slug: "alpha", title: "", kind: "chunk" },
      { pageId: "concepts/beta", slug: "beta", title: "", kind: "chunk" },
    ]);
  });
});

describe("search refs carry the score the retrieval ranked by — page level", () => {
  it("exposes descending cosine similarity in the ranked order, best first", async () => {
    const root = await seedRankedPages();
    mockQueryVector(QUERY_VECTOR);

    const { refs } = await pickSearchRefs(root, "alpha?");

    expect(refs.map((ref) => ref.kind)).toEqual(["page", "page", "page"]);
    expectMonotonicScores(refs);
    expect(refs.map((ref) => ref.pageId)).toEqual(["concepts/alpha", "concepts/beta", "concepts/gamma"]);
    expect(refs[0].score).toBeCloseTo(1, 6);
    expect(refs[1].score).toBeCloseTo(0.6, 6);
    expect(refs[2].score).toBeCloseTo(0, 6);
    expect(new Set(refs.map((ref) => ref.score)).size, "scores collapsed to one value").toBeGreaterThan(1);
  });

  it("keeps every pre-existing ref field unchanged", async () => {
    const root = await seedRankedPages();
    mockQueryVector(QUERY_VECTOR);

    const { refs } = await pickSearchRefs(root, "alpha?");

    expect(refs.map(identityOf)).toEqual([
      { pageId: "concepts/alpha", slug: "alpha", title: "Alpha", kind: "page" },
      { pageId: "concepts/beta", slug: "beta", title: "Beta", kind: "page" },
      { pageId: "concepts/gamma", slug: "gamma", title: "Gamma", kind: "page" },
    ]);
  });
});

describe("index-fallback refs carry NO score", () => {
  it("omits the key entirely rather than reporting a fabricated 0", async () => {
    const root = await seedFallbackProject("ref-score-index", { concept: "c-one", query: "q-one", typed: "p-one" });
    tempRoots.track(root);
    await stubSelectPages(["concepts/c-one", "queries/q-one"]);

    const { refs } = await pickSearchRefs(root, "anything");

    // PRECONDITION pinned: this is the LLM-over-index branch, which computes no
    // similarity at all. Without it the assertion below would be vacuous.
    expect(refs.map((ref) => ref.kind)).toEqual(["index", "index"]);

    const serialized = JSON.parse(JSON.stringify(refs)) as Array<Record<string, unknown>>;
    for (const ref of serialized) {
      expect(Object.hasOwn(ref, "score"), `index ref ${String(ref.pageId)} serialized a score`).toBe(false);
    }
    expect(refs.map((ref) => ref.score)).toEqual([undefined, undefined]);
    expect(refs.map(identityOf)).toEqual([
      { pageId: "concepts/c-one", slug: "c-one", title: "Concept Page", kind: "index" },
      { pageId: "queries/q-one", slug: "q-one", title: "Query Page", kind: "index" },
    ]);
  });
});
