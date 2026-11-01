/**
 * @file test/dimensions/wiki-concept-merge-plan.test.ts
 * @description The compile-facing seam: positional alignment, group slugs, and
 * the guarantee that a plan is built even when no embedding port exists.
 */

import { describe, it, expect } from "vitest";

import {
  groupSlugs,
  planConceptMerge,
  type MergePlanCandidate,
} from "../../src/dimensions/wiki/concept-merge-plan.js";
import type { ConceptEmbeddingPort } from "../../src/dimensions/wiki/concept-resolution.js";

/** A port that scores every pair as identical, so the cosine tier always merges. */
const identicalPort: ConceptEmbeddingPort = {
  fingerprint: "fp-test",
  async embed(texts) {
    return { ok: true, vectors: texts.map(() => [1, 0]) };
  },
};

describe("planConceptMerge", () => {
  const candidates: MergePlanCandidate[] = [
    { name: "HNSW Index" },
    { name: "Vector DB" },
    { name: "Vector Database" },
  ];

  it("aligns every entry with the input position, not the resolver's sorted order", async () => {
    const plan = await planConceptMerge(candidates);
    expect(plan.entries).toHaveLength(candidates.length);
    expect(plan.entries[0].canonicalName).toBe("HNSW Index");
    expect(plan.entries[1].groupSlug).toBe(plan.entries[2].groupSlug);
  });

  it("names the group after the canonical member and marks it", async () => {
    const plan = await planConceptMerge(candidates);
    const canonical = plan.entries.filter((entry) => entry.isCanonical);
    expect(canonical).toHaveLength(2);
    expect(plan.entries[1].isCanonical).toBe(true);
    expect(plan.entries[2].isCanonical).toBe(false);
  });

  it("collapses a synonym pair to one group slug by rule alone", async () => {
    const plan = await planConceptMerge(candidates);
    expect(groupSlugs(plan)).toEqual(["hnsw-index", "vector-db"]);
  });

  it("keeps a concept that shares no word with any other as its own group", async () => {
    const plan = await planConceptMerge([{ name: "Baking Bread" }, { name: "HNSW Index" }]);
    expect(groupSlugs(plan)).toHaveLength(2);
  });

  it("reports the degradation while still producing a usable plan", async () => {
    const plan = await planConceptMerge(candidates);
    expect(plan.resolution.degradation?.reason).toBe("embeddings-unconfigured");
    expect(plan.entries).toHaveLength(candidates.length);
  });

  it("merges names that share no token once a port can score them", async () => {
    const plan = await planConceptMerge(
      [{ name: "PostgreSQL" }, { name: "Postgres" }],
      { embed: identicalPort, thresholds: { auto: 0.9, review: 0.8 } },
    );
    expect(groupSlugs(plan)).toHaveLength(1);
    expect(plan.resolution.groups[0].tier).toBe("auto");
  });
});
