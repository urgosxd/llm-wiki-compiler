/**
 * @file packages/llmwiki-kg/ts/src/mcp-harness.ts
 * @description Shared fixtures and stubs for the split `mcp-*` test files.
 */
import { expect } from "vitest";

import type { FetchLike } from "./mcp.js";

export const ORACLE_STACKS_BODY = `[{"id":"1146a0e7-dc44-4eac-bd62-606549aa86ce","name":"BF probe","domain":"w1bf-probe-1792602489","description":null,"scope":"stack","compilation_strategy":"incremental","synthesize_descriptions":false,"created_at":"2026-10-21T17:08:09.444263Z","updated_at":"2026-10-21T17:08:09.444263Z"},{"id":"b6c9fd8b-205f-4f5e-b482-7b540e616c86","name":"W1 Doc Probe 2","domain":"w1doc-probe-second","description":null,"scope":"stack","compilation_strategy":"incremental","synthesize_descriptions":false,"created_at":"2026-10-21T17:07:38.226251Z","updated_at":"2026-10-21T17:07:38.226251Z"},{"id":"20efd96a-f6e1-4994-8812-65113f8db4db","name":"W1 Doc Probe","domain":"w1doc-probe-main","description":null,"scope":"stack","compilation_strategy":"incremental","synthesize_descriptions":false,"created_at":"2026-10-21T17:05:32.366119Z","updated_at":"2026-10-21T17:05:32.366119Z"}]`;

export const ORACLE_ENTITIES_EMPTY_BODY = `[]`;

export const ORACLE_TRAVERSE_404_BODY = `{"detail":"Entity 'Nope' not found in Stack"}`;

export const SYNTHETIC_CONTEXT_RESPONSE = `{"query":"how are refunds handled?","entities":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","name":"Payment Service","type":"System","description":"Handles card payments.","properties":{},"confidence":0.87,"contributing_documents":[],"last_seen_at":null,"source":{"document_id":"11111111-1111-4111-8111-111111111111","connector_id":null,"source_kind":"upload","extracted_at":"2026-10-21T17:00:00.123456Z","model":"claude-sonnet-4-5","verified":true,"pipeline":"extraction"}},{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","name":"Refund Flow","type":"Process","description":null,"properties":{},"confidence":0.5,"contributing_documents":[],"last_seen_at":null,"source":{"document_id":"11111111-1111-4111-8111-111111111111","connector_id":null,"source_kind":"upload","extracted_at":"2026-10-21T17:00:00.123456Z","model":"claude-sonnet-4-5","verified":false,"pipeline":"extraction"}}],"relationships":[{"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","from_entity_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","to_entity_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","type":"requires","description":null,"confidence":0.75,"source":{"document_id":"11111111-1111-4111-8111-111111111111","connector_id":null,"source_kind":"upload","extracted_at":"2026-10-21T17:00:00.123456Z","model":"claude-sonnet-4-5","verified":true,"pipeline":"extraction"}},{"id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","from_entity_id":"EEEE-MISSING","to_entity_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","type":"triggers","description":null,"confidence":0.9,"source":{"document_id":"11111111-1111-4111-8111-111111111111","connector_id":null,"source_kind":"upload","extracted_at":"2026-10-21T17:00:00.123456Z","model":"claude-sonnet-4-5","verified":true,"pipeline":"extraction"}}],"traversal_path":[],"reasoning":"Matched on refund keywords.","confidence":"HIGH","source_type":"compiled"}`;

export const SYNTHETIC_TRAVERSE_RESPONSE = `{"start":"Payment Service","max_depth":2,"steps":[{"from_entity":"Payment Service","relationship":"requires","to_entity":"Refund Flow","depth":0,"confidence":0.75},{"from_entity":"Refund Flow","relationship":"triggers","to_entity":"Audit Log","depth":1,"confidence":0.62},{"from_entity":"Audit Log","relationship":"notifies","to_entity":"Ops","depth":2,"confidence":0.125}],"entity_count":4}`;

export const SYNTHETIC_ENTITIES_RESPONSE = `[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","name":"Payment Service","type":"System","description":"Handles card payments.","properties":{},"confidence":0.87,"contributing_documents":[],"last_seen_at":null,"source":{"document_id":"11111111-1111-4111-8111-111111111111","connector_id":null,"source_kind":"upload","extracted_at":"2026-10-21T17:00:00.123456Z","model":"claude-sonnet-4-5","verified":true,"pipeline":"extraction"}},{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","name":"Refund Flow","type":"Process","description":null,"properties":{},"confidence":0.5,"contributing_documents":[],"last_seen_at":null,"source":{"document_id":"11111111-1111-4111-8111-111111111111","connector_id":null,"source_kind":"upload","extracted_at":"2026-10-21T17:00:00.123456Z","model":"claude-sonnet-4-5","verified":false,"pipeline":"extraction"}}]`;

export const EXPECTED_CTX = "Query: how are refunds handled?\nConfidence: HIGH\nReasoning: Matched on refund keywords.\n\nRelevant entities (2):\n  • Payment Service [System, conf 0.87]\n    Handles card payments.\n  • Refund Flow [Process, conf 0.50]\n\nRelationships (2):\n  • Payment Service —[requires]→ Refund Flow\n  • EEEE-MISSING —[triggers]→ Payment Service";
export const EXPECTED_CTX_NO_ENTITIES = "Query: how are refunds handled?\nConfidence: HIGH\nReasoning: Matched on refund keywords.\n\nNo relevant entities found.";
export const EXPECTED_TRAV = "Traversal from: Payment Service\nMax depth: 2\nEntities reached: 4\n\nPath (3 steps):\n• Payment Service —[requires]→ Refund Flow (depth 0, conf 0.75)\n  • Refund Flow —[triggers]→ Audit Log (depth 1, conf 0.62)\n    • Audit Log —[notifies]→ Ops (depth 2, conf 0.12)";
export const EXPECTED_TRAV_NO_STEPS = "Traversal from: Payment Service\nMax depth: 2\nEntities reached: 4\n\n(No relationships found from this entity)";
export const EXPECTED_ENTS = "Found 2 entities:\n\n• Payment Service [System, conf 0.87] ✓\n  Handles card payments.\n• Refund Flow [Process, conf 0.50]";
export const EXPECTED_ENTS_EMPTY = "(No entities matched the filter)";
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export interface StubResponse {
  readonly status: number;
  readonly body: string;
}

export function recordingFetch(response: StubResponse): {
  fetchImpl: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return {
      status: response.status,
      text: async () => response.body,
      json: async () => JSON.parse(response.body) as unknown,
    };
  };
  return { fetchImpl, requests };
}

/**
 * The single text block of a tool result, whatever typed envelope it arrived in.
 *
 * Deliberately `unknown`: `callTool` returns the SDK's `CallToolResult`, while the
 * client's `callTool` over a transport returns the protocol's own result type,
 * and the two are not mutually assignable under `exactOptionalPropertyTypes`.
 * The shape is asserted at runtime instead.
 */
export function textOf(result: unknown): string {
  const content = (result as { content?: ReadonlyArray<{ type?: string; text?: string }> })
    .content;
  expect(content).toHaveLength(1);
  const [first] = content ?? [];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error("Expected a single text content block");
  }
  return first.text;
}

/**
 * The ten keys of one entry in the unified `list_stacks` contract, in contract order.
 *
 * Shared with `test/mcp/list-stacks-contract.test.ts`, which drives BOTH dimensions:
 * one list of keys means the two servers cannot be compared against two opinions.
 */
export const CONTRACT_STACK_KEYS = [
  "id",
  "name",
  "domain",
  "description",
  "scope",
  "compilationStrategy",
  "synthesizeDescriptions",
  "createdAt",
  "updatedAt",
  "isCurrent",
] as const;

/** Decode a tool result's text block as the JSON document `list_stacks` answers with. */
export function payloadOf(result: unknown): unknown {
  return JSON.parse(textOf(result)) as unknown;
}

export const BASE_URL = "http://localhost:8000";
