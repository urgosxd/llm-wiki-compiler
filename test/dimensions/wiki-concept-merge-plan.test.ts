/**
 * @file test/dimensions/wiki-concept-merge-plan.test.ts
 * @description The compile-facing seam: positional alignment, group slugs, and
 * the proof that a similarity score never reaches group construction (S6, S14).
 */

import { describe, it, expect } from "vitest";

import {
  groupSlugs,
  planConceptMerge,
  type MergePlanCandidate,
} from "../../src/dimensions/wiki/concept-merge-plan.js";
import type { ConceptEmbeddingPort } from "../../src/dimensions/wiki/concept-resolution.js";

/** A port that scores every pair as identical, so every pair becomes a proposal. */
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

  it("keeps names that share no token apart even when a port scores them 1.0", async () => {
    // Inverted defect-pin: this pair used to merge at tier "auto" on the strength
    // of the cosine score alone. A score is a proposal now, never a verdict.
    const plan = await planConceptMerge(
      [{ name: "PostgreSQL" }, { name: "Postgres" }],
      { embed: identicalPort },
    );
    expect(groupSlugs(plan)).toEqual(["postgres", "postgresql"]);
    expect(plan.resolution.aliases).toHaveLength(0);
    expect(plan.resolution.similarities).toEqual([
      { leftName: "PostgreSQL", rightName: "Postgres", score: 1 },
    ]);
  });

  it("folds a candidate into an incumbent through the incumbent's declared alias", async () => {
    const plan = await planConceptMerge(
      [{ name: "pgvector store" }],
      {
        incumbents: new Map([
          ["vector-db", { canonicalName: "Vector DB", aliases: ["pgvector store"] }],
        ]),
      },
    );
    expect(groupSlugs(plan)).toEqual(["vector-db"]);
    expect(plan.entries[0].tier).toBe("alias");
    expect(plan.entries[0].isCanonical).toBe(false);
  });
});
