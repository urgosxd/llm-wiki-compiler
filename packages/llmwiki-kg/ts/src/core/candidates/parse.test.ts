/**
 * @file packages/llmwiki-kg/ts/src/core/candidates/parse.test.ts
 * @description What a raw model response becomes, and what the parser may not invent.
 *
 * WHY THIS FILE EXISTS. Parsing is the only place where a model's words become
 * candidates, so it is the only place that could invent one: a type nobody
 * proposed, a generic predicate, an entity that appears nowhere in the answer.
 * Every case below drives the public `parseCandidates` entry point and asserts one
 * of those non-inventions, because a repair a caller cannot see is the same as a
 * silent one.
 */

import { describe, expect, it } from "vitest";

import { parseCandidates } from "./parse.js";
import type { CandidateSet, CandidateSource } from "./types.js";

/** The provenance every parsed candidate must carry. */
const SOURCE: CandidateSource = { documentId: "doc-1", chunkId: "chunk-1", chunkIndex: 2 };

/** Renders a model response in the shape the open-extraction contract asks for. */
function response(entities: readonly unknown[], relations: readonly unknown[]): string {
  return JSON.stringify({ entities, relations });
}

/** Parses an entity-only response. */
function parseEntities(entities: readonly unknown[]): CandidateSet {
  return parseCandidates(response(entities, []), SOURCE);
}

describe("parseCandidates", () => {
  it("keeps a proposed type no catalog declares, verbatim", () => {
    const set = parseEntities([
      {
        name: " Auditoría interna ",
        type: "NormativeProcedure",
        description: "Revisión anual del cumplimiento normativo.",
        properties: [{ name: "periodicidad", value: "anual" }],
      },
    ]);
    const entity = set.entities[0];
    expect(set.rejections).toEqual([]);
    expect(entity?.name).toBe("Auditoría interna");
    expect(entity?.proposedType).toBe("NormativeProcedure");
    expect(entity?.properties).toEqual([{ name: "periodicidad", value: "anual" }]);
  });

  it("returns entities and zero relations for a chunk with no relationship", () => {
    const set = parseEntities([
      { name: "Comité de cambios", type: "Role" },
      { name: "Política de acceso", type: null },
    ]);
    expect(set.entities.map((entity) => entity.name)).toEqual([
      "Comité de cambios",
      "Política de acceso",
    ]);
    expect(set.relations).toEqual([]);
    expect(set.rejections).toEqual([]);
  });

  it("preserves the original predicate instead of normalizing or replacing it", () => {
    const set = parseCandidates(
      response(
        [{ name: "Resolución 12" }, { name: "Política 4" }],
        [{ from: "Resolución 12", to: "Política 4", predicate: "deja sin efecto" }],
      ),
      SOURCE,
    );
    expect(set.relations).toHaveLength(1);
    expect(set.relations[0]?.fromName).toBe("Resolución 12");
    expect(set.relations[0]?.toName).toBe("Política 4");
    expect(set.relations[0]?.predicate).toBe("deja sin efecto");
  });

  it("rejects a relation with an undeclared endpoint and creates no entity for it", () => {
    const set = parseCandidates(
      response(
        [{ name: "Resolución 12", type: "Document" }],
        [{ from: "Resolución 12", to: "Proceso X", predicate: "deja sin efecto" }],
      ),
      SOURCE,
    );
    expect(set.entities.map((entity) => entity.name)).toEqual(["Resolución 12"]);
    expect(set.relations).toEqual([]);
    expect(set.rejections).toEqual([
      {
        candidateKind: "relationship",
        reason: "undeclared_endpoint",
        offending: ["Proceso X"],
        source: SOURCE,
      },
    ]);
  });

  it("keeps optional parts missing instead of inventing them", () => {
    const set = parseEntities([{ name: "Proceso de revisión" }]);
    const entity = set.entities[0];
    expect(entity?.proposedType).toBeNull();
    expect(entity?.description).toBeNull();
    expect(entity?.properties).toEqual([]);
    expect(set.rejections).toEqual([]);
  });

  it("rejects a relation with no predicate instead of supplying a generic one", () => {
    const set = parseCandidates(response([{ name: "A" }, { name: "B" }], [{ from: "A", to: "B" }]), SOURCE);
    expect(set.relations).toEqual([]);
    expect(set.rejections).toEqual([
      {
        candidateKind: "relationship",
        reason: "missing_predicate",
        offending: ["A", "B"],
        source: SOURCE,
      },
    ]);
  });

  it("rejects an entity that carries no name", () => {
    const set = parseEntities([{ name: "   ", type: "Role" }]);
    expect(set.entities).toEqual([]);
    expect(set.rejections[0]?.candidateKind).toBe("entity");
    expect(set.rejections[0]?.reason).toBe("missing_name");
  });

  it("carries the source document, chunk id and chunk index on every candidate", () => {
    const set = parseCandidates(
      response([{ name: "A" }, { name: "B" }], [{ from: "A", to: "B", predicate: "executes" }]),
      SOURCE,
    );
    expect([...set.entities, ...set.relations].map((candidate) => candidate.source)).toEqual([
      SOURCE,
      SOURCE,
      SOURCE,
    ]);
  });

  it("tolerates a response wrapped in prose and gives every candidate a distinct ref", () => {
    const raw = `Here you go: ${response(
      [{ name: "A" }, { name: "B" }],
      [{ from: "A", to: "B", predicate: "reviews" }],
    )} — done`;
    const set = parseCandidates(raw, SOURCE);
    const refs = [...set.entities, ...set.relations].map((candidate) => candidate.ref);
    expect(refs).toHaveLength(3);
    expect(new Set(refs).size).toBe(3);
  });
});
