/**
 * @file test/dimensions/wiki-concept-resolution.test.ts
 * @description Tier 2 grouping: the two-threshold policy, order independence, the
 * canonical-name rule, and every degradation path.
 *
 * The embedding port is a stub so a score can be dictated exactly. That is the
 * point of the port: policy is tested without a provider, and the score a test
 * asserts on is the score the resolver saw.
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_AUTO_THRESHOLD,
  DEFAULT_REVIEW_THRESHOLD,
  resolveConceptIdentity,
  type ConceptCandidate,
  type ConceptEmbeddingPort,
  type ConceptEmbedOutcome,
} from "../../src/dimensions/wiki/concept-resolution.js";

/** Vectors placed on a plane so one cosine value can be requested directly. */
function vectorAtDegrees(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

/**
 * A port whose score for a pair is dictated by the text it sees.
 *
 * Every text maps to an angle; the cosine between two angles is what the resolver
 * computes. `scores` maps a text to its angle in degrees.
 */
function stubPort(angles: Readonly<Record<string, number>>): ConceptEmbeddingPort {
  return {
    fingerprint: "fp-test",
    async embed(texts: readonly string[]): Promise<ConceptEmbedOutcome> {
      return {
        ok: true,
        vectors: texts.map((text) => vectorAtDegrees(angleFor(text, angles))),
      };
    },
  };
}

/** The angle for one identity text, matched on its first line (the name). */
function angleFor(text: string, angles: Readonly<Record<string, number>>): number {
  const name = text.split("\n")[0];
  return angles[name] ?? 0;
}

/** A failing port, for the reported-failure path. */
const failingPort: ConceptEmbeddingPort = {
  fingerprint: "fp-test",
  async embed(): Promise<ConceptEmbedOutcome> {
    return { ok: false, degradation: { reason: "embeddings-failed", detail: "auth: denied" } };
  },
};

describe("resolveConceptIdentity deterministic tiers", () => {
  it("merges names that share a slug without asking for vectors", async () => {
    const candidates: ConceptCandidate[] = [{ name: "Vector DB" }, { name: "vector-db" }];
    const result = await resolveConceptIdentity(candidates);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].tier).toBe("slug");
    expect(result.aliases[0].aliasSlug).toBe("vector-db");
  });

  it("merges a synonym found by anchors alone, with no embedding port", async () => {
    const candidates: ConceptCandidate[] = [
      { name: "Vector Database" },
      { name: "Vector DB" },
    ];
    const result = await resolveConceptIdentity(candidates);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].tier).toBe("normalized");
  });

  it("keeps unrelated concepts in separate groups", async () => {
    const candidates: ConceptCandidate[] = [{ name: "Baking Bread" }, { name: "Vector Database" }];
    const result = await resolveConceptIdentity(candidates);
    expect(result.groups).toHaveLength(2);
  });
});

describe("resolveConceptIdentity thresholds", () => {
  /** Two candidates whose names share a token, so they reach the cosine tier. */
  const pair: ConceptCandidate[] = [{ name: "Vector Search" }, { name: "Vector Indexing" }];

  it("merges at the auto tier when the score clears the auto threshold", async () => {
    const result = await resolveConceptIdentity(pair, {
      embed: stubPort({ "Vector Search": 0, "Vector Indexing": 10 }),
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].tier).toBe("auto");
    expect(result.pending).toHaveLength(0);
  });

  it("merges in the review band but records the merge as pending", async () => {
    const result = await resolveConceptIdentity(pair, {
      embed: stubPort({ "Vector Search": 0, "Vector Indexing": 25 }),
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].tier).toBe("review");
    expect(result.aliases).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
  });

  it("keeps concepts separate below the review threshold", async () => {
    const result = await resolveConceptIdentity(pair, {
      embed: stubPort({ "Vector Search": 0, "Vector Indexing": 60 }),
    });
    expect(result.groups).toHaveLength(2);
    expect(result.pending).toHaveLength(0);
  });

  it("honours caller-supplied thresholds over the defaults", async () => {
    const result = await resolveConceptIdentity(pair, {
      embed: stubPort({ "Vector Search": 0, "Vector Indexing": 25 }),
      thresholds: { auto: 0.95, review: 0.5 },
    });
    expect(result.groups[0].tier).toBe("review");
    expect(DEFAULT_REVIEW_THRESHOLD).toBeLessThan(DEFAULT_AUTO_THRESHOLD);
  });

  it("skips a cosine comparison when the tag sets are disjoint", async () => {
    const tagged: ConceptCandidate[] = [
      { name: "Vector Search", tags: ["storage"] },
      { name: "Vector Indexing", tags: ["cooking"] },
    ];
    const result = await resolveConceptIdentity(tagged, {
      embed: stubPort({ "Vector Search": 0, "Vector Indexing": 0 }),
    });
    expect(result.groups).toHaveLength(2);
  });
});

describe("resolveConceptIdentity per-member evidence routing", () => {
  /**
   * A three-member chain reproducing the finding: A-B clears the auto band and
   * B-C only clears the review band. Three names share a token so all three
   * pairs reach the cosine tier.
   */
  const chain: ConceptCandidate[] = [
    { name: "Vector Alpha" },
    { name: "Vector Beta" },
    { name: "Vector Gamma" },
  ];

  it("routes each member by its own edge, not by the group's strongest edge", async () => {
    // Alpha-Beta = 0 deg apart (score 1.0, auto), so Beta is a confident alias.
    // Gamma only reaches 27 deg against both (0.891, review), so Gamma is pending.
    // Before the per-member fix the whole group reported `auto` and Gamma was
    // emitted as a confident, irreversible alias — the review band silently lost.
    const result = await resolveConceptIdentity(chain, {
      embed: stubPort({ "Vector Alpha": 0, "Vector Beta": 0, "Vector Gamma": 27 }),
    });
    expect(result.groups).toHaveLength(1);
    expect(result.aliases.map((alias) => alias.aliasSlug)).toEqual(["vector-beta"]);
    expect(result.aliases[0].tier).toBe("auto");
    expect(result.pending.map((alias) => alias.aliasSlug)).toEqual(["vector-gamma"]);
    expect(result.pending[0].tier).toBe("review");
  });

  it("still routes a member joined through the auto band to the confident aliases", async () => {
    const result = await resolveConceptIdentity(chain, {
      embed: stubPort({ "Vector Alpha": 0, "Vector Beta": 0, "Vector Gamma": 90 }),
    });
    // Only Alpha-Beta merges; Gamma stays out of the group entirely.
    expect(result.groups).toHaveLength(2);
    expect(result.aliases).toHaveLength(1);
    expect(result.aliases[0].tier).toBe("auto");
    expect(result.pending).toHaveLength(0);
  });
});

describe("resolveConceptIdentity canonical name", () => {
  it("keeps the name of the concept already present in the wiki", async () => {
    const result = await resolveConceptIdentity(
      [{ name: "Vector DB", confidence: 0.9 }, { name: "Vector Database", confidence: 0.1 }],
      { incumbents: new Set(["vector-db"]) },
    );
    expect(result.groups[0].canonicalName).toBe("Vector DB");
  });

  it("prefers the most confident name when nothing is incumbent", async () => {
    const result = await resolveConceptIdentity([
      { name: "Vector DB", confidence: 0.3 },
      { name: "Vector Database", confidence: 0.9 },
    ]);
    expect(result.groups[0].canonicalName).toBe("Vector Database");
  });

  it("breaks a confidence tie by code-unit name order, independent of locale", async () => {
    // Uppercase letters sort before lowercase ones by code unit, so "Vector DB"
    // wins. `localeCompare` would order these differently under some locales,
    // which would make the page slug host-dependent.
    const result = await resolveConceptIdentity([
      { name: "Vector Database", confidence: 0.5 },
      { name: "Vector DB", confidence: 0.5 },
    ]);
    expect(result.groups[0].canonicalName).toBe("Vector DB");
  });
});

describe("resolveConceptIdentity invariants", () => {
  const candidates: ConceptCandidate[] = [
    { name: "Vector Database" },
    { name: "Vector DB" },
    { name: "HNSW Index" },
    { name: "Baking Bread" },
  ];

  it("produces the same grouping regardless of input order", async () => {
    const forward = await resolveConceptIdentity(candidates);
    const reversed = await resolveConceptIdentity([...candidates].reverse());
    expect(reversed.groups.map((group) => group.canonicalName).sort())
      .toEqual(forward.groups.map((group) => group.canonicalName).sort());
  });

  it("is a fixpoint: resolving canonical names changes nothing", async () => {
    const first = await resolveConceptIdentity(candidates);
    const second = await resolveConceptIdentity(
      first.groups.map((group) => ({ name: group.canonicalName })),
    );
    expect(second.groups.map((group) => group.canonicalName).sort())
      .toEqual(first.groups.map((group) => group.canonicalName).sort());
  });
});

describe("resolveConceptIdentity degradation", () => {
  const pair: ConceptCandidate[] = [{ name: "Vector Search" }, { name: "Vector Indexing" }];

  it("reports an unconfigured port instead of failing", async () => {
    const result = await resolveConceptIdentity(pair);
    expect(result.degradation?.reason).toBe("embeddings-unconfigured");
    expect(result.groups).toHaveLength(2);
  });

  it("reports a provider failure and still returns the deterministic groups", async () => {
    const result = await resolveConceptIdentity(pair, { embed: failingPort });
    expect(result.degradation?.reason).toBe("embeddings-failed");
    expect(result.degradation?.detail).toContain("auth");
    expect(result.groups).toHaveLength(2);
  });

  it("reports no degradation when nothing needed a comparison", async () => {
    const result = await resolveConceptIdentity([{ name: "Baking Bread" }]);
    expect(result.degradation).toBeUndefined();
  });
});
