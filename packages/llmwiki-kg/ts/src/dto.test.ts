import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  AKSBundle,
  AKSContextRequest,
  AKSContextResponse,
  AKSDocumentSummary,
  AKSEntity,
  AKSEntityPage,
  AKSRelationship,
  AKSSource,
  AKSTraverseResponse,
  AKSTraverseStep,
  BACKFEED_ORIGINS,
  BACKFEED_TRIGGER_TYPES,
  BackfeedApprovalRequest,
  BackfeedApprovalResult,
  BackfeedEntityProposal,
  BackfeedFlagRequest,
  BackfeedItemResponse,
  BackfeedProposal,
  BackfeedRelationshipProposal,
  BackfeedRejectionRequest,
  COMPILATION_STRATEGIES,
  CONFIDENCE_LEVELS,
  DocumentResponse,
  SOURCE_TYPES,
  STACK_SCOPES,
  StackCreate,
  StackResponse,
  StackUpdate,
} from "./dto.js";

/** A fixed timestamp in the wire form `db.ts` produces. */
const TS = "2026-10-21T04:01:46.454886Z";
const UUID_A = "36617342-3b68-4ea7-81b9-5bc562bb81d3";
const UUID_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/** Parses `value` and throws the underlying `ZodError` on failure. */
function parseOk<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`expected a successful parse: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}

/** Asserts that `value` fails validation. */
function expectRejected(schema: z.ZodType, value: unknown, label: string): void {
  expect(schema.safeParse(value).success, `expected ${label} to be rejected`).toBe(false);
}

describe("StackCreate", () => {
  const minimal = { name: "My Stack", domain: "my-stack" };

  it("applies every Python default", () => {
    expect(parseOk(StackCreate, minimal)).toEqual({
      name: "My Stack",
      domain: "my-stack",
      description: null,
      scope: "stack",
      compilation_strategy: "incremental",
      synthesize_descriptions: false,
    });
  });

  it("requires name and domain", () => {
    expectRejected(StackCreate, { domain: "ok-slug" }, "missing name");
    expectRejected(StackCreate, { name: "X" }, "missing domain");
  });

  it("enforces min_length=1 and max_length=200 on name", () => {
    expectRejected(StackCreate, { name: "", domain: "ok" }, "empty name");
    expect(parseOk(StackCreate, { name: "x".repeat(200), domain: "ok" }).name).toHaveLength(200);
    expectRejected(StackCreate, { name: "x".repeat(201), domain: "ok" }, "201-character name");
  });

  it("enforces the lowercase-hyphenated domain pattern", () => {
    // The pattern is an anchored character class, so any all-lowercase
    // digit/hyphen string passes, including leading and trailing hyphens.
    for (const domain of ["a-b-9", "trailing-", "-leading", "-"]) {
      expect(parseOk(StackCreate, { name: "X", domain }).domain, `expected ${domain} to pass`).toBe(
        domain,
      );
    }
    // All of these were confirmed as 422s on the oracle.
    for (const domain of ["NOT-A-SLUG", "with space", "under_score", "UPPER"]) {
      expectRejected(StackCreate, { name: "X", domain }, domain);
    }
  });

  it("accepts any non-empty string as name, including whitespace only", () => {
    // The oracle answers 201 for name=" "; min_length counts characters, it
    // does not strip them.
    expect(parseOk(StackCreate, { name: " ", domain: "ok4" }).name).toBe(" ");
  });

  it("strips unknown fields rather than rejecting them", () => {
    // The oracle answered 201 with a `bogus` key present.
    const parsed = parseOk(StackCreate, { ...minimal, bogus: 1 });
    expect(parsed).not.toHaveProperty("bogus");
  });

  it("accepts explicit null for the optional description", () => {
    expect(parseOk(StackCreate, { ...minimal, description: null }).description).toBeNull();
  });

  it("rejects a non-string description", () => {
    expectRejected(StackCreate, { ...minimal, description: 5 }, "numeric description");
  });
});

describe("StackUpdate", () => {
  it("makes every field optional", () => {
    expect(parseOk(StackUpdate, {})).toEqual({
      name: null,
      description: null,
      scope: null,
      compilation_strategy: null,
      synthesize_descriptions: null,
    });
  });

  it("still validates supplied values", () => {
    expectRejected(StackUpdate, { name: "" }, "empty name");
    expectRejected(StackUpdate, { name: "x".repeat(201) }, "over-long name");
    expectRejected(StackUpdate, { scope: "BAD" }, "invalid scope");
  });
});

describe("StackResponse", () => {
  const response = {
    id: UUID_A,
    name: "X",
    domain: "ok",
    description: null,
    scope: "stack",
    compilation_strategy: "incremental",
    synthesize_descriptions: false,
    created_at: TS,
    updated_at: TS,
  };

  it("parses a full response and keeps timestamps as strings", () => {
    const parsed = parseOk(StackResponse, response);
    expect(parsed.created_at).toBe(TS);
    expect(typeof parsed.created_at).toBe("string");
    // Microsecond digits survive; a Date round-trip would drop the last three.
    expect(parsed.created_at.endsWith("454886Z")).toBe(true);
  });

  it("requires description but accepts null", () => {
    const { description: _omitted, ...withoutDescription } = response;
    expectRejected(StackResponse, withoutDescription, "missing description");
    expect(parseOk(StackResponse, { ...response, description: "text" }).description).toBe("text");
  });

  it("rejects a non-UUID id", () => {
    expectRejected(StackResponse, { ...response, id: "abc" }, "invalid id");
  });
});

describe("DocumentResponse", () => {
  const response = {
    id: UUID_A,
    stack_id: UUID_B,
    filename: "doc.pdf",
    size_bytes: 1024,
    content_type: null,
    source_hash: "deadbeef",
    truncated: false,
    original_length: null,
    ingested_at: TS,
  };

  it("parses without audit, which has a Python default", () => {
    expect(parseOk(DocumentResponse, response).audit).toBeNull();
  });

  it("requires content_type and original_length but accepts null", () => {
    const { content_type: _c, ...noContentType } = response;
    expectRejected(DocumentResponse, noContentType, "missing content_type");
    const { original_length: _o, ...noOriginalLength } = response;
    expectRejected(DocumentResponse, noOriginalLength, "missing original_length");
  });

  it("rejects a float size_bytes, which Python types as int", () => {
    expectRejected(DocumentResponse, { ...response, size_bytes: 1.5 }, "float size_bytes");
    expect(parseOk(DocumentResponse, { ...response, size_bytes: 10 }).size_bytes).toBe(10);
  });
});

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

describe("backfeed proposal models", () => {
  it("defaults BackfeedEntityProposal confidence to 0.7 and properties to a fresh object", () => {
    const first = parseOk(BackfeedEntityProposal, { name: "a", type: "b" });
    const second = parseOk(BackfeedEntityProposal, { name: "a", type: "b" });
    expect(first.confidence).toBe(0.7);
    expect(first.properties).toEqual({});
    expect(first.properties).not.toBe(second.properties);
    first.properties["x"] = 1;
    expect(second.properties).toEqual({});
  });

  it("enforces confidence between 0.0 and 1.0 inclusive", () => {
    for (const confidence of [0, 1, 0.5]) {
      expect(parseOk(BackfeedEntityProposal, { name: "a", type: "b", confidence }).confidence).toBe(
        confidence,
      );
    }
    expectRejected(BackfeedEntityProposal, { name: "a", type: "b", confidence: -0.1 }, "negative");
    expectRejected(BackfeedEntityProposal, { name: "a", type: "b", confidence: 1.1 }, "above one");
  });

  it("uses from_entity / to_entity on BackfeedRelationshipProposal", () => {
    const parsed = parseOk(BackfeedRelationshipProposal, {
      from_entity: "a",
      to_entity: "b",
      type: "r",
    });
    expect(parsed.confidence).toBe(0.7);
    // The schema.ts JSONB comment uses `from`/`to`; the API model does not.
    expect(parsed).not.toHaveProperty("from");
    expect(parsed).not.toHaveProperty("to");
    expectRejected(BackfeedRelationshipProposal, { from_entity: "a", type: "r" }, "missing to_entity");
  });

  it("defaults both BackfeedProposal collections to fresh arrays", () => {
    const first = parseOk(BackfeedProposal, {});
    const second = parseOk(BackfeedProposal, {});
    expect(first.entities).toEqual([]);
    expect(first.relationships).toEqual([]);
    expect(first.entities).not.toBe(second.entities);
    expect(first.relationships).not.toBe(second.relationships);
  });
});

describe("BackfeedFlagRequest", () => {
  it("applies the Python defaults", () => {
    expect(parseOk(BackfeedFlagRequest, { proposal: {} })).toEqual({
      stack_id: null,
      domain: null,
      origin: "direct",
      trigger_type: "manual",
      proposal: { entities: [], relationships: [] },
      note: null,
      metadata: {},
    });
  });

  it("requires proposal", () => {
    expectRejected(BackfeedFlagRequest, {}, "missing proposal");
    expectRejected(BackfeedFlagRequest, { proposal: null }, "null proposal");
  });

  it("defaults metadata to a fresh object", () => {
    const first = parseOk(BackfeedFlagRequest, { proposal: {} });
    const second = parseOk(BackfeedFlagRequest, { proposal: {} });
    expect(first.metadata).not.toBe(second.metadata);
    first.metadata["k"] = "v";
    expect(second.metadata).toEqual({});
  });
});

describe("BackfeedItemResponse", () => {
  const item = {
    id: UUID_A,
    stack_id: UUID_B,
    origin: "direct",
    trigger_type: "manual",
    proposal: {},
    note: null,
    metadata: {},
    status: "pending",
    reviewed_at: null,
    reviewed_by: null,
    review_note: null,
    created_at: TS,
  };

  it("parses a fully-null review block", () => {
    expect(parseOk(BackfeedItemResponse, item).status).toBe("pending");
  });

  it("requires each Optional-no-default field, while accepting null", () => {
    for (const field of ["note", "reviewed_at", "reviewed_by", "review_note"] as const) {
      const withoutField: Record<string, unknown> = { ...item };
      delete withoutField[field];
      expectRejected(BackfeedItemResponse, withoutField, `missing ${field}`);
      expect(parseOk(BackfeedItemResponse, { ...item, [field]: null })).toHaveProperty(field, null);
    }
  });

  it("requires metadata and rejects a missing key", () => {
    const { metadata: _m, ...noMetadata } = item;
    expectRejected(BackfeedItemResponse, noMetadata, "missing metadata");
  });

  it("accepts a populated proposal", () => {
    const parsed = parseOk(BackfeedItemResponse, {
      ...item,
      proposal: { entities: [{ name: "a", type: "b" }] },
    });
    expect(parsed.proposal.entities).toHaveLength(1);
  });
});

describe("backfeed action models", () => {
  it("defaults the optional reviewer fields to null", () => {
    expect(parseOk(BackfeedApprovalRequest, { item_id: UUID_A })).toEqual({
      item_id: UUID_A,
      reviewed_by: null,
      review_note: null,
    });
    expect(parseOk(BackfeedRejectionRequest, { item_id: UUID_A })).toEqual({
      item_id: UUID_A,
      reviewed_by: null,
      review_note: null,
    });
  });

  it("requires item_id as a UUID", () => {
    expectRejected(BackfeedApprovalRequest, {}, "missing item_id");
    expectRejected(BackfeedApprovalRequest, { item_id: "abc" }, "invalid item_id");
  });

  it("parses an approval result with integer counters", () => {
    const parsed = parseOk(BackfeedApprovalResult, {
      item_id: UUID_A,
      entities_absorbed: 2,
      relationships_absorbed: 1,
      status: "approved",
    });
    expect(parsed.entities_absorbed).toBe(2);
    expectRejected(
      BackfeedApprovalResult,
      { item_id: UUID_A, entities_absorbed: 1.5, relationships_absorbed: 0, status: "approved" },
      "float entity count",
    );
  });
});

describe("literal enums", () => {
  /** Each enum with the model and field that carries it. */
  const ENUMS: readonly {
    readonly name: string;
    readonly values: readonly string[];
    /** Builds a minimal valid payload with `field` set to `value`. */
    readonly withField: (field: string, value: unknown) => unknown;
    readonly field: string;
  }[] = [
    {
      name: "scope",
      values: STACK_SCOPES,
      field: "scope",
      withField: (field, value) => ({ name: "X", domain: "ok", [field]: value }),
    },
    {
      name: "compilation_strategy",
      values: COMPILATION_STRATEGIES,
      field: "compilation_strategy",
      withField: (field, value) => ({ name: "X", domain: "ok", [field]: value }),
    },
    {
      name: "confidence",
      values: CONFIDENCE_LEVELS,
      field: "confidence",
      withField: (field, value) => ({
        query: "q",
        entities: [],
        relationships: [],
        traversal_path: [],
        reasoning: "r",
        [field]: value,
      }),
    },
    {
      name: "source_type",
      values: SOURCE_TYPES,
      field: "source_type",
      withField: (field, value) => ({
        query: "q",
        entities: [],
        relationships: [],
        traversal_path: [],
        reasoning: "r",
        confidence: "HIGH",
        [field]: value,
      }),
    },
    {
      name: "origin",
      values: BACKFEED_ORIGINS,
      field: "origin",
      withField: (field, value) => ({ proposal: {}, [field]: value }),
    },
    {
      name: "trigger_type",
      values: BACKFEED_TRIGGER_TYPES,
      field: "trigger_type",
      withField: (field, value) => ({ proposal: {}, [field]: value }),
    },
  ];

  /** The schema that actually owns each enum, keyed by enum name. */
  const SCHEMA_BY_ENUM: Record<string, z.ZodType> = {
    scope: StackCreate,
    compilation_strategy: StackCreate,
    confidence: AKSContextResponse,
    source_type: AKSContextResponse,
    origin: BackfeedFlagRequest,
    trigger_type: BackfeedFlagRequest,
  };

  it("declares the exact Literal values from app/models/api.py", () => {
    expect(STACK_SCOPES).toEqual(["stack", "workspace", "domain"]);
    expect(COMPILATION_STRATEGIES).toEqual(["incremental", "global"]);
    expect(CONFIDENCE_LEVELS).toEqual(["HIGH", "MEDIUM", "LOW"]);
    expect(SOURCE_TYPES).toEqual(["compiled", "live", "hybrid"]);
    expect(BACKFEED_ORIGINS).toEqual(["run", "direct"]);
    expect(BACKFEED_TRIGGER_TYPES).toEqual(["manual", "auto", "api"]);
  });

  for (const enumDef of ENUMS) {
    const schema = SCHEMA_BY_ENUM[enumDef.name];
    if (schema === undefined) {
      throw new Error(`no schema registered for enum ${enumDef.name}`);
    }

    it(`${enumDef.name} accepts every valid value`, () => {
      for (const value of enumDef.values) {
        const payload = enumDef.withField(enumDef.field, value);
        expect(
          schema.safeParse(payload).success,
          `expected ${enumDef.name}=${value} to be accepted`,
        ).toBe(true);
      }
    });

    it(`${enumDef.name} rejects an invalid value`, () => {
      const payload = enumDef.withField(enumDef.field, "DEFINITELY_NOT_VALID");
      expect(
        schema.safeParse(payload).success,
        `expected ${enumDef.name}=DEFINITELY_NOT_VALID to be rejected`,
      ).toBe(false);
    });
  }

  it("couples confidence and source_type to their enum, not to free strings", () => {
    const base = {
      query: "q",
      entities: [],
      relationships: [],
      traversal_path: [],
      reasoning: "r",
      confidence: "HIGH",
    };
    expectRejected(AKSContextResponse, { ...base, confidence: "high" }, "lowercase confidence");
    expectRejected(AKSContextResponse, { ...base, source_type: "COMPILED" }, "uppercase source_type");
  });
});

describe("required-nullable versus optional", () => {
  /** Each required-nullable field, with a payload builder and the missing variant. */
  const CASES: readonly {
    readonly label: string;
    readonly schema: z.ZodType;
    readonly payload: Record<string, unknown>;
    readonly field: string;
  }[] = [
    {
      label: "StackResponse.description",
      schema: StackResponse,
      field: "description",
      payload: {
        id: UUID_A,
        name: "X",
        domain: "ok",
        description: "d",
        scope: "stack",
        compilation_strategy: "incremental",
        synthesize_descriptions: false,
        created_at: TS,
        updated_at: TS,
      },
    },
    {
      label: "DocumentResponse.content_type",
      schema: DocumentResponse,
      field: "content_type",
      payload: {
        id: UUID_A,
        stack_id: UUID_B,
        filename: "f",
        size_bytes: 1,
        content_type: "text/plain",
        source_hash: "h",
        truncated: false,
        original_length: 1,
        ingested_at: TS,
      },
    },
    {
      label: "DocumentResponse.original_length",
      schema: DocumentResponse,
      field: "original_length",
      payload: {
        id: UUID_A,
        stack_id: UUID_B,
        filename: "f",
        size_bytes: 1,
        content_type: "text/plain",
        source_hash: "h",
        truncated: false,
        original_length: 1,
        ingested_at: TS,
      },
    },
    {
      label: "BackfeedItemResponse.note",
      schema: BackfeedItemResponse,
      field: "note",
      payload: {
        id: UUID_A,
        stack_id: UUID_B,
        origin: "direct",
        trigger_type: "manual",
        proposal: {},
        note: "n",
        metadata: {},
        status: "pending",
        reviewed_at: null,
        reviewed_by: null,
        review_note: null,
        created_at: TS,
      },
    },
    {
      label: "BackfeedItemResponse.reviewed_at",
      schema: BackfeedItemResponse,
      field: "reviewed_at",
      payload: {
        id: UUID_A,
        stack_id: UUID_B,
        origin: "direct",
        trigger_type: "manual",
        proposal: {},
        note: null,
        metadata: {},
        status: "pending",
        reviewed_at: TS,
        reviewed_by: null,
        review_note: null,
        created_at: TS,
      },
    },
    {
      label: "BackfeedItemResponse.reviewed_by",
      schema: BackfeedItemResponse,
      field: "reviewed_by",
      payload: {
        id: UUID_A,
        stack_id: UUID_B,
        origin: "direct",
        trigger_type: "manual",
        proposal: {},
        note: null,
        metadata: {},
        status: "pending",
        reviewed_at: null,
        reviewed_by: "me",
        review_note: null,
        created_at: TS,
      },
    },
    {
      label: "BackfeedItemResponse.review_note",
      schema: BackfeedItemResponse,
      field: "review_note",
      payload: {
        id: UUID_A,
        stack_id: UUID_B,
        origin: "direct",
        trigger_type: "manual",
        proposal: {},
        note: null,
        metadata: {},
        status: "pending",
        reviewed_at: null,
        reviewed_by: null,
        review_note: "ok",
        created_at: TS,
      },
    },
  ];

  it.each(CASES.map((testCase) => [testCase.label, testCase] as const))(
    "%s rejects a missing key but accepts explicit null",
    (_label, testCase) => {
      expect(testCase.schema.safeParse(testCase.payload).success).toBe(true);

      const missing: Record<string, unknown> = { ...testCase.payload };
      delete missing[testCase.field];
      expect(
        testCase.schema.safeParse(missing).success,
        `expected a missing ${testCase.field} to fail`,
      ).toBe(false);

      expect(
        testCase.schema.safeParse({ ...testCase.payload, [testCase.field]: null }).success,
        `expected an explicit null ${testCase.field} to pass`,
      ).toBe(true);
    },
  );

  it("treats Optional-with-default fields as genuinely optional", () => {
    // Contrast with the required-nullable cases above: AKSSource.document_id is
    // `Optional[UUID] = None`, so omitting the key is legal.
    expect(parseOk(AKSSource, {}).document_id).toBeNull();
    expect(parseOk(StackCreate, { name: "X", domain: "ok" })).not.toHaveProperty("missing");
  });
});

describe("integer and float typing", () => {
  it("rejects fractional integers across the models that declare int", () => {
    const stepBase = { from_entity: "a", relationship: "r", to_entity: "b", confidence: 0.5 };
    expectRejected(AKSTraverseStep, { ...stepBase, depth: 1.5 }, "float depth");
    expectRejected(
      AKSTraverseResponse,
      { start: "a", max_depth: 1.5, steps: [], entity_count: 0 },
      "float max_depth",
    );
    expectRejected(
      AKSTraverseResponse,
      { start: "a", max_depth: 1, steps: [], entity_count: 1.5 },
      "float entity_count",
    );
    expectRejected(
      BackfeedApprovalResult,
      { item_id: UUID_A, entities_absorbed: 1.5, relationships_absorbed: 0, status: "s" },
      "float entities_absorbed",
    );
  });

  it("accepts floats for fields Python types as float", () => {
    expect(parseOk(AKSTraverseStep, {
      from_entity: "a",
      relationship: "r",
      to_entity: "b",
      depth: 1,
      confidence: 0.25,
    }).confidence).toBe(0.25);
  });
});

describe("timestamps", () => {
  it("keeps datetime fields as strings, never Date objects", () => {
    const parsed = parseOk(StackResponse, {
      id: UUID_A,
      name: "X",
      domain: "ok",
      description: null,
      scope: "stack",
      compilation_strategy: "incremental",
      synthesize_descriptions: false,
      created_at: TS,
      updated_at: TS,
    });
    expect(typeof parsed.created_at).toBe("string");
    expect(parsed.created_at).not.toBeInstanceOf(Date);
    expect(parsed.created_at).toBe(TS);
  });

  it("rejects a Date instance, which would mean a millisecond-precision value", () => {
    expectRejected(
      AKSBundle,
      {
        domain: "d",
        stack_id: UUID_A,
        stack_name: "S",
        compiled_at: new Date(0),
        scope: "stack",
        entity_count: 0,
        relationship_count: 0,
      },
      "Date compiled_at",
    );
  });
});
