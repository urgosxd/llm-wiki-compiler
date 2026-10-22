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
 * The tool definitions advertised by `list_tools()`.
 *
 * Every string below is copied verbatim from `app/mcp_server.py`. Descriptions
 * and JSON-Schema fragments are part of the client-facing contract: an LLM
 * client picks tools by reading them, so a reworded description is a behavior
 * change even though no test would call it one.
 *
 * `required` is absent for `get_entities` and `list_stacks` because the Python
 * omits it there — parse both branches explicitly rather than emitting an empty
 * `required: []`, which is a different schema.
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
          description:
            "Domain slug of the Stack (e.g. 'incident-response'). Either domain or stack_id is required.",
        },
        stack_id: {
          type: "string",
          description: "UUID of the Stack. Either domain or stack_id is required.",
        },
        max_entities: {
          type: "integer",
          description: "Maximum number of entities to return (default 8)",
          default: 8,
        },
      },
      required: ["query"],
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
          description: "Domain slug of the Stack",
        },
        stack_id: {
          type: "string",
          description: "UUID of the Stack",
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
      required: ["start"],
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
          description: "Domain slug of the Stack",
        },
        stack_id: {
          type: "string",
          description: "UUID of the Stack",
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
