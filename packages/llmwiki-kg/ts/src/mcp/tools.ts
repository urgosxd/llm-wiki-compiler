/**
 * @file packages/llmwiki-kg/ts/src/mcp/tools.ts
 * @description The tool registry advertised to MCP clients.
 *
 * Names, descriptions and input schemas are the discoverable contract: a client
 * picks tools by reading them, so the wording is part of the API.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ============================================================
// Tool registry
// ============================================================

/**
 * How every graph tool describes the Stack argument it requires.
 *
 * The wording states both halves of the contract an LLM client has to read: the
 * argument is mandatory, and there is nothing behind it to supply one, so
 * omitting it is a refusal rather than "use whatever Stack is around".
 */
const REQUIRED_STACK_DESCRIPTION =
  "UUID of the Stack. Required: no default Stack is assumed and none is resolved from the environment.";

/**
 * How every graph tool describes the `domain` filter.
 *
 * Deliberately not "narrows the query": with `stackId` present the API resolves
 * the Stack by id and never looks `domain` up (`core/stack_resolver.ts`), so the
 * argument is forwarded as an additional filter and must not promise more.
 */
const OPTIONAL_DOMAIN_DESCRIPTION =
  "Optional domain slug of the Stack, forwarded alongside stackId as an additional filter; it never replaces stackId.";

/**
 * The `limit` description `list_stacks` advertises, worded once.
 *
 * Byte-identical to the wiki dimension's, because the two `list_stacks` tools share
 * one input schema (S3) and a client has to be able to build the same arguments for
 * either. The default lives here rather than in a `default` keyword: the wiki
 * dimension declares its `limit` as an optional integer without one, and two schemas
 * that advertise different keywords are two contracts again.
 */
const LIST_LIMIT_DESCRIPTION = "How many Stacks to return (default 50, max 200).";

/**
 * The `stackId` sentence BOTH dimensions state byte for byte.
 *
 * It is the half of the argument's meaning that does not depend on a dimension: the
 * argument marks an entry, it never filters the listing.
 */
const LIST_STACK_ID_SENTENCE =
  "Stack to treat as the current one. This does NOT narrow the listing — " +
  "it only decides which entry is marked isCurrent.";

/**
 * What this dimension adds to that sentence: it is bound to no Stack at all.
 *
 * The wiki deployment reads its Stack from the environment and marks that one when
 * the argument is omitted; this server reads no Stack from anywhere, so an omission
 * marks nothing. Saying so is the honest half of the shared contract, and stating the
 * wiki's rule here instead would advertise a binding that does not exist.
 */
const LIST_STACK_ID_TAIL = " Omit it to mark no entry current: this endpoint has no bound Stack.";

/**
 * The tool definitions advertised by `list_tools()`.
 *
 * Descriptions and JSON-Schema fragments are part of the client-facing contract:
 * an LLM client picks tools by reading them, so a reworded description is a
 * behavior change even though no test would call it one.
 *
 * `required` names `stackId` on all three graph tools — the Stack is only ever
 * the argument, never a default and never a fallback, so the schema says so out
 * loud instead of letting a call arrive without one. It stays absent for
 * `list_stacks`, which discovers Stacks: its two arguments are optional by
 * decision, so `required` is not published at all rather than published empty.
 */
export const MCP_TOOLS: readonly Tool[] = [
  {
    name: "query_stack",
    description:
      "Run a natural-language query against a compiled AKS Knowledge Stack. Returns the relevant entities, their relationships, the reasoning the model used to select them, and a confidence rating. Use this when you need to find domain knowledge by description, not by exact entity name.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The natural-language question",
        },
        domain: {
          type: "string",
          description: OPTIONAL_DOMAIN_DESCRIPTION,
        },
        stackId: {
          type: "string",
          description: REQUIRED_STACK_DESCRIPTION,
        },
        max_entities: {
          type: "integer",
          description: "Maximum number of entities to return (default 8)",
          default: 8,
        },
      },
      required: ["query", "stackId"],
    },
  },
  {
    name: "traverse_stack",
    description:
      "Traverse a Knowledge Stack starting from a named entity, following typed relationships up to max_depth hops away. Returns the chain of relationships found. Use this when you know the starting entity and want to explore its neighborhood in the graph.",
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description: "Name of the starting entity",
        },
        domain: {
          type: "string",
          description: OPTIONAL_DOMAIN_DESCRIPTION,
        },
        stackId: {
          type: "string",
          description: REQUIRED_STACK_DESCRIPTION,
        },
        max_depth: {
          type: "integer",
          description: "Maximum hops from the starting entity (default 2)",
          default: 2,
        },
        relationship_types: {
          type: "string",
          description:
            "Optional comma-separated list of relationship types to follow (e.g. 'requires,triggers')",
        },
      },
      required: ["start", "stackId"],
    },
  },
  {
    name: "get_entities",
    description:
      "List the compiled entities in a Knowledge Stack, with optional filtering by type and confidence threshold. Use this for inventory questions like 'what does this Stack know about?' or to find entities by type.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: OPTIONAL_DOMAIN_DESCRIPTION,
        },
        stackId: {
          type: "string",
          description: REQUIRED_STACK_DESCRIPTION,
        },
        type: {
          type: "string",
          description: "Filter by entity type (e.g. 'Process', 'System')",
        },
        min_confidence: {
          type: "number",
          description: "Minimum confidence (0.0-1.0)",
          default: 0.0,
        },
        limit: {
          type: "integer",
          description: "Maximum entities to return (default 100, max 1000)",
          default: 100,
        },
      },
      required: ["stackId"],
    },
  },
  {
    name: "list_stacks",
    description:
      "List the Knowledge Stacks available on this AKS server, most recently updated first, as a JSON document of the form {stacks, count}. Each entry carries id, name, domain, description, scope, compilationStrategy, synthesizeDescriptions, createdAt, updatedAt and isCurrent. Use this when the user hasn't specified which Stack to query and you need the ids that are available. The optional stackId does NOT narrow the listing: it only decides which entry is marked isCurrent, and this endpoint has no bound Stack, so omitting it marks no entry current.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          description: LIST_LIMIT_DESCRIPTION,
          type: "integer",
          minimum: 1,
          maximum: 200,
        },
        stackId: {
          description: `${LIST_STACK_ID_SENTENCE}${LIST_STACK_ID_TAIL}`,
          type: "string",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    },
  },
];
