/**
 * @file packages/llmwiki-kg/ts/src/dto-aks.test.ts
 * @description The AKS query-surface DTOs.
 */

import { describe, expect, it } from "vitest";
import { AKSBundle, AKSContextRequest, AKSContextResponse, AKSDocumentSummary, AKSEntity, AKSEntityPage, AKSRelationship, AKSSource, AKSTraverseResponse, AKSTraverseStep } from "./dto.js";
import { TS, UUID_A, UUID_B, expectRejected, parseOk } from "./dto-harness.js";

describe("AKSSource", () => {
  it("applies the verified default and nulls for every other field", () => {
    expect(parseOk(AKSSource, {})).toEqual({
      document_id: null,
      connector_id: null,
      source_kind: null,
      extracted_at: null,
      model: null,
      verified: false,
      pipeline: null,
    });
  });

  it("accepts explicit values", () => {
    const parsed = parseOk(AKSSource, { document_id: UUID_A, verified: true, pipeline: "p" });
    expect(parsed.document_id).toBe(UUID_A);
    expect(parsed.verified).toBe(true);
  });
});

describe("AKSEntity", () => {
  const entity = {
    id: UUID_A,
    name: "Auth Service",
    type: "service",
    confidence: 0.9,
    source: {},
  };

  it("defaults properties to a fresh object and contributing_documents to a fresh array", () => {
    const first = parseOk(AKSEntity, entity);
    const second = parseOk(AKSEntity, entity);

    expect(first.properties).toEqual({});
    expect(first.contributing_documents).toEqual([]);

    // The two parses must not share container instances.
    expect(first.properties).not.toBe(second.properties);
    expect(first.contributing_documents).not.toBe(second.contributing_documents);
  });

  it("does not leak a mutation between parses", () => {
    const first = parseOk(AKSEntity, entity);
    first.properties["mutated"] = true;
    first.contributing_documents.push(UUID_A);

    const second = parseOk(AKSEntity, entity);
    expect(second.properties).toEqual({});
    expect(second.contributing_documents).toEqual([]);
  });

  it("accepts a float confidence and rejects a non-number", () => {
    expect(parseOk(AKSEntity, { ...entity, confidence: 0 }).confidence).toBe(0);
    expectRejected(AKSEntity, { ...entity, confidence: "high" }, "string confidence");
  });

  it("requires the nested source block", () => {
    const { source: _source, ...withoutSource } = entity;
    expectRejected(AKSEntity, withoutSource, "missing source");
  });

  it("validates entries of contributing_documents as UUIDs", () => {
    expectRejected(AKSEntity, { ...entity, contributing_documents: ["nope"] }, "bad document id");
  });
});

describe("AKSRelationship", () => {
  const relationship = {
    id: UUID_A,
    from_entity_id: UUID_A,
    to_entity_id: UUID_B,
    type: "depends_on",
    confidence: 0.5,
    source: {},
  };

  it("parses and defaults description to null", () => {
    expect(parseOk(AKSRelationship, relationship).description).toBeNull();
  });

  it("requires both endpoints", () => {
    const { to_entity_id: _t, ...noTarget } = relationship;
    expectRejected(AKSRelationship, noTarget, "missing to_entity_id");
  });
});

describe("AKSContextRequest", () => {
  it("applies the Python defaults", () => {
    expect(parseOk(AKSContextRequest, { query: "auth" })).toEqual({
      query: "auth",
      stack_id: null,
      domain: null,
      max_entities: 8,
      include_relationships: true,
    });
  });

  it("enforces max_entities between 1 and 50 inclusive", () => {
    expect(parseOk(AKSContextRequest, { query: "q", max_entities: 1 }).max_entities).toBe(1);
    expect(parseOk(AKSContextRequest, { query: "q", max_entities: 50 }).max_entities).toBe(50);
    expectRejected(AKSContextRequest, { query: "q", max_entities: 0 }, "max_entities 0");
    expectRejected(AKSContextRequest, { query: "q", max_entities: 51 }, "max_entities 51");
  });

  it("requires a non-empty query", () => {
    expectRejected(AKSContextRequest, { query: "" }, "empty query");
  });
});

describe("AKSContextResponse", () => {
  const response = {
    query: "auth",
    entities: [],
    relationships: [],
    traversal_path: ["a", "b"],
    reasoning: "because",
    confidence: "HIGH",
  };

  it("defaults source_type to compiled", () => {
    expect(parseOk(AKSContextResponse, response).source_type).toBe("compiled");
  });
});

describe("AKSTraverseStep and AKSTraverseResponse", () => {
  it("types depth as an integer and confidence as a float", () => {
    expectRejected(
      AKSTraverseStep,
      { from_entity: "a", relationship: "r", to_entity: "b", depth: 1.5, confidence: 0.5 },
      "float depth",
    );
    expect(
      parseOk(AKSTraverseStep, {
        from_entity: "a",
        relationship: "r",
        to_entity: "b",
        depth: 2,
        confidence: 0.5,
      }).depth,
    ).toBe(2);
  });

  it("parses a traverse response", () => {
    const parsed = parseOk(AKSTraverseResponse, {
      start: "a",
      max_depth: 2,
      steps: [],
      entity_count: 0,
    });
    expect(parsed.steps).toEqual([]);
  });
});

describe("AKSBundle", () => {
  const bundle = {
    domain: "d",
    stack_id: UUID_A,
    stack_name: "S",
    compiled_at: TS,
    scope: "stack",
    entity_count: 1,
    relationship_count: 2,
  };

  it("applies the documented defaults", () => {
    const parsed = parseOk(AKSBundle, bundle);
    expect(parsed.aks_version).toBe("0.2.0");
    expect(parsed.document_count).toBe(0);
    expect(parsed.compilation_strategy).toBeNull();
  });

  it("defaults all three collections to fresh arrays", () => {
    const first = parseOk(AKSBundle, bundle);
    const second = parseOk(AKSBundle, bundle);

    expect(first.documents).toEqual([]);
    expect(first.entities).toEqual([]);
    expect(first.relationships).toEqual([]);

    expect(first.documents).not.toBe(second.documents);
    expect(first.entities).not.toBe(second.entities);
    expect(first.relationships).not.toBe(second.relationships);
  });

  it("does not leak a mutation between parses", () => {
    // `AKSBundle.parse` is used directly so the materialized output type (with
    // defaults applied) is what gets mutated below.
    const first = AKSBundle.parse(bundle);
    first.documents.push(
      AKSDocumentSummary.parse({
        id: UUID_A,
        filename: "f",
        ingested_at: TS,
        source_hash: "h",
        truncated: false,
      }),
    );
    expect(first.documents).toHaveLength(1);
    expect(AKSBundle.parse(bundle).documents).toEqual([]);
  });
});

describe("AKSEntityPage", () => {
  const page = {
    entity_name: "Auth",
    markdown: "# Auth",
    generated_at: TS,
    source_entity_id: UUID_A,
    graph_version: "v1",
  };

  it("defaults source_type to compiled and cached to null", () => {
    const parsed = parseOk(AKSEntityPage, page);
    expect(parsed.source_type).toBe("compiled");
    expect(parsed.cached).toBeNull();
  });

  it("accepts an explicit cached boolean", () => {
    expect(parseOk(AKSEntityPage, { ...page, cached: true }).cached).toBe(true);
  });
});
