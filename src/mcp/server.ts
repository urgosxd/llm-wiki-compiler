/**
 * MCP (Model Context Protocol) server entry point for llmwiki.
 *
 * Exposes llmwiki's automated pipelines (ingest, compile, query, search,
 * lint, read, status) as MCP tools so AI agents can drive the compiler
 * without scraping CLI output. Read-only wiki views are exposed as
 * MCP resources for direct context injection.
 *
 * Transport: stdio for the CLI, and streamable HTTP when the host mounts it.
 *
 * ## Why the server is built by a factory rather than inside the starter
 *
 * The same 14 tools have to be reachable two ways. stdio is what a local CLI
 * client spawns; streamable HTTP is what a REMOTE consumer uses when it must not
 * ship this binary inside its own image. Two starters that each built their own
 * `McpServer` would register the tools twice in two places, and the second copy is
 * where "the HTTP surface is missing a tool" starts. One factory, two transports.
 *
 * ## Why the instructions text lives here
 *
 * It is the server-identity payload of the initialize handshake, so it has to be
 * identical no matter which transport carried the request.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWikiTools } from "./tools.js";
import { registerOkfTools } from "./okf-tools.js";
import { registerWikiResources } from "./resources.js";

export interface ServerOptions {
  /** Project root directory the server operates on. */
  root: string;
  /** Server version surfaced to MCP clients in the initialize handshake. */
  version: string;
}

/**
 * Build the MCP server with every tool and resource registered.
 *
 * Transport-agnostic on purpose: the caller decides how the bytes arrive.
 *
 * @param options - Root directory and the version reported to clients.
 * @returns A server that has not been connected to a transport yet.
 */
export function createWikiMcpServer(options: ServerOptions): McpServer {
  const { root, version } = options;
  const server = new McpServer({ name: "llmwiki", version }, {
    instructions:
      "llmwiki is a knowledge compiler. Use ingest_source to add raw sources, " +
      "compile_wiki to run the LLM pipeline, query_wiki for grounded answers, " +
      "search_pages to retrieve relevant pages, and run_eval to score wiki quality. " +
      "read_page, lint_wiki, wiki_status, and run_eval (fast suite, record: false) work without an API key " +
      "and do not mutate state. " +
      "ingest_job_status and ingest_jobs_list read durable async-ingest job records, so they answer " +
      "across a host restart. " +
      "list_workflow_actions, describe_workflow_action, and run_workflow_action expose the workflow " +
      "harness; MCP actions are hard-capped at staged-write and cannot perform trusted writes or " +
      "satisfy human gates. " +
      "verify_artifact checks a hash-pinned artifact ref and returns manifest metadata plus a health " +
      "verdict, never the body; there is no write or store-wide list tool for artifacts over MCP.",
  });

  registerWikiTools(server, root);
  registerOkfTools(server, root);
  registerWikiResources(server, root);
  return server;
}

/**
 * Start the MCP server bound to stdio transport.
 * Resolves once the transport closes (typically when the parent process exits).
 *
 * @param options - Root directory and server version (the CLI passes its own
 *                  version so the server doesn't need to read package.json).
 */
export async function startMCPServer(options: ServerOptions): Promise<void> {
  const server = createWikiMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
