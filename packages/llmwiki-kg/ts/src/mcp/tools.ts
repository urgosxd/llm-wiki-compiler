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
 * The tool definitions advertised by `list_tools()`.
 *
 * Descriptions and JSON-Schema fragments are part of the client-facing contract:
 * an LLM client picks tools by reading them, so a reworded description is a
 * behavior change even though no test would call it one.
 *
 * `required` names `stackId` on all three graph tools — the Stack is only ever
 * the argument, never a default and never a fallback, so the schema says so out
 * loud instead of letting a call arrive without one. It stays absent for
 * `list_stacks`, which lists every Stack on the server and has no Stack
 * dimension of its own; an empty `required: []` would be a different schema, and
 * a decorative required argument there would be a lie.
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
      "List all Knowledge Stacks available on this AKS server. Returns each Stack's name, domain, and description. Use this when the user hasn't specified which Stack to query and you need to figure out what's available.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];
