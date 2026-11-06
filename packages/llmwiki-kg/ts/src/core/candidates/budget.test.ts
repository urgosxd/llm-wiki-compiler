/**
 * @file packages/llmwiki-kg/ts/src/core/candidates/budget.test.ts
 * @description The bounded budget: what it collapses, what it truncates, and what it reports.
 *
 * WHY THIS FILE EXISTS. A cap that truncates without a record is exactly the
 * silent limit S9 forbids, and a dedup key that folds too much erases a distinct
 * predicate. Every case below drives the public ledger and the public dedup key,
 * so what a run dropped is observable without reading the implementation.
 */

import { describe, expect, it } from "vitest";

import { candidateDedupKey, createCandidateLedger, mergeCandidateAccounting } from "./budget.js";
import { parseCandidates } from "./parse.js";
import type { CandidateSet, CandidateSource } from "./types.js";

/** The provenance every set below carries unless a test overrides the document. */
const SOURCE: CandidateSource = { documentId: "doc-1", chunkId: "chunk-1", chunkIndex: 0 };

/** One relation as the model would report it. */
interface RawRelation {
  readonly from: string;
  readonly to: string;
  readonly predicate: string;
}

/** Builds a parsed candidate set for one chunk. */
function set(
  entities: readonly string[],
  relations: readonly RawRelation[] = [],
  chunkIndex = 0,
): CandidateSet {
  const raw = JSON.stringify({
    entities: entities.map((name) => ({ name })),
    relations,
  });
  return parseCandidates(raw, { ...SOURCE, chunkIndex });
}

describe("candidateDedupKey", () => {
  it("keys a relation by document, endpoints and predicate, keeping predicates apart", () => {
    const relations = parseCandidates(
      JSON.stringify({
        entities: [{ name: "A" }, { name: "B" }],
        relations: [
          { from: "A", to: "B", predicate: "invalidates" },
          { from: "A", to: "B", predicate: "deja sin efecto" },
        ],
      }),
      SOURCE,
    ).relations;
    const [first, second] = relations;
    expect(candidateDedupKey(first!)).not.toBe(candidateDedupKey(second!));
    expect(candidateDedupKey(first!)).toContain("doc-1");
  });

  it("keys an entity by document and folded name, so one name in two documents stays two", () => {
    const entityIn = (documentId: string): string => {
      const parsed = parseCandidates(
        JSON.stringify({ entities: [{ name: "Gateway" }], relations: [] }),
        { ...SOURCE, documentId },
      );
      return candidateDedupKey(parsed.entities[0]!);
    };
    expect(entityIn("doc-1")).toBe(entityIn("doc-1"));
    expect(entityIn("doc-1")).not.toBe(entityIn("doc-2"));
  });
});

describe("createCandidateLedger", () => {
  it("collapses an exact repeat from a second pass and keeps distinct predicates apart", () => {
    const ledger = createCandidateLedger();
    const first = ledger.admit(
      set(["A", "B"], [
        { from: "A", to: "B", predicate: "deja sin efecto" },
        { from: "A", to: "B", predicate: "modifies" },
      ]),
    );
    const second = ledger.admit(
      set(["A", "B"], [{ from: "A", to: "B", predicate: "Deja  sin efecto" }]),
    );
    expect(first.relations.map((relation) => relation.predicate)).toEqual([
      "deja sin efecto",
      "modifies",
    ]);
    expect(second.relations).toEqual([]);
    expect(second.accounting.duplicates).toBe(3);
    expect(ledger.summary().keptRelations).toBe(2);
  });

  it("emits a chunk truncation record naming the limit and the dropped count", () => {
    const ledger = createCandidateLedger({ perChunkLimit: 2, perDocumentLimit: 100 });
    const admitted = ledger.admit(set(["A", "B", "C"]));
    expect(admitted.entities.map((entity) => entity.name)).toEqual(["A", "B"]);
    expect(admitted.accounting.truncations).toEqual([
      { scope: "chunk", documentId: "doc-1", chunkIndex: 0, limit: 2, dropped: 1 },
    ]);
  });

  it("emits a document truncation record once the run-wide cap is reached", () => {
    const ledger = createCandidateLedger({ perChunkLimit: 10, perDocumentLimit: 3 });
    ledger.admit(set(["A", "B"]));
    const second = ledger.admit(set(["C", "D"], [], 1));
    expect(second.entities.map((entity) => entity.name)).toEqual(["C"]);
    expect(second.accounting.truncations).toEqual([
      { scope: "document", documentId: "doc-1", chunkIndex: null, limit: 3, dropped: 1 },
    ]);
    expect(ledger.summary().truncated).toBe(true);
  });

  it("summarizes several chunks with their counts, rejections and budgets", () => {
    const ledger = createCandidateLedger();
    ledger.admit(set(["A"], [{ from: "A", to: "Undeclared", predicate: "reviews" }]));
    ledger.admit(set(["C", "D"], [], 1));
    const summary = ledger.summary();
    expect(summary.chunks).toHaveLength(2);
    expect(summary.keptEntities).toBe(3);
    expect(summary.rejections).toBe(1);
    expect(summary.truncated).toBe(false);
    expect(summary.budgets).toEqual({ perChunkLimit: 50, perDocumentLimit: 500 });
  });

  it("refuses a second document, because the document cap is a per-document budget", () => {
    const ledger = createCandidateLedger();
    ledger.admit(set(["A"]));
    const otherDocument = { ...SOURCE, documentId: "doc-2" };
    expect(() =>
      ledger.admit(
        parseCandidates(JSON.stringify({ entities: [{ name: "Z" }], relations: [] }), otherDocument),
      ),
    ).toThrow(/one document/);
  });
});

describe("mergeCandidateAccounting", () => {
  it("merges several per-document summaries into one run summary", () => {
    const budgets = { perChunkLimit: 1, perDocumentLimit: 100 };
    const first = createCandidateLedger(budgets);
    first.admit(set(["A", "B"]));
    const second = createCandidateLedger(budgets);
    second.admit(set(["C"], [], 1));
    const merged = mergeCandidateAccounting([first.summary(), second.summary()]);
    expect(merged.chunks).toHaveLength(2);
    expect(merged.keptEntities).toBe(2);
    expect(merged.truncationsDropped).toBe(1);
    expect(merged.truncated).toBe(true);
    expect(merged.budgets).toEqual(budgets);
  });

  it("refuses to merge summaries produced under different budgets", () => {
    const wide = createCandidateLedger({ perChunkLimit: 10, perDocumentLimit: 10 });
    const narrow = createCandidateLedger({ perChunkLimit: 5, perDocumentLimit: 10 });
    expect(() => mergeCandidateAccounting([wide.summary(), narrow.summary()])).toThrow(
      /different budgets/,
    );
  });
});
