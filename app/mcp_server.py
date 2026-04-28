"""
MCP server wrapping the AKS query endpoints as tools.

Three tools exposed:

  query_stack(query, domain | stack_id, max_entities=8)
      Natural-language query over a Stack. Returns relevant entities,
      relationships, and reasoning. Wraps POST /aks/v1/context.

  traverse_stack(start, domain | stack_id, max_depth=2)
      BFS traversal from a named entity. Returns the path of typed
      relationships. Wraps GET /aks/v1/traverse.

  get_entities(domain | stack_id, type=None, min_confidence=0.0, limit=100)
      List entities in a Stack with optional filters. Wraps
      GET /aks/v1/entities.

This is a separate process from the FastAPI server. It runs over
stdio for local Claude Desktop integration, or as an HTTP service
for remote MCP. Both modes are supported via the same code; the
launcher script picks the transport.
"""

import json
import os
from typing import Optional

import httpx
from mcp.server import Server
from mcp.types import Tool, TextContent


# Where to find the AKS server. Default assumes the MCP server runs
# alongside it (host networking). For production deployments, set
# AKS_BASE_URL and optionally AKS_API_KEY in the environment.
AKS_BASE_URL = os.getenv("AKS_BASE_URL", "http://localhost:8000")
AKS_API_KEY = os.getenv("AKS_API_KEY", "").strip()


def _auth_headers() -> dict:
    """Build auth headers if an API key is configured."""
    return {"X-API-Key": AKS_API_KEY} if AKS_API_KEY else {}


# ============================================================
# Server instance and tool registry
# ============================================================

server = Server("aks-reference-server")


@server.list_tools()
async def list_tools() -> list[Tool]:
    """Advertise the three AKS query tools to the MCP client."""
    return [
        Tool(
            name="query_stack",
            description=(
                "Run a natural-language query against a compiled AKS "
                "Knowledge Stack. Returns the relevant entities, their "
                "relationships, the reasoning the model used to select "
                "them, and a confidence rating. Use this when you need "
                "to find domain knowledge by description, not by exact "
                "entity name."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The natural-language question",
                    },
                    "domain": {
                        "type": "string",
                        "description": (
                            "Domain slug of the Stack (e.g. 'incident-response'). "
                            "Either domain or stack_id is required."
                        ),
                    },
                    "stack_id": {
                        "type": "string",
                        "description": "UUID of the Stack. Either domain or stack_id is required.",
                    },
                    "max_entities": {
                        "type": "integer",
                        "description": "Maximum number of entities to return (default 8)",
                        "default": 8,
                    },
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="traverse_stack",
            description=(
                "Traverse a Knowledge Stack starting from a named entity, "
                "following typed relationships up to max_depth hops away. "
                "Returns the chain of relationships found. Use this when "
                "you know the starting entity and want to explore its "
                "neighborhood in the graph."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "start": {
                        "type": "string",
                        "description": "Name of the starting entity",
                    },
                    "domain": {
                        "type": "string",
                        "description": "Domain slug of the Stack",
                    },
                    "stack_id": {
                        "type": "string",
                        "description": "UUID of the Stack",
                    },
                    "max_depth": {
                        "type": "integer",
                        "description": "Maximum hops from the starting entity (default 2)",
                        "default": 2,
                    },
                    "relationship_types": {
                        "type": "string",
                        "description": (
                            "Optional comma-separated list of relationship "
                            "types to follow (e.g. 'requires,triggers')"
                        ),
                    },
                },
                "required": ["start"],
            },
        ),
        Tool(
            name="get_entities",
            description=(
                "List the compiled entities in a Knowledge Stack, with "
                "optional filtering by type and confidence threshold. "
                "Use this for inventory questions like 'what does this "
                "Stack know about?' or to find entities by type."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "domain": {
                        "type": "string",
                        "description": "Domain slug of the Stack",
                    },
                    "stack_id": {
                        "type": "string",
                        "description": "UUID of the Stack",
                    },
                    "type": {
                        "type": "string",
                        "description": "Filter by entity type (e.g. 'Process', 'System')",
                    },
                    "min_confidence": {
                        "type": "number",
                        "description": "Minimum confidence (0.0-1.0)",
                        "default": 0.0,
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum entities to return (default 100, max 1000)",
                        "default": 100,
                    },
                },
            },
        ),
        Tool(
            name="list_stacks",
            description=(
                "List all Knowledge Stacks available on this AKS server. "
                "Returns each Stack's name, domain, and description. Use this "
                "when the user hasn't specified which Stack to query and you "
                "need to figure out what's available."
            ),
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Route tool calls to the matching AKS endpoint."""
    if name == "query_stack":
        return await _query_stack(arguments)
    if name == "traverse_stack":
        return await _traverse_stack(arguments)
    if name == "get_entities":
        return await _get_entities(arguments)
    if name == "list_stacks":
        return await _list_stacks()
    return [
        TextContent(
            type="text",
            text=f"Unknown tool: {name}",
        )
    ]


# ============================================================
# Tool implementations
# ============================================================


async def _query_stack(args: dict) -> list[TextContent]:
    payload = {
        "query": args["query"],
        "max_entities": args.get("max_entities", 8),
    }
    if "domain" in args:
        payload["domain"] = args["domain"]
    elif "stack_id" in args:
        payload["stack_id"] = args["stack_id"]
    else:
        return [
            TextContent(
                type="text",
                text="Error: either 'domain' or 'stack_id' must be provided.",
            )
        ]

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{AKS_BASE_URL}/aks/v1/context",
            json=payload,
            headers=_auth_headers(),
        )

    if response.status_code != 200:
        return [
            TextContent(
                type="text",
                text=f"AKS server returned {response.status_code}: {response.text}",
            )
        ]

    data = response.json()
    return [
        TextContent(
            type="text",
            text=_format_context_response(data),
        )
    ]


async def _traverse_stack(args: dict) -> list[TextContent]:
    params = {
        "start": args["start"],
        "max_depth": args.get("max_depth", 2),
    }
    if "domain" in args:
        params["domain"] = args["domain"]
    elif "stack_id" in args:
        params["stack_id"] = args["stack_id"]
    else:
        return [
            TextContent(
                type="text",
                text="Error: either 'domain' or 'stack_id' must be provided.",
            )
        ]

    if "relationship_types" in args:
        params["relationship_types"] = args["relationship_types"]

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{AKS_BASE_URL}/aks/v1/traverse",
            params=params,
            headers=_auth_headers(),
        )

    if response.status_code != 200:
        return [
            TextContent(
                type="text",
                text=f"AKS server returned {response.status_code}: {response.text}",
            )
        ]

    data = response.json()
    return [
        TextContent(
            type="text",
            text=_format_traverse_response(data),
        )
    ]


async def _get_entities(args: dict) -> list[TextContent]:
    params: dict = {
        "min_confidence": args.get("min_confidence", 0.0),
        "limit": args.get("limit", 100),
    }
    if "domain" in args:
        params["domain"] = args["domain"]
    elif "stack_id" in args:
        params["stack_id"] = args["stack_id"]
    else:
        return [
            TextContent(
                type="text",
                text="Error: either 'domain' or 'stack_id' must be provided.",
            )
        ]
    if "type" in args:
        params["type"] = args["type"]

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{AKS_BASE_URL}/aks/v1/entities",
            params=params,
            headers=_auth_headers(),
        )

    if response.status_code != 200:
        return [
            TextContent(
                type="text",
                text=f"AKS server returned {response.status_code}: {response.text}",
            )
        ]

    data = response.json()
    return [
        TextContent(
            type="text",
            text=_format_entities_response(data),
        )
    ]

async def _list_stacks(args: dict) -> list[TextContent]:
    """List all Stacks on the AKS server."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            f"{AKS_BASE_URL}/stacks",
            headers=_auth_headers(),
        )

    if response.status_code != 200:
        return [TextContent(
            type="text",
            text=f"AKS server returned {response.status_code}: {response.text}",
        )]

    data = response.json()
    if not data:
        return [TextContent(
            type="text",
            text="No Stacks exist on this AKS server yet.",
        )]

    lines = [f"Found {len(data)} Stack(s):", ""]
    for s in data:
        lines.append(f"• {s['name']} (domain: {s['domain']})")
        if s.get("description"):
            lines.append(f"    {s['description']}")

    return [TextContent(type="text", text="\n".join(lines))]

# ============================================================
# Response formatting
# ============================================================
# MCP tool results are text. The AKS endpoints return JSON. We format
# the JSON into a readable structured response that's compact for the
# LLM client to consume. The aim is to surface the most useful fields
# without overwhelming the model with deep nested metadata.


def _format_context_response(data: dict) -> str:
    """Format /aks/v1/context output into a compact readable response."""
    lines = [
        f"Query: {data['query']}",
        f"Confidence: {data['confidence']}",
        f"Reasoning: {data['reasoning']}",
        "",
    ]

    if data.get("entities"):
        lines.append(f"Relevant entities ({len(data['entities'])}):")
        for e in data["entities"]:
            desc = e.get("description") or "(no description)"
            lines.append(f"  • {e['name']} [{e['type']}, conf {e['confidence']:.2f}]")
            if desc and desc != "(no description)":
                lines.append(f"    {desc}")
    else:
        lines.append("No relevant entities found.")

    if data.get("relationships"):
        lines.append("")
        lines.append(f"Relationships ({len(data['relationships'])}):")
        # We need a name lookup since relationships only have IDs
        name_map = {e["id"]: e["name"] for e in data.get("entities", [])}
        for r in data["relationships"]:
            from_name = name_map.get(r["from_entity_id"], r["from_entity_id"])
            to_name = name_map.get(r["to_entity_id"], r["to_entity_id"])
            lines.append(f"  • {from_name} —[{r['type']}]→ {to_name}")

    return "\n".join(lines)


def _format_traverse_response(data: dict) -> str:
    """Format /aks/v1/traverse output."""
    lines = [
        f"Traversal from: {data['start']}",
        f"Max depth: {data['max_depth']}",
        f"Entities reached: {data['entity_count']}",
        "",
    ]

    if not data.get("steps"):
        lines.append("(No relationships found from this entity)")
        return "\n".join(lines)

    lines.append(f"Path ({len(data['steps'])} steps):")
    for s in data["steps"]:
        indent = "  " * s["depth"]
        lines.append(
            f"{indent}• {s['from_entity']} —[{s['relationship']}]→ "
            f"{s['to_entity']} (depth {s['depth']}, conf {s['confidence']:.2f})"
        )

    return "\n".join(lines)


def _format_entities_response(data: list) -> str:
    """Format /aks/v1/entities output (list of entities)."""
    if not data:
        return "(No entities matched the filter)"

    lines = [f"Found {len(data)} entities:", ""]
    for e in data:
        verified_marker = " ✓" if e.get("source", {}).get("verified") else ""
        lines.append(
            f"• {e['name']} [{e['type']}, conf {e['confidence']:.2f}]{verified_marker}"
        )
        if e.get("description"):
            lines.append(f"  {e['description']}")

    return "\n".join(lines)


# ============================================================
# Entry point
# ============================================================


async def run_stdio() -> None:
    """Run the MCP server over stdio for local clients (Claude Desktop)."""
    from mcp.server.stdio import stdio_server

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


def main() -> None:
    """Default entry point: run over stdio."""
    import asyncio

    asyncio.run(run_stdio())


if __name__ == "__main__":
    main()
