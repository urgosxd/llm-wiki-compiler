/**
 * @file packages/llmwiki-kg/ts/src/core/eval/load.test.ts
 * @description The shipped labeled set must parse, and every entry must carry the
 * labels the scorers read.
 *
 * A labeled set is data that a measurement depends on, so the failure this file
 * guards against is not "the parser throws" but "an entry quietly lost a label and
 * every metric kept being computed from the remaining ones". The cases the request
 * names — an entity that fits the catalog, a supported entity that fits nothing, an
 * ambiguous case, a predicate that normalizes to a canonical relation, a free
 * predicate that must survive verbatim, and a quote that exists but does not support
 * the claim — are asserted as CONTENT, so the set cannot shrink into something that
 * no longer measures what it was built for.
 */

import { describe, expect, it } from "vitest";
import { EvalSetError, loadEvalSet, parseEvalSet } from "./load.js";
import type { RelationExample } from "./types.js";

/** The shipped set, loaded once: it is static data committed beside the code. */
const SHIPPED = loadEvalSet();

/**
 * Finds the one relation example carrying a predicate.
 *
 * @param predicate - The original predicate to look for.
 * @returns The labeled relation example, or `undefined`.
 */
function findByPredicate(predicate: string): RelationExample | undefined {
  return SHIPPED.examples.find(
    (example): example is RelationExample => example.kind === "relation" && example.candidate?.predicate === predicate,
  );
}

describe("shipped labeled set", () => {
  it("parses and holds a small realistic set", () => {
    expect(SHIPPED.version).toMatch(/@\d+\.\d+\.\d+$/);
    expect(SHIPPED.examples.length).toBeGreaterThanOrEqual(10);
    expect(new Set(SHIPPED.examples.map((example) => example.id)).size).toBe(SHIPPED.examples.length);
  });

  it("labels every entry on both axes and both languages", () => {
    for (const example of SHIPPED.examples) {
      expect(example.source.length).toBeGreaterThan(0);
      expect(example.quote.length).toBeGreaterThan(0);
      expect(example.claim.length).toBeGreaterThan(0);
      expect(example.labels.canonical.length).toBeGreaterThan(0);
      expect(["supported", "unsupported"]).toContain(example.labels.support);
      expect(["entity", "relation"]).toContain(example.kind);
    }
    expect(new Set(SHIPPED.examples.map((example) => example.language))).toEqual(new Set(["es", "en"]));
  });

  it("covers the cases the request names", () => {
    const canonicalEntities = SHIPPED.examples.filter(
      (example) => example.kind === "entity" && example.labels.canonical !== "NO_MATCH",
    );
    const freeButSupported = SHIPPED.examples.filter(
      (example) => example.extracted && example.labels.canonical === "NO_MATCH" && example.labels.support === "supported",
    );
    const ambiguous = SHIPPED.examples.filter((example) => example.labels.canonical === "UNCERTAIN");
    const normalizedRelation = SHIPPED.examples.filter(
      (example) => example.kind === "relation" && example.labels.canonical === "executes",
    );
    const unsupported = SHIPPED.examples.filter((example) => example.labels.support === "unsupported");
    expect(canonicalEntities.length).toBeGreaterThan(0);
    expect(freeButSupported.length).toBeGreaterThan(0);
    expect(ambiguous.length).toBeGreaterThan(0);
    expect(normalizedRelation.length).toBeGreaterThan(0);
    expect(unsupported.length).toBeGreaterThan(0);
  });

  it("keeps the free predicate verbatim in the candidate the extractor emitted", () => {
    const example = findByPredicate("deja sin efecto");
    expect(example?.labels.canonical).toBe("NO_MATCH");
    expect(example?.candidate?.predicate).toBe("deja sin efecto");
  });

  it("records extractor misses as labeled facts the extractor never produced", () => {
    const omitted = SHIPPED.examples.filter((example) => !example.extracted);
    expect(omitted.length).toBeGreaterThan(0);
    for (const example of omitted) {
      expect(example.candidate).toBeUndefined();
      expect(example.recorded).toBeUndefined();
      expect(example.fact).toBeDefined();
    }
  });
});

describe("parseEvalSet", () => {
  it("refuses an entry with no labels, naming it", () => {
    const broken = { version: "v@1.0.0", examples: [{ id: "no-labels", kind: "entity", extracted: false }] };
    expect(() => parseEvalSet(broken)).toThrow(EvalSetError);
    expect(() => parseEvalSet(broken)).toThrow(/no-labels/);
  });

  it("refuses duplicate ids and an empty set", () => {
    const entry = {
      id: "dup",
      language: "en",
      kind: "entity",
      source: "s",
      quote: "q",
      claim: "c",
      extracted: false,
      fact: { name: "n" },
      labels: { canonical: "Role", support: "supported" },
    };
    expect(() => parseEvalSet({ version: "v@1.0.0", examples: [entry, entry] })).toThrow(/dup/);
    expect(() => parseEvalSet({ version: "v@1.0.0", examples: [] })).toThrow(EvalSetError);
  });
});
