/**
 * @file packages/llmwiki-kg/ts/src/core/open-extraction-contract.test.ts
 * @description The OPEN extraction contract: the catalog orients, and caps report themselves.
 *
 * WHY THIS FILE EXISTS. Two behaviours that used to be closed are now open, and a
 * third that used to be silent now speaks.
 *
 * - The declared catalog used to be an admission filter in TWO places: an `enum`
 *   in the tool schema, which a schema-honouring provider cannot leave, and
 *   `rejectTriplet`, which drops the triplet afterwards. `strict=False` does not
 *   repair either, because it is a flag on a library this port no longer calls.
 *   Openness therefore has to live in the schema and in the instruction text, and
 *   both are asserted here (S7).
 * - A triplet whose entity type or predicate the declaration does not name must
 *   survive with its own wording intact — "deja sin efecto" is knowledge, not an
 *   error (S1, S3, S31).
 * - The per-chunk triplet budget used to be a number only the prompt knew about,
 *   so a truncated answer was indistinguishable from a thin one. Any cap applied
 *   while parsing now returns a record naming the limit and the drop count (S9).
 *
 * ## What must NOT move
 *
 * The strict path is the regression boundary. `buildToolSchema`, the pinned
 * prompt bytes, `parseTripletsWithOntology` and `admitStandaloneEntities` keep
 * their exact behaviour, and the last three tests here re-assert it so a later
 * attempt to "open everything" fails loudly instead of quietly redefining what a
 * caller's declaration means.
 */

import { describe, expect, it } from "vitest";

import {
  buildExtractionPrompt,
  buildOpenExtractionPrompt,
  buildOpenToolSchema,
  buildToolSchema,
  capTripletsPerChunk,
  DEFAULT_MAX_TRIPLETS_PER_CHUNK,
} from "./graph-prompt.js";
import { parseStandaloneEntities, parseTriplets } from "./graph-parse.js";
import { admitOpenTriplets } from "./open-admission.js";
import {
  admitStandaloneEntities,
  parseTripletsWithOntology,
  validateOntology,
} from "./ontology.js";

/** Two entity kinds and one edge kind, deliberately different in shape. */
const ONTOLOGY = validateOntology({
  entityTypes: ["ORGANIZATION", "PERSON"],
  relationshipTypes: ["WORKS_AT"],
});

/** The two `type` fields of a tool schema, as the model reads them. */
interface TypeFieldView {
  readonly type?: string;
  readonly description: string;
  readonly enum?: readonly string[];
}

function typeFields(schema: ReturnType<typeof buildOpenToolSchema>): {
  entity: TypeFieldView;
  relation: TypeFieldView;
} {
  // Narrowed through `unknown` because `$defs` also holds `Triplet`, whose
  // properties are `$ref`s rather than type fields.
  const defs = schema.parameters.$defs as unknown as Record<
    string,
    { properties: Record<string, TypeFieldView> }
  >;
  return {
    entity: defs["Entity"]?.properties["type"] ?? { description: "" },
    relation: defs["Relation"]?.properties["type"] ?? { description: "" },
  };
}

/** A tool payload with the given triplet and entity entries. */
function payload(triplets: readonly unknown[], entities: readonly unknown[] = []): string {
  return JSON.stringify({ triplets, entities });
}

/** One well-formed triplet, as the model writes it. */
function edge(subjectType: string, relationType: string, objectType: string): Record<string, unknown> {
  return {
    subject: { type: subjectType, name: "Acme" },
    relation: { type: relationType },
    object: { type: objectType, name: "Globex" },
  };
}

describe("the open tool schema keeps the catalog as orientation", () => {
  it("drops the enum that made an out-of-catalog type unemittable", () => {
    const { entity, relation } = typeFields(buildOpenToolSchema(ONTOLOGY));

    // An `enum` is the filter: a strict provider cannot return a value outside it.
    expect(entity).not.toHaveProperty("enum");
    expect(relation).not.toHaveProperty("enum");
    expect(entity.type).toBe("string");
  });

  it("names the declared types as orientation, not as an admission filter", () => {
    const { entity, relation } = typeFields(buildOpenToolSchema(ONTOLOGY));

    expect(entity.description).toContain("'ORGANIZATION'");
    expect(entity.description).toContain("ORIENTATION");
    expect(entity.description).toContain("propose your own type");
    expect(relation.description).toContain("'WORKS_AT'");
    expect(relation.description).toContain("propose your own predicate");
    // The oracle's default hints must still be replaced by a declaration.
    expect(entity.description).not.toContain("'PRODUCT'");
  });

  it("keeps the schema structure identical to the strict schema", () => {
    const open = buildOpenToolSchema(ONTOLOGY);
    const strict = buildToolSchema(ONTOLOGY);

    expect(open.name).toBe(strict.name);
    expect(open.description).toBe(strict.description);
    expect(open.parameters.required).toEqual(strict.parameters.required);
    expect(Object.keys(open.parameters.$defs)).toEqual(Object.keys(strict.parameters.$defs));
    expect(open.parameters.$defs.Triplet).toEqual(strict.parameters.$defs.Triplet);
    expect(open.parameters.additionalProperties).toBe(false);
    expect(Object.keys(open.parameters.properties)).toEqual(["triplets", "entities"]);
  });

  it("leaves the strict schema exactly as it was", () => {
    // The declared-only contract stays available and byte-identical: this is the
    // behaviour a caller who wants a closed graph keeps.
    expect(typeFields(buildToolSchema(ONTOLOGY)).entity.enum).toEqual([
      "ORGANIZATION",
      "PERSON",
    ]);
    expect(typeFields(buildToolSchema(ONTOLOGY)).relation.enum).toEqual(["WORKS_AT"]);
  });
});

describe("the open extraction prompt treats the catalog as orientation", () => {
  it("tells the model to propose its own wording instead of dropping a fact", () => {
    const prompt = buildOpenExtractionPrompt("body", 0, "demo", ONTOLOGY);

    expect(prompt).toContain("ORIENTATION");
    expect(prompt).toContain("never an admission filter");
    expect(prompt).toContain("propose your own wording");
    // The strict prompt's "only extract ... listed as valid" idea must be gone.
    expect(prompt).not.toContain("Only extract");
  });

  it("renders the declared catalog as orientation text", () => {
    const prompt = buildOpenExtractionPrompt("body", 0, "demo", ONTOLOGY);

    expect(prompt).toContain("Catalog (orientation only)");
    expect(prompt).toContain("'ORGANIZATION'");
    expect(prompt).toContain("'WORKS_AT'");
    expect(prompt).toContain("chunk_index: 0\nstack_name: demo\n\nbody");
  });

  it("honours a configured per-chunk triplet budget", () => {
    expect(buildOpenExtractionPrompt("body", 0, "demo", ONTOLOGY, { maxTripletsPerChunk: 7 }))
      .toContain("output 7 extracted triplets");
    expect(buildExtractionPrompt("body", 0, "demo", undefined, { maxTripletsPerChunk: 7 }))
      .toContain("output 7 extracted triplets");
    expect(DEFAULT_MAX_TRIPLETS_PER_CHUNK).toBe(20);
  });

  it("leaves the default strict prompt byte for byte as it was", () => {
    expect(buildExtractionPrompt("body", 0, "demo")).toBe(
      "Given the following text, extract the knowledge graph according to the provided schema. " +
        "Try to limit to the output 20 extracted triplets\n" +
        "-------\n" +
        "chunk_index: 0\nstack_name: demo\n\nbody\n" +
        "-------\n",
    );
  });
});

describe("the per-chunk triplet cap reports what it drops", () => {
  it("reports no truncation when nothing is dropped", () => {
    const capped = capTripletsPerChunk([1, 2, 3]);

    expect(capped.triplets).toEqual([1, 2, 3]);
    expect(capped.truncation).toBeUndefined();
  });

  it("emits a truncation record naming the limit and the dropped count", () => {
    const capped = capTripletsPerChunk(Array.from({ length: 23 }, (_, i) => i), {
      chunkIndex: 4,
    });

    expect(capped.triplets).toHaveLength(DEFAULT_MAX_TRIPLETS_PER_CHUNK);
    expect(capped.truncation).toEqual({
      scope: "chunk",
      chunkIndex: 4,
      limit: DEFAULT_MAX_TRIPLETS_PER_CHUNK,
      considered: 23,
      dropped: 3,
    });
  });

  it("rejects a limit that is not a non-negative integer", () => {
    expect(() => capTripletsPerChunk([1], { maxTripletsPerChunk: -1 })).toThrow(RangeError);
    expect(() => capTripletsPerChunk([1], { maxTripletsPerChunk: 1.5 })).toThrow(/non-negative/);
  });

  it("applies the cap while admitting a chunk and reports it", () => {
    const many = Array.from({ length: 25 }, () => edge("ORGANIZATION", "WORKS_AT", "PERSON"));
    const admitted = admitOpenTriplets(payload(many), ONTOLOGY, { chunkIndex: 2 });

    expect(admitted.triplets).toHaveLength(20);
    expect(admitted.truncation).toEqual({
      scope: "chunk",
      chunkIndex: 2,
      limit: 20,
      considered: 25,
      dropped: 5,
    });
  });
});

describe("an out-of-catalog proposal is admitted, not filtered", () => {
  it("keeps a triplet whose entity type the declaration does not name", () => {
    const admitted = admitOpenTriplets(payload([edge("UNICORN", "WORKS_AT", "PERSON")]), ONTOLOGY);

    expect(admitted.rejected).toEqual([]);
    expect(admitted.triplets).toHaveLength(1);
    expect(admitted.triplets[0]?.subjectType).toBe("UNICORN");
    expect(admitted.outsideCatalog).toEqual([
      { kind: "entity_type", of: "Acme", proposed: "UNICORN" },
    ]);
  });

  it("keeps a triplet whose predicate the declaration does not name", () => {
    const admitted = admitOpenTriplets(
      payload([edge("ORGANIZATION", "deja sin efecto", "PERSON")]),
      ONTOLOGY,
    );

    expect(admitted.rejected).toEqual([]);
    expect(admitted.triplets[0]?.relationType).toBe("DEJA_SIN_EFECTO");
    expect(admitted.outsideCatalog).toEqual([
      { kind: "predicate", of: "Acme -> Globex", proposed: "DEJA_SIN_EFECTO" },
    ]);
  });

  it("admits a standalone entity whose type the declaration does not name", () => {
    const admitted = admitOpenTriplets(payload([], [{ type: "POLICY_HOLDER", name: "Ada" }]), ONTOLOGY);

    expect(admitted.triplets).toEqual([]);
    expect(admitted.entities).toEqual([{ name: "Ada", type: "POLICY_HOLDER" }]);
  });
});

describe("structural faults are still refused, with a reason", () => {
  it("refuses a triplet with a missing endpoint and keeps the endpoint it has", () => {
    const halfEdge = { subject: { type: "ORGANIZATION", name: "Acme" }, relation: { type: "WORKS_AT" } };
    const admitted = admitOpenTriplets(payload([halfEdge]), ONTOLOGY);

    expect(admitted.triplets).toEqual([]);
    expect(admitted.rejected).toEqual([
      { subject: "Acme", relation: "WORKS_AT", object: "", reason: "MISSING_ENDPOINT", offendingType: "object" },
    ]);
    // The endpoint the model did state is real knowledge and survives as a node.
    expect(admitted.rescued).toEqual([{ name: "Acme", type: "ORGANIZATION" }]);
  });

  it("refuses a triplet with a missing predicate and keeps both endpoints", () => {
    const noVerb = {
      subject: { type: "ORGANIZATION", name: "Acme" },
      relation: {},
      object: { type: "PERSON", name: "Globex" },
    };
    const admitted = admitOpenTriplets(payload([noVerb]), ONTOLOGY);

    expect(admitted.triplets).toEqual([]);
    expect(admitted.rejected[0]?.reason).toBe("MISSING_PREDICATE");
    expect(admitted.rejected[0]?.offendingType).toBe("relation");
    expect(admitted.rescued).toHaveLength(2);
  });
});

describe("the open path never bends what the strict path refuses", () => {
  it("does not use endpoint-type compatibility as an admission rule", () => {
    // Schema compatibility is a separate verdict (compatible / conflict /
    // indeterminate) recorded by the classification stage. A supported fact that
    // conflicts with the catalog is kept WITH the conflict, never dropped.
    const constrained = validateOntology({
      entityTypes: ["PERSON", "COMPANY"],
      relationshipTypes: ["EMPLOYS"],
      relationships: [{ type: "EMPLOYS", domains: ["COMPANY"], ranges: ["PERSON"] }],
    });
    const admitted = admitOpenTriplets(payload([edge("PERSON", "EMPLOYS", "PERSON")]), constrained);

    expect(admitted.rejected).toEqual([]);
    expect(admitted.triplets).toHaveLength(1);
  });

  it("parses a well-formed payload exactly as parseTriplets does", () => {
    // The open reader reports per-entry faults, which the oracle-parity parser
    // deliberately does not; on the entries it accepts the two must agree, or the
    // graph would depend on which entry point read the answer.
    const body = payload([
      edge("ORGANIZATION", "WORKS_AT", "PERSON"),
      { subject: { type: "organization", name: "Acme" }, relation: { type: "works at" }, object: { type: " PERSON ", name: "Acme" } },
      edge("UNICORN", "DEJA_SIN_EFECTO", "ALIEN"),
      { subject: { type: "ORGANIZATION", name: "Acme" }, object: { type: "PERSON", name: "Globex" } },
    ]);

    expect(admitOpenTriplets(body, ONTOLOGY).triplets).toEqual(parseTriplets(body));
  });
});

describe("existing admission behaviour is untouched", () => {
  it("still refuses an undeclared type through parseTripletsWithOntology", () => {
    const strict = parseTripletsWithOntology(payload([edge("UNICORN", "WORKS_AT", "PERSON")]), ONTOLOGY);

    expect(strict.triplets).toEqual([]);
    expect(strict.rejected[0]?.reason).toBe("UNKNOWN_ENTITY_TYPE");
  });

  it("still filters standalone entities through admitStandaloneEntities", () => {
    const entities = parseStandaloneEntities(payload([], [{ type: "ALIEN", name: "Ada" }]));

    expect(admitStandaloneEntities(entities, ONTOLOGY)).toEqual([]);
  });
});

describe("entity-only extraction, pinned as it already works", () => {
  it("yields entities and zero triplets from a payload with no triplets", () => {
    // CONFIRMED before this change: `KG_TOOL` already exposes `triplets` and
    // `entities` (graph-prompt.ts), `parseStandaloneEntities` reads the second
    // array (graph-parse.ts) and `standaloneFor`/`admitStandaloneEntities` admit
    // it (graph-extraction.ts). This test pins that; it adds no capability.
    const body = payload([], [{ type: "ORGANIZATION", name: "Acme" }]);

    expect(Object.keys(buildToolSchema().parameters.properties)).toEqual(["triplets", "entities"]);
    expect(parseStandaloneEntities(body)).toEqual([{ name: "Acme", type: "ORGANIZATION" }]);
    expect(admitStandaloneEntities(parseStandaloneEntities(body), ONTOLOGY)).toHaveLength(1);
    expect(admitOpenTriplets(body, ONTOLOGY).triplets).toEqual([]);
  });
});
