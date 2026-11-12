/**
 * @file Pin the two rules the database layer is allowed to assert WITHOUT a
 * database: the inversion from per-concept rankings to per-paragraph top-k pairs,
 * and the redaction that keeps a connection string out of everything the command
 * emits.
 *
 * WHY THE INVERSION IS PINNED HERE AND NOWHERE ELSE. The ranking itself is the
 * query path's own (`rankChunksInSql`), so a test that re-derived cosines would be
 * testing a second implementation of it. What is genuinely new in this layer is the
 * transposition: a concept's stored vector is used as the QUERY, so the rows come
 * back keyed by paragraph and have to be turned back into (paragraph → concept)
 * pairs. Both of the ways that can go silently wrong are asserted below with real
 * values, never with an empty result:
 *
 * - a page is always closest to itself, so the self-hit is the FIRST row of nearly
 *   every ranking. If it is filtered after the top-k cut instead of before, it burns
 *   the slot and the concept's best genuine neighbour disappears. The fixture puts
 *   the self-hit at the top and asks for `topK = 1`: an implementation that cuts
 *   first returns nothing, and one that filters first returns the neighbour.
 * - equal cosines are common (a 768-dimensional dot product rounds), so the order
 *   has to be total for two runs of the same corpus to produce the same report.
 */

import { expect, it } from "vitest";

import {
  redactSecrets,
  topConceptsPerParagraph,
  type ConceptChunkRanking,
} from "./link-candidates-db.ts";

/**
 * Build a concept ranking, defaulting every field a test does not state.
 *
 * @param overrides - The fields this test cares about.
 * @returns A complete ranking.
 */
function ranking(overrides: Partial<ConceptChunkRanking> = {}): ConceptChunkRanking {
  return {
    conceptId: "concepts/alpha",
    conceptTitle: "Alpha",
    hits: [],
    ...overrides,
  };
}

it("drops a concept's own page before the top-k cut, so the self-hit cannot take the slot", () => {
  const rankings = [
    ranking({
      conceptId: "concepts/alpha",
      conceptTitle: "Alpha",
      hits: [
        { pageDirectory: "concepts", slug: "alpha", chunkIndex: 0, cosine: 1 },
        { pageDirectory: "concepts", slug: "beta", chunkIndex: 1, cosine: 0.9 },
      ],
    }),
  ];

  expect(topConceptsPerParagraph(rankings, 1)).toEqual([
    {
      paragraphId: "concepts/beta#1",
      documentId: "concepts/beta",
      conceptId: "concepts/alpha",
      conceptTitle: "Alpha",
      cosine: 0.9,
    },
  ]);
});

it("keeps at most top-k concepts per paragraph, highest cosine first", () => {
  const rankings = [
    ranking({
      conceptId: "concepts/alpha",
      conceptTitle: "Alpha",
      hits: [{ pageDirectory: "pages", slug: "target", chunkIndex: 0, cosine: 0.91 }],
    }),
    ranking({
      conceptId: "concepts/beta",
      conceptTitle: "Beta",
      hits: [{ pageDirectory: "pages", slug: "target", chunkIndex: 0, cosine: 0.83 }],
    }),
    ranking({
      conceptId: "concepts/gamma",
      conceptTitle: "Gamma",
      hits: [{ pageDirectory: "pages", slug: "target", chunkIndex: 0, cosine: 0.77 }],
    }),
  ];

  expect(topConceptsPerParagraph(rankings, 2).map((pair) => pair.conceptId)).toStrictEqual([
    "concepts/alpha",
    "concepts/beta",
  ]);
  expect(topConceptsPerParagraph(rankings, 3)).toHaveLength(3);
});

it("breaks an equal cosine on conceptId ascending, and orders the output by paragraph then concept", () => {
  const rankings = [
    ranking({
      conceptId: "concepts/zeta",
      conceptTitle: "Zeta",
      hits: [{ pageDirectory: "concepts", slug: "gamma", chunkIndex: 0, cosine: 0.85 }],
    }),
    ranking({
      conceptId: "concepts/alpha",
      conceptTitle: "Alpha",
      hits: [
        { pageDirectory: "concepts", slug: "gamma", chunkIndex: 0, cosine: 0.85 },
        { pageDirectory: "concepts", slug: "beta", chunkIndex: 2, cosine: 0.95 },
      ],
    }),
  ];

  expect(
    topConceptsPerParagraph(rankings, 5).map((pair) => `${pair.paragraphId}<-${pair.conceptId}`),
  ).toStrictEqual([
    "concepts/beta#2<-concepts/alpha",
    "concepts/gamma#0<-concepts/alpha",
    "concepts/gamma#0<-concepts/zeta",
  ]);
});

it("returns an empty list for an empty ranking set", () => {
  expect(topConceptsPerParagraph([], 15)).toEqual([]);
});

it("redacts a connection string completely, user and password included", () => {
  const redacted = redactSecrets(
    "connect failed for postgresql://measure:sup3r-s3cret@db.internal:5432/aks after 3 tries",
  );

  expect(redacted).toBe("connect failed for postgresql://*** after 3 tries");
  expect(redacted).not.toContain("measure");
  expect(redacted).not.toContain("sup3r-s3cret");
  expect(redacted).not.toContain("db.internal");
});

it("redacts the postgres:// spelling too, and leaves text without a DSN untouched", () => {
  expect(redactSecrets("postgres://u:p@localhost:5434/aks")).toBe("postgresql://***");
  expect(redactSecrets("EMPTY CORPUS wiki-28: no chunk embeddings")).toBe(
    "EMPTY CORPUS wiki-28: no chunk embeddings",
  );
});
