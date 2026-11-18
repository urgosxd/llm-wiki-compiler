/**
 * @file test/mcp/union-inventory.ts
 * @description The tool inventory the one image must advertise, in ONE place.
 *
 * ## Why this is a module and not a literal in each suite
 *
 * Two suites assert the same inventory for different reasons: `one-image-both-mcp-surfaces`
 * because the union's CONTENT is the feature (S3), and `mcp-auth-policy` because an authenticated
 * request must reach that same surface rather than a reduced one (S5). Two copies of a 17-name
 * array drift the moment a tool is added, and the copy that drifts silently weakens whoever kept
 * it — so the literal lives here and both suites import it.
 *
 * This module intentionally contains no `describe`/`it`: importing it from a suite must not
 * register a second copy of that suite's cases.
 */

/**
 * The union the one image must advertise, sorted: the 14 wiki tools the published artifact served
 * plus the four KG tools it did not, minus the duplicate — `list_stacks` is a name collision, and
 * the wiki implementation is the one that answers, so the union is 17 names and not 18.
 */
export const EXPECTED_UNION_TOOLS: readonly string[] = [
  "compile_wiki",
  "export_okf",
  "get_context_pack",
  "get_entities",
  "ingest_job_delete",
  "ingest_job_status",
  "ingest_jobs_list",
  "ingest_source",
  "lint_wiki",
  "list_stacks",
  "query_stack",
  "query_wiki",
  "read_page",
  "run_eval",
  "search_pages",
  "traverse_stack",
  "wiki_status",
];
