/**
 * @file test/link-repair-morphology.test.ts
 * @description The repair resolver matches a link to its page across a
 * singular/plural boundary and across a `.md` that slugification swallowed.
 *
 * WHY THIS EXISTS. A real compile produced 15 broken links out of 185, and every
 * one was a link naming a page under a different INFLECTION: `[[graph]]` beside a
 * page slugged `graphs`, `[[weighted-graph]]` beside `weighted-graphs`. The
 * resolver only ever tried `target + "-"` as a prefix, so none of them matched and
 * the wiki's own navigation pointed at pages that did not exist.
 *
 * The rule the old resolver protected is kept intact here: an AMBIGUOUS target is
 * still left alone. A wrong link is worse than a visibly missing one, because a
 * missing link is a signal about the corpus and a wrong link is a lie.
 */
import { describe, expect, it } from "vitest";
import { createRepairResolver } from "../src/compiler/link-repair.js";

/** Resolve `target` against `slugs` with no pending candidates. */
function resolve(target: string, slugs: string[]): string | null {
  return createRepairResolver(slugs, new Set())(target);
}

describe("link repair — morphology", () => {
  it("resolves a singular link to the plural page", () => {
    expect(resolve("graph", ["graphs", "graph-theory"])).toBe("graphs");
  });

  it("resolves a plural link to the singular page", () => {
    expect(resolve("centrality-measures", ["centrality", "pagerank"])).toBeNull();
    expect(resolve("measures", ["measure"])).toBe("measure");
  });

  it("inflects only the LAST word, so distinct concepts stay distinct", () => {
    // `graph-theory` must not be reachable from `graphs-theory`: different concept.
    expect(resolve("graphs-theory", ["graph-theory"])).toBeNull();
    expect(resolve("weighted-graph", ["weighted-graphs"])).toBe("weighted-graphs");
  });

  it("handles -ies and -es plurals", () => {
    expect(resolve("policies", ["policy"])).toBe("policy");
    expect(resolve("benchmarks", ["benchmark"])).toBe("benchmark");
    expect(resolve("indexes", ["index"])).toBe("index");
  });

  it("prefers an EXACT slug over any inflection of it", () => {
    // `graph` is itself a page: hinting at `graphs` would be a guess, and a wrong
    // link is worse than none. The exact match wins without consulting morphology.
    expect(resolve("graph", ["graph", "graphs"])).toBe("graph");
  });

  it("still refuses an AMBIGUOUS inflection when no exact slug matches", () => {
    // `node` pluralises to BOTH `nodes` and `node-es`, and both are pages: two
    // candidates, no answer. A guess here would link to the wrong concept.
    expect(resolve("matrixes", ["matrix", "matrixe"])).toBeNull();
  });

  it("recovers a link whose `.md` slugification swallowed", () => {
    // `slugify("algorithms.md")` drops the dot and yields `algorithmsmd`.
    expect(resolve("algorithmsmd", ["algorithms"])).toBe("algorithms");
    expect(resolve("notesmd", ["notes"])).toBe("notes");
  });

  it("leaves a genuinely missing target alone", () => {
    expect(resolve("kubernetes", ["graphs", "pagerank"])).toBeNull();
  });

  it("keeps the original unique-prefix rule working", () => {
    expect(resolve("argo-cd", ["argo-cd-image-update-ownership-model"])).toBe(
      "argo-cd-image-update-ownership-model",
    );
  });
});
