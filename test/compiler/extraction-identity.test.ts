/**
 * @file test/compiler/extraction-identity.test.ts
 * @description The compile-side binding of extractions to one concept-identity
 * decision: positional alignment, evidence preservation, and the alias pages a
 * merge leaves behind.
 *
 * The failure this pins hardest is the positional one. Two extractions of the same
 * document can both yield "Vector DB", and a name-keyed lookup would hand the
 * second one the first one's group while looking perfectly correct.
 */
import { describe, expect, it } from "vitest";
import {
  bindConceptsToCanonicalNames,
  conceptIdentityDecisions,
  mergePlanCandidates,
  resolveExtractionIdentity,
  supersededPageSlugs,
} from "../../src/compiler/extraction-identity.js";
import type { ExtractedConcept } from "../../src/utils/types.js";
import type { ExtractionResult } from "../../src/compiler/deps.js";

/** One source carrying the given concepts, in order. */
function source(file: string, concepts: ExtractedConcept[]): ExtractionResult {
  return { sourceFile: file, sourcePath: file, sourceContent: `Evidence from ${file}`, concepts };
}

/** A concept as the extraction model returns it. */
function concept(name: string, extra: Partial<ExtractedConcept> = {}): ExtractedConcept {
  return { concept: name, summary: `${name} summary`, is_new: true, ...extra };
}

const vectorDb = source("a.md", [concept("Vector DB", { tags: ["database"], confidence: 0.8 })]);
const vectorDatabase = source("b.md", [concept("Vector Database", { confidence: 0.9 })]);

describe("mergePlanCandidates", () => {
  it("flattens every extraction in source order, then concept order", () => {
    const candidates = mergePlanCandidates([
      source("a.md", [concept("Alpha"), concept("Beta")]),
      source("b.md", [concept("Gamma")]),
    ]);
    expect(candidates.map((candidate) => candidate.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("passes summary, tags and confidence through to the resolver", () => {
    const [candidate] = mergePlanCandidates([vectorDb]);
    expect(candidate.summary).toBe("Vector DB summary");
    expect(candidate.tags).toEqual(["database"]);
    expect(candidate.confidence).toBe(0.8);
  });
});

describe("concept identity decisions", () => {
  it("binds each concept to the entry at its own position", async () => {
    const plan = await resolveExtractionIdentity([vectorDb, vectorDatabase]);
    const decisions = conceptIdentityDecisions([vectorDb, vectorDatabase], plan!);
    expect(decisions.map((decision) => decision.extractedName))
      .toEqual(["Vector DB", "Vector Database"]);
    expect(decisions[0].entry.groupSlug).toBe(decisions[1].entry.groupSlug);
  });

  it("refuses a plan whose length disagrees with the run, instead of mis-binding", async () => {
    const plan = await resolveExtractionIdentity([vectorDb, vectorDatabase]);
    const wider = [vectorDb, vectorDatabase, source("c.md", [concept("Late Arrival")])];
    expect(() => conceptIdentityDecisions(wider, plan!)).toThrow(/covers 2 concepts but the run extracted 3/);
  });

  it("keeps two occurrences of one name in their own positions", async () => {
    const first = source("a.md", [concept("Vector DB"), concept("Vector DB", { summary: "second" })]);
    const plan = await resolveExtractionIdentity([first]);
    const decisions = conceptIdentityDecisions([first], plan!);
    expect(decisions).toHaveLength(2);
    expect(decisions[1].entry.groupSlug).toBe(decisions[0].entry.groupSlug);
  });
});

describe("bindConceptsToCanonicalNames", () => {
  it("renames the folded concept and keeps every other field", async () => {
    const plan = await resolveExtractionIdentity([vectorDb, vectorDatabase]);
    const [first] = bindConceptsToCanonicalNames([vectorDb, vectorDatabase], plan!);
    expect(first.concepts[0].concept).toBe("Vector Database");
    expect(first.concepts[0].summary).toBe("Vector DB summary");
    expect(first.concepts[0].tags).toEqual(["database"]);
  });

  it("marks a folded concept as not new, so only the canonical record says so", async () => {
    const plan = await resolveExtractionIdentity([vectorDb, vectorDatabase]);
    const [first] = bindConceptsToCanonicalNames([vectorDb, vectorDatabase], plan!);
    expect(first.concepts[0].is_new).toBe(false);
  });

  it("leaves the canonical concept untouched", async () => {
    const plan = await resolveExtractionIdentity([vectorDb, vectorDatabase]);
    const [, second] = bindConceptsToCanonicalNames([vectorDb, vectorDatabase], plan!);
    expect(second.concepts[0].concept).toBe("Vector Database");
  });

  it("does not mutate the input extractions", async () => {
    const plan = await resolveExtractionIdentity([vectorDb, vectorDatabase]);
    bindConceptsToCanonicalNames([vectorDb, vectorDatabase], plan!);
    expect(vectorDb.concepts[0].concept).toBe("Vector DB");
  });
});

describe("supersededPageSlugs", () => {
  it("names the alias page and the slug that absorbed it", async () => {
    const plan = await resolveExtractionIdentity([vectorDb, vectorDatabase]);
    const decisions = conceptIdentityDecisions([vectorDb, vectorDatabase], plan!);
    const superseded = supersededPageSlugs(new Set(["vector-database"]), decisions);
    expect(superseded.get("vector-db")).toBe("vector-database");
  });

  it("never retires a page that is itself a live group", async () => {
    const plan = await resolveExtractionIdentity([vectorDb, vectorDatabase]);
    const decisions = conceptIdentityDecisions([vectorDb, vectorDatabase], plan!);
    expect(supersededPageSlugs(new Set(["vector-db", "vector-database"]), decisions).size).toBe(0);
  });

  it("reports nothing when every concept kept its own name", async () => {
    const plan = await resolveExtractionIdentity([source("a.md", [concept("Alpha")])]);
    const decisions = conceptIdentityDecisions([source("a.md", [concept("Alpha")])], plan!);
    expect(supersededPageSlugs(new Set(["alpha"]), decisions).size).toBe(0);
  });
});
