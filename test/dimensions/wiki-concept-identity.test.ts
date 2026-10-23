/**
 * @file test/dimensions/wiki-concept-identity.test.ts
 * @description Tier 0/1 identity: deterministic canonicalization, blocking and the
 * tag gate the cosine tiers depend on.
 */

import { describe, it, expect } from "vitest";

import {
  blockingTokens,
  canonicalConceptKey,
  canonicalSlugKey,
  sharesBlockingSignal,
  tagsConflict,
} from "../../src/dimensions/wiki/concept-identity.js";

describe("canonicalConceptKey", () => {
  it("folds case and punctuation, so a hyphen is not an identity", () => {
    expect(canonicalConceptKey("Vector-DB")).toBe(canonicalConceptKey("vector db"));
  });

  it("expands a reviewed acronym onto the phrase it abbreviates", () => {
    expect(canonicalConceptKey("Vector DB")).toBe(canonicalConceptKey("Vector Database"));
  });

  it("stems plurals so a plural and a singular share one key", () => {
    expect(canonicalConceptKey("Vector Databases")).toBe(canonicalConceptKey("Vector Database"));
  });

  it("agrees across all three spellings of the motivating synonym", () => {
    const keys = new Set([
      canonicalConceptKey("Vector DB"),
      canonicalConceptKey("Vector Database"),
      canonicalConceptKey("vector databases"),
    ]);
    expect(keys.size).toBe(1);
  });

  it("restores the y that -ies replaced", () => {
    expect(canonicalConceptKey("queries")).toBe("query");
  });

  it("leaves a short token alone instead of stemming it into nonsense", () => {
    expect(canonicalConceptKey("is")).toBe("is");
  });

  it("returns an empty key for a name with no word characters", () => {
    expect(canonicalConceptKey("---")).toBe("");
  });

  it("keeps genuinely different concepts apart", () => {
    expect(canonicalConceptKey("graph database")).not.toBe(canonicalConceptKey("vector database"));
  });

  // Regression for R3-002: the stemmer re-ran the whole suffix list on the stem, so
  // "-sses"/"-ches" fell through to a bare "-s" strip and "classes" became "cla"
  // while "class" became "clas". Plural and singular did not even agree.
  it.each([
    ["classes", "class"],
    ["processes", "process"],
    ["boxes", "box"],
    ["matches", "match"],
    ["dishes", "dish"],
    ["queries", "query"],
    ["databases", "database"],
    ["notes", "note"],
    ["vectors", "vector"],
    // -ze stems: regression for the sibilant-head list carrying a bare "z".
    // A z-final English stem DOUBLES before "-es" ("quizzes"), so single "z"+"es"
    // is a silent-e plural and must keep its "e".
    ["sizes", "size"],
    ["freezes", "freeze"],
    ["prizes", "prize"],
  ])("folds the plural %s onto the singular %s", (plural, singular) => {
    expect(canonicalConceptKey(plural)).toBe(canonicalConceptKey(singular));
  });

  it("keeps the e of a -ze silent-e plural instead of stripping two characters", () => {
    expect(canonicalConceptKey("sizes")).toBe("size");
    expect(canonicalConceptKey("freezes")).toBe("freeze");
  });

  it("never leaves a stem shorter than the word it should have produced", () => {
    expect(canonicalConceptKey("classes")).toBe("class");
    expect(canonicalConceptKey("matches")).toBe("match");
  });
});

describe("canonicalSlugKey", () => {
  it("maps an existing slug onto the same identity as a fresh name", () => {
    expect(canonicalSlugKey("vector-db")).toBe(canonicalConceptKey("Vector Database"));
  });

  it("does not treat a slug and its reversed form as one concept", () => {
    expect(canonicalSlugKey("graph-database")).not.toBe(canonicalSlugKey("database-graph"));
  });
});

describe("blockingTokens", () => {
  it("drops tokens too short to discriminate", () => {
    expect(blockingTokens("db of ai")).not.toContain("of");
  });

  it("returns distinct tokens in sorted order", () => {
    const tokens = blockingTokens("Database database indexing");
    expect(tokens).toEqual([...new Set(tokens)].sort());
  });

  it("expands an acronym before selecting blocking tokens", () => {
    expect(blockingTokens("DB")).toContain("database");
  });
});

describe("tagsConflict", () => {
  it("reports a conflict only when both sides carry tags and share none", () => {
    expect(tagsConflict(["storage"], ["querying"])).toBe(true);
  });

  it("treats a missing tag list as no claim either way", () => {
    expect(tagsConflict(undefined, ["querying"])).toBe(false);
  });

  it("treats an empty tag list as no claim either way", () => {
    expect(tagsConflict([], ["querying"])).toBe(false);
  });

  it("is case-insensitive when a tag is shared", () => {
    expect(tagsConflict(["Storage"], ["storage"])).toBe(false);
  });
});

describe("sharesBlockingSignal", () => {
  it("lets a shared blocking token justify a comparison", () => {
    expect(sharesBlockingSignal("Vector Database", undefined, "Vector Index", undefined)).toBe(true);
  });

  it("lets a shared tag justify a comparison with no shared token", () => {
    expect(sharesBlockingSignal("HNSW", ["retrieval"], "IVF", ["Retrieval"])).toBe(true);
  });

  it("refuses a comparison when nothing is shared", () => {
    expect(sharesBlockingSignal("HNSW", ["index"], "Baking", ["cooking"])).toBe(false);
  });
});
