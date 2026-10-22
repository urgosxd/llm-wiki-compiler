/**
 * @file packages/llmwiki-kg/ts/src/dto-backfeed.test.ts
 * @description Backfeed proposal, item and action DTOs.
 */

import { describe, expect, it } from "vitest";
import { BackfeedApprovalRequest, BackfeedApprovalResult, BackfeedEntityProposal, BackfeedFlagRequest, BackfeedItemResponse, BackfeedProposal, BackfeedRejectionRequest, BackfeedRelationshipProposal } from "./dto.js";
import { TS, UUID_A, UUID_B, expectRejected, parseOk } from "./dto-harness.js";

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
