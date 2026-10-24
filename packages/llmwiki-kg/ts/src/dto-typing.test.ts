/**
 * @file packages/llmwiki-kg/ts/src/dto-typing.test.ts
 * @description Literal enums, required-nullable versus optional, numeric typing and timestamps.
 */

import { describe, expect, it } from "vitest";
import { AKSBundle, AKSContextResponse, AKSSource, AKSTraverseResponse, AKSTraverseStep, BACKFEED_ORIGINS, BACKFEED_TRIGGER_TYPES, BackfeedApprovalResult, BackfeedFlagRequest, BackfeedItemResponse, COMPILATION_STRATEGIES, CONFIDENCE_LEVELS, DocumentResponse, SOURCE_TYPES, STACK_SCOPES, StackCreate, StackResponse } from "./dto.js";
import type { z } from "zod";
import { TS, UUID_A, UUID_B, expectRejected, parseOk } from "./dto-harness.js";

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
        ontology: null,
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
      ontology: null,
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
