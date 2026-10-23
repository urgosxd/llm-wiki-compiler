/**
 * @file packages/llmwiki-kg/ts/src/mcp-harness.ts
 * @description Shared fixtures and stubs for the split `mcp-*` test files.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";

import type { FetchLike } from "./mcp.js";

export const PYTHON_TOOLS_JSON = `[{"name":"query_stack","description":"Run a natural-language query against a compiled AKS Knowledge Stack. Returns the relevant entities, their relationships, the reasoning the model used to select them, and a confidence rating. Use this when you need to find domain knowledge by description, not by exact entity name.","inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"The natural-language question"},"domain":{"type":"string","description":"Domain slug of the Stack (e.g. 'incident-response'). Either domain or stack_id is required."},"stack_id":{"type":"string","description":"UUID of the Stack. Either domain or stack_id is required."},"max_entities":{"type":"integer","description":"Maximum number of entities to return (default 8)","default":8}},"required":["query"]}},{"name":"traverse_stack","description":"Traverse a Knowledge Stack starting from a named entity, following typed relationships up to max_depth hops away. Returns the chain of relationships found. Use this when you know the starting entity and want to explore its neighborhood in the graph.","inputSchema":{"type":"object","properties":{"start":{"type":"string","description":"Name of the starting entity"},"domain":{"type":"string","description":"Domain slug of the Stack"},"stack_id":{"type":"string","description":"UUID of the Stack"},"max_depth":{"type":"integer","description":"Maximum hops from the starting entity (default 2)","default":2},"relationship_types":{"type":"string","description":"Optional comma-separated list of relationship types to follow (e.g. 'requires,triggers')"}},"required":["start"]}},{"name":"get_entities","description":"List the compiled entities in a Knowledge Stack, with optional filtering by type and confidence threshold. Use this for inventory questions like 'what does this Stack know about?' or to find entities by type.","inputSchema":{"type":"object","properties":{"domain":{"type":"string","description":"Domain slug of the Stack"},"stack_id":{"type":"string","description":"UUID of the Stack"},"type":{"type":"string","description":"Filter by entity type (e.g. 'Process', 'System')"},"min_confidence":{"type":"number","description":"Minimum confidence (0.0-1.0)","default":0.0},"limit":{"type":"integer","description":"Maximum entities to return (default 100, max 1000)","default":100}}}},{"name":"list_stacks","description":"List all Knowledge Stacks available on this AKS server. Returns each Stack's name, domain, and description. Use this when the user hasn't specified which Stack to query and you need to figure out what's available.","inputSchema":{"type":"object","properties":{}}}]`;

export const PYTHON_TOOLS: unknown = JSON.parse(PYTHON_TOOLS_JSON);

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
export const EXPECTED_STACKS = "Found 3 Stack(s):\n\n• BF probe (domain: w1bf-probe-1792602489)\n• W1 Doc Probe 2 (domain: w1doc-probe-second)\n• W1 Doc Probe (domain: w1doc-probe-main)";
export const EXPECTED_STACKS_EMPTY = "No Stacks exist on this AKS server yet.";

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

export function textOf(result: CallToolResult): string {
  expect(result.content).toHaveLength(1);
  const [first] = result.content;
  if (first === undefined || first.type !== "text") {
    throw new Error("Expected a single text content block");
  }
  return first.text;
}

export const BASE_URL = "http://localhost:8000";
