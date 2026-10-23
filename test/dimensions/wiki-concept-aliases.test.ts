/**
 * @file test/dimensions/wiki-concept-aliases.test.ts
 * @description The persisted alias record and its invalidation rule.
 *
 * The rule under test is the one that prevents a silent quality collapse: a stored
 * decision is only reusable inside the embedding configuration that produced it, so
 * a changed fingerprint must discard the record rather than score against vectors
 * that are no longer comparable.
 */

import { describe, it, expect } from "vitest";

import {
  CONCEPT_ALIAS_RECORD_VERSION,
  CONCEPT_IDENTITY_RULESET_VERSION,
  aliasLookup,
  buildConceptAliasRecord,
  conceptAliasRecordUsable,
  type ConceptAliasRecord,
} from "../../src/dimensions/wiki/concept-aliases.js";

/** A record built under one fingerprint, with one confident and one pending alias. */
function sampleRecord(fingerprint = "fp-a"): ConceptAliasRecord {
  return buildConceptAliasRecord(
    fingerprint,
    [{ aliasSlug: "vector-db", canonicalSlug: "vector-database" }],
    [{ aliasSlug: "ann-index", canonicalSlug: "approximate-nearest-neighbour" }],
  );
}

describe("buildConceptAliasRecord", () => {
  it("stamps the shape version and the ruleset version", () => {
    const record = sampleRecord();
    expect(record.version).toBe(CONCEPT_ALIAS_RECORD_VERSION);
    expect(record.ruleset).toBe(CONCEPT_IDENTITY_RULESET_VERSION);
  });

  it("omits the score when the alias carries none", () => {
    expect(sampleRecord().aliases[0]).not.toHaveProperty("score");
  });

  it("records the score when one is supplied", () => {
    const record = buildConceptAliasRecord("fp-a", [{ aliasSlug: "a", canonicalSlug: "b", score: 0.94 }], []);
    expect(record.aliases[0].score).toBe(0.94);
  });
});

describe("conceptAliasRecordUsable", () => {
  it("accepts a record built under the active fingerprint", () => {
    expect(conceptAliasRecordUsable(sampleRecord("fp-a"), { fingerprint: "fp-a" })).toBe(true);
  });

  it("rejects a record built under a different fingerprint", () => {
    expect(conceptAliasRecordUsable(sampleRecord("fp-a"), { fingerprint: "fp-b" })).toBe(false);
  });

  it("rejects a record when the active fingerprint is unknown", () => {
    expect(conceptAliasRecordUsable(sampleRecord(), { fingerprint: undefined })).toBe(false);
  });

  it("rejects a missing record", () => {
    expect(conceptAliasRecordUsable(undefined, { fingerprint: "fp-a" })).toBe(false);
  });

  it("rejects a record written under a different ruleset", () => {
    const stale = { ...sampleRecord(), ruleset: CONCEPT_IDENTITY_RULESET_VERSION - 1 };
    expect(conceptAliasRecordUsable(stale, { fingerprint: "fp-a" })).toBe(false);
  });

  it("rejects a record from an incompatible shape version", () => {
    const stale = { ...sampleRecord(), version: 0 } as unknown as ConceptAliasRecord;
    expect(conceptAliasRecordUsable(stale, { fingerprint: "fp-a" })).toBe(false);
  });

  it("rejects a record whose fingerprint was never recorded", () => {
    expect(conceptAliasRecordUsable(sampleRecord(""), { fingerprint: "fp-a" })).toBe(false);
  });
});

describe("aliasLookup", () => {
  it("includes both bands by default", () => {
    const lookup = aliasLookup(sampleRecord(), { fingerprint: "fp-a" });
    expect(lookup.size).toBe(2);
    expect(lookup.get("vector-db")).toBe("vector-database");
  });

  it("excludes the review band when pending merges are not wanted", () => {
    const lookup = aliasLookup(sampleRecord(), { fingerprint: "fp-a" }, false);
    expect(lookup.size).toBe(1);
    expect(lookup.has("ann-index")).toBe(false);
  });

  it("contributes nothing when the record is unusable", () => {
    const lookup = aliasLookup(sampleRecord("fp-a"), { fingerprint: "fp-b" });
    expect(lookup.size).toBe(0);
  });

  it("lets a confident alias win over a pending one for the same slug", () => {
    const record = buildConceptAliasRecord(
      "fp-a",
      [{ aliasSlug: "x", canonicalSlug: "confident" }],
      [{ aliasSlug: "x", canonicalSlug: "pending" }],
    );
    expect(aliasLookup(record, { fingerprint: "fp-a" }).get("x")).toBe("confident");
  });
});
