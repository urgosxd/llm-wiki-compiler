/**
 * The registered MCP tool names, declared once so a guard can compare them to reality.
 *
 * ## Why this list exists at all
 *
 * Before it, nothing in the repository stated which tools the MCP server serves. Two
 * places needed that answer and neither could get it: the server's `instructions`
 * payload named four tools (`list_workflow_actions`, `describe_workflow_action`,
 * `run_workflow_action`, `verify_artifact`) that no `registerTool` call ever created,
 * and every consumer that wanted the inventory hand-copied it — the drift shape, not a
 * source of truth. `get_context_pack` recommendations are the other consumer: a
 * recommendation has to name a tool a client can actually call, which means it has to
 * be compared against this set.
 *
 * ## Why the registration sites are NOT rewired to read it
 *
 * It is tempting to make this module the only place a tool name is written, by
 * importing it at all fourteen `registerTool(` call sites. That would make the list
 * true by construction and therefore blind: a name deleted from here would delete the
 * tool instead of failing a test. Kept as an independent DECLARATION, the two sides
 * drift only on purpose, and `test/mcp/advertised-tools-are-registered.test.ts` walks
 * the real `tools/list` of `createWikiMcpServer` through an in-memory `Client` and
 * asserts equality in both directions — a tool registered but not declared, and a name
 * declared but not registered, each fail there.
 *
 * ## Adding or removing a tool
 *
 * Add or remove it here AND at its registration site, in the same change. Anything the
 * server advertises — the `instructions` payload, a `get_context_pack` suggestion —
 * may then only name a member of this set.
 */

/**
 * Every tool `createWikiMcpServer` registers, and nothing else.
 *
 * Order is alphabetical for reading; membership is the contract, and the guard test
 * compares sets, not sequences.
 */
export const WIKI_MCP_TOOL_NAMES = [
  "compile_wiki",
  "export_okf",
  "get_context_pack",
  "ingest_job_status",
  "ingest_jobs_list",
  "ingest_source",
  "lint_wiki",
  "list_stacks",
  "query_wiki",
  "read_page",
  "run_eval",
  "search_pages",
  "wiki_status",
] as const;

/**
 * One registered MCP tool name.
 *
 * Use this where a value must be a REAL tool: a recommendation target, a dispatch
 * table, anything an agent is expected to call. A plain `string` there is how the
 * phantom names survived.
 */
export type WikiMcpToolName = (typeof WIKI_MCP_TOOL_NAMES)[number];
