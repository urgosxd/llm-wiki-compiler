/**
 * @file Pin the store-independent core of the semantic link-candidate report:
 * word-bounded lexical exclusion, threshold stratification, deterministic
 * sampling, and the single report row.
 *
 * WHY THIS FILE ASSERTS SURVIVING PAIRS, NOT LIST LENGTHS. The measurement this
 * core feeds only has value if the *incremental* set — the pairs no lexical
 * channel could have produced — is non-empty and correct. A report whose every
 * list is empty would satisfy any assertion written as `toHaveLength(0)`, so
 * every stratum here is pinned with a known pair placed at a known cosine:
 * `7 roles of the SGE (RBAC model)` is absent from its paragraph and present in
 * its document, sits at 0.912, and must come back out of the 0.86 stratum. An
 * implementation that returns no candidates fails that test.
 *
 * The tests are flat `it`s rather than grouped `describe`s because the house
 * `max-lines-per-function` rule counts a group body too, and a grouping that
 * only repeats the rule ID its own titles already carry is not worth an
 * exemption.
 *
 * Everything below is pure: no file read, no database, no argv, no clock, no
 * `Math.random`. The determinism assertions are therefore reproducible byte for
 * byte on any platform.
 */

import { expect, it } from "vitest";
import {
  DEFAULT_SAMPLE_SEED,
  formatCandidateRow,
  isLexicallyCovered,
  isSelfPair,
  nameAppearsInText,
  renderCandidatePair,
  sampleCandidates,
  stratifyCandidates,
  type RawCandidatePair,
  type RenderedCandidatePair,
  type StratumReport,
} from "./link-candidates.ts";

/**
 * Build a raw pair with every field defaulted, so each test states only the
 * inputs its rule is about.
 *
 * @param overrides - The fields this test cares about.
 * @returns A complete raw candidate pair.
 */
function makePair(overrides: Partial<RawCandidatePair> = {}): RawCandidatePair {
  return {
    corpus: "stack-28",
    paragraphId: "para-1",
    documentId: "pages/alpha",
    conceptId: "concepts/beta",
    conceptTitle: "Beta",
    conceptNames: ["Beta"],
    cosine: 0.9,
    paragraphText: "An unrelated paragraph.",
    documentText: "An unrelated document.",
    ...overrides,
  };
}

/**
 * The three strata, with their thresholds asserted before any test indexes them.
 *
 * The assertion comes first on purpose: an implementation that stratifies nothing
 * fails here as a value mismatch instead of as an `undefined` crash downstream.
 *
 * @param pairs - Raw pairs to stratify.
 * @returns The 0.86, 0.80 and 0.75 strata in that order.
 */
function threeStrata(pairs: readonly RawCandidatePair[]): readonly [StratumReport, StratumReport, StratumReport] {
  const reports = stratifyCandidates(pairs);
  expect(reports.map((report) => report.threshold)).toEqual([0.86, 0.8, 0.75]);
  const [top, mid, low] = reports;
  return [top, mid, low];
}

/** Stable identity of a candidate, for comparing draws without their payload. */
function idOf(candidate: RawCandidatePair): string {
  return `${candidate.paragraphId}/${candidate.conceptId}`;
}

/**
 * A rendered pool of `count` distinct candidates whose input order already IS the
 * deterministic order, so a sample that keeps the pool order proves the sampler
 * re-sorts nothing it should not.
 *
 * @param count - How many candidates to build.
 * @returns Rendered candidates at strictly descending cosines from 0.999.
 */
function orderedPool(count: number): RenderedCandidatePair[] {
  return Array.from({ length: count }, (_unused, index) =>
    renderCandidatePair(
      makePair({
        paragraphId: `para-${String(index).padStart(3, "0")}`,
        conceptId: `concepts/concept-${String(index).padStart(3, "0")}`,
        cosine: 0.999 - index / 1000,
        paragraphText: `Paragraph number ${index} says nothing relevant.`,
      }),
    ),
  );
}

/** Title of the known surviving concept: named in the document, never in its paragraph. */
const RBAC_TITLE = "7 roles of the SGE (RBAC model)";

/**
 * The known surviving pair: absent from its paragraph, mentioned in its document.
 *
 * @returns A raw pair at cosine 0.912, which no lexical channel would produce.
 */
function rbacPair(): RawCandidatePair {
  return makePair({
    paragraphId: "p-912",
    documentId: "pages/sge",
    conceptId: "concepts/rbac-model",
    conceptTitle: RBAC_TITLE,
    conceptNames: [RBAC_TITLE],
    cosine: 0.912,
    paragraphText: "The permission matrix is reviewed quarterly.",
    documentText: "This page explains the 7 roles of the SGE (RBAC model).",
  });
}

/**
 * One pair per stratum boundary, plus one just below the lowest threshold.
 *
 * @returns Raw pairs at 0.912, 0.86, 0.81, 0.76 and 0.74.
 */
function boundaryPairs(): RawCandidatePair[] {
  return [
    rbacPair(),
    makePair({ paragraphId: "p-860", conceptId: "c-860", conceptNames: ["Oficinas"], cosine: 0.86 }),
    makePair({
      paragraphId: "p-810",
      conceptId: "c-810",
      conceptNames: ["Oficinas"],
      cosine: 0.81,
      paragraphText: "The Oficinas list is here.",
    }),
    makePair({ paragraphId: "p-760", conceptId: "c-760", conceptNames: ["Portería"], cosine: 0.76 }),
    makePair({ paragraphId: "p-740", conceptId: "c-740", conceptNames: ["Vigilancia"], cosine: 0.74 }),
  ];
}

it("R1 nameAppearsInText matches a multi-token name inside a longer paragraph", () => {
  expect(nameAppearsInText("3 groups of Oficinas", "Offices are organized into 3 groups of Oficinas.")).toBe(true);
});

it("R1 nameAppearsInText is word-bounded: a name never matches inside a longer word", () => {
  expect(nameAppearsInText("role", "the controller")).toBe(false);
  // A raw substring test matches "api" inside "rapid"; a token sequence does not.
  expect(nameAppearsInText("API", "rapid")).toBe(false);
});

it("R1 nameAppearsInText folds the separators canonicalConceptKey folds and rejects degenerate names", () => {
  expect(nameAppearsInText("7 roles of the SGE", "7-roles-of-the-SGE")).toBe(true);
  expect(nameAppearsInText("", "any text at all")).toBe(false);
  expect(nameAppearsInText(" - ", "any text at all")).toBe(false);
});

it("R2 isLexicallyCovered covers a pair only when a name is in the paragraph, not when it is only in the document", () => {
  const inParagraph = makePair({
    conceptNames: ["Oficinas"],
    paragraphText: "The Oficinas list is here.",
    documentText: "",
  });
  const inDocumentOnly = makePair({
    conceptNames: ["Oficinas"],
    paragraphText: "We keep every office registry in one place.",
    documentText: "Registry of Oficinas.",
  });

  expect(isLexicallyCovered(inParagraph)).toBe(true);
  expect(isLexicallyCovered(inDocumentOnly)).toBe(false);
});

// FIXTURE-ONLY RESULT: no corpus in this assignment exposes declared aliases — the
// retired file corpus carried no alias field and the Postgres stacks carry no alias
// rows at all — so the alias branch of the exclusion is verified against this
// fixture and nothing else. It stays in the code because an alias the compiler does
// have must never be re-proposed as an incremental discovery, but the per-corpus
// report may not claim alias exclusion actually happened.
it("S4 alias coverage: a declared alias alone makes a pair lexically covered", () => {
  const aliasOnly = makePair({
    conceptTitle: "Service Desk",
    conceptNames: ["Service Desk", "Mesa de ayuda"],
    paragraphText: "La Mesa de ayuda atiende de 9 a 18.",
    documentText: "Service Desk",
  });

  expect(nameAppearsInText("Service Desk", aliasOnly.paragraphText)).toBe(false);
  expect(isLexicallyCovered(aliasOnly)).toBe(true);
});

it("R3 isSelfPair drops a paragraph's own page before stratification and never counts it", () => {
  const selfPair = makePair({ documentId: "concepts/oficinas", conceptId: "concepts/oficinas", cosine: 0.95 });
  expect(isSelfPair(selfPair)).toBe(true);
  expect(isSelfPair(makePair())).toBe(false);

  const [top] = threeStrata([selfPair, makePair({ paragraphId: "para-2", conceptId: "concepts/otro" })]);
  expect(top.candidateCount).toBe(1);
  expect(top.candidates.map((candidate) => candidate.conceptId)).toEqual(["concepts/otro"]);
});

it("R4 stratifyCandidates keeps the known non-lexical 0.912 pair in the 0.86 stratum", () => {
  const [top] = threeStrata([rbacPair()]);

  expect(top.candidateCount).toBe(1);
  expect(top.excludedByLexicalCount).toBe(0);
  expect(top.incrementalCount).toBe(1);
  expect(top.incremental.map(idOf)).toEqual(["p-912/concepts/rbac-model"]);
  const survivor = top.incremental[0];
  expect(survivor.cosine).toBe(0.912);
  expect(survivor.documentMention).toBe(true);
  expect(survivor.excerpt).toBe("The permission matrix is reviewed quarterly.");
});

it("R4 stratifyCandidates nests the strata at the inclusive boundaries 0.86, 0.80 and 0.75", () => {
  const [top, mid, low] = threeStrata(boundaryPairs());

  expect(top.candidates.map(idOf)).toEqual(["p-912/concepts/rbac-model", "p-860/c-860"]);
  expect(top.candidateCount).toBe(2);
  expect(top.excludedByLexicalCount).toBe(0);
  expect(top.incrementalCount).toBe(2);

  expect(mid.candidates.map(idOf)).toEqual(["p-912/concepts/rbac-model", "p-860/c-860", "p-810/c-810"]);
  expect(mid.candidateCount).toBe(3);
  expect(mid.excludedByLexicalCount).toBe(1);
  expect(mid.incrementalCount).toBe(2);
  expect(mid.incremental.map(idOf)).toEqual(["p-912/concepts/rbac-model", "p-860/c-860"]);

  expect(low.candidates.map(idOf)).toEqual([
    "p-912/concepts/rbac-model",
    "p-860/c-860",
    "p-810/c-810",
    "p-760/c-760",
  ]);
  expect(low.candidateCount).toBe(4);
  expect(low.excludedByLexicalCount).toBe(1);
  expect(low.incrementalCount).toBe(3);
});

it("R4 stratifyCandidates orders by cosine desc, then corpus, paragraphId and conceptId, ignoring input order", () => {
  const tied = 0.9;
  const unordered = [
    makePair({ corpus: "b", paragraphId: "p-2", conceptId: "c-1", cosine: tied }),
    makePair({ corpus: "a", paragraphId: "p-9", conceptId: "c-9", cosine: tied }),
    makePair({ corpus: "a", paragraphId: "p-1", conceptId: "c-2", cosine: tied }),
    makePair({ corpus: "a", paragraphId: "p-1", conceptId: "c-1", cosine: tied }),
    makePair({ corpus: "z", paragraphId: "p-0", conceptId: "c-0", cosine: 0.95 }),
  ];
  const expected = [
    ["z", "p-0", "c-0"],
    ["a", "p-1", "c-1"],
    ["a", "p-1", "c-2"],
    ["a", "p-9", "c-9"],
    ["b", "p-2", "c-1"],
  ];
  const identity = (candidate: RawCandidatePair): string[] => [
    candidate.corpus,
    candidate.paragraphId,
    candidate.conceptId,
  ];

  const [top] = threeStrata(unordered);
  expect(top.candidates.map(identity)).toEqual(expected);

  const [reversedTop] = threeStrata([...unordered].reverse());
  expect(reversedTop.candidates.map(identity)).toEqual(expected);
});

it("R6 sampleCandidates draws the same sample for the same seed regardless of input order", () => {
  const pool = orderedPool(50);
  const first = sampleCandidates(pool, 20, DEFAULT_SAMPLE_SEED);
  const second = sampleCandidates([...pool].reverse(), 20, DEFAULT_SAMPLE_SEED);

  expect(first).toHaveLength(20);
  expect(first.map(idOf)).not.toEqual(pool.slice(0, 20).map(idOf));
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
});

it("R6 sampleCandidates draws a different sample for a different seed", () => {
  const pool = orderedPool(50);
  expect(sampleCandidates(pool, 20, 1).map(idOf)).not.toEqual(sampleCandidates(pool, 20, 2).map(idOf));
});

it("R6 sampleCandidates returns the whole list when size exceeds it, and works with a seed of 0", () => {
  const pool = orderedPool(50).slice(0, 3);
  expect(sampleCandidates(pool, 20, 0).map(idOf)).toEqual(pool.map(idOf));
});

it("R6 sampleCandidates returns nothing for a size of zero", () => {
  expect(sampleCandidates(orderedPool(5), 0, DEFAULT_SAMPLE_SEED)).toEqual([]);
});

it("R6 sampleCandidates draws only from the stratum it is given", () => {
  const pairs = [
    ...orderedPool(1),
    renderCandidatePair(
      makePair({ paragraphId: "p-covered", conceptId: "c-covered", conceptNames: ["Beta"], paragraphText: "Beta." }),
    ),
  ];
  const [, mid] = threeStrata(pairs);
  const drawn = sampleCandidates(mid.incremental, 20, DEFAULT_SAMPLE_SEED);

  expect(mid.incremental.map(idOf)).toEqual(["para-000/concepts/concept-000"]);
  expect(drawn.map(idOf)).toEqual(["para-000/concepts/concept-000"]);
});

it("R7 formatCandidateRow renders one tab-separated line with the S6 fields and a truncated excerpt", () => {
  const candidate = renderCandidatePair(
    makePair({
      corpus: "stack-28",
      paragraphId: "p-1",
      conceptId: "c-1",
      cosine: 0.91234,
      conceptNames: ["Oficinas"],
      paragraphText: `Line one\n\nline two\t${"x".repeat(300)}`,
      documentText: "Oficinas.",
    }),
  );
  const row = formatCandidateRow(candidate);
  const fields = row.split("\t");

  expect(row.includes("\n")).toBe(false);
  expect(fields).toHaveLength(6);
  expect(fields.slice(0, 5)).toEqual(["stack-28", "p-1", "c-1", "0.9123", "yes"]);
  expect(fields[5]).toHaveLength(200);
  expect(fields[5].endsWith("…")).toBe(true);
  expect(fields[5].includes("  ")).toBe(false);
});
