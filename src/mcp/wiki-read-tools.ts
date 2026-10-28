/**
 * @file src/mcp/wiki-read-tools.ts
 * @description The MCP tools that READ the compiled wiki, each addressable per Stack.
 *
 * ## Why these live apart from `tools.ts`
 *
 * `tools.ts` was already past the project's 400-line ceiling before Stack addressing
 * existed. Adding a `stackId` argument to seven registrations there would have meant
 * either a larger file or a second ceiling exemption, and the file ceiling is the one
 * rule that keeps a registrations module reviewable. The split is by READ vs WRITE,
 * which is the axis a reviewer already uses: nothing here mutates a project, so the
 * whole file can be audited for tenant isolation without also auditing ingest.
 *
 * ## Why every tool takes `stackId`, including the ones that end up from disk
 *
 * A wiki can be served from rows or from files, and which one a caller gets is not
 * something the caller should have to know in order to ask. The argument says WHICH
 * Stack to look at; the seams decide whether that Stack resolves to rows. Passing it
 * only to the readers that happen to hit a database today would bake this
 * deployment's storage shape into the tool surface.
 *
 * Absent, every tool keeps the previous behaviour exactly: the Stack the process was
 * started with. A single-Stack deployment therefore needs no changes.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildContextPack } from "@atomicstrata/llmwiki-core/compiler-cli";
import { collectStatus } from "@atomicstrata/llmwiki-core/compiler-cli";
import { generateAnswer } from "@atomicstrata/llmwiki-core/compiler-cli";
import { getPage } from "@atomicstrata/llmwiki-core/compiler-cli";
import { lint } from "@atomicstrata/llmwiki-core/compiler-cli";
import { loadSelectedRefs } from "@atomicstrata/llmwiki-core/compiler-cli";
import { pickSearchRefs } from "@atomicstrata/llmwiki-core/compiler-cli";
import { readPageRecord } from "@atomicstrata/llmwiki-core/compiler-cli";
import { ensureProviderAvailable } from "@atomicstrata/llmwiki-core/compiler-cli";
import {
  withEmbeddingStoreSource,
  withPageScan,
  withPageSource,
  withRegistrySource,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import type { PageListingSource } from "@atomicstrata/llmwiki-core/compiler-cli";
import { createDimensionsDatabase } from "../dimensions/activation.js";
import { createPageListingSource } from "../dimensions/wiki/page-write-sink.js";
import { jsonResult } from "./result.js";
import { withRequestEnv } from "./tenant-db.js";
import { STACK_ID_SCHEMA } from "./stack-arg.js";

/** The namespaces `read_page` searches, in the order it has always documented. */
const READ_DIRECTORIES = ["concepts", "queries"] as const;

/**
 * Register the read-only wiki tools.
 *
 * @param server - MCP server to register on.
 * @param root - Absolute path to the wiki project root.
 */
export function registerWikiReadTools(server: McpServer, root: string): void {
  registerQueryTool(server, root);
  registerSearchTool(server, root);
  registerReadTool(server, root);
  registerLintTool(server, root);
  registerStatusTool(server, root);
  registerContextPackTool(server, root);
}

function registerQueryTool(server: McpServer, root: string): void {
  server.registerTool(
    "query_wiki",
    {
      title: "Query Wiki",
      description:
        "Ask a natural-language question. Selects relevant pages with the LLM, " +
        "loads them, and returns a grounded answer with citations. Set save=true " +
        "to request publication as a wiki page; citation or profile refusals " +
        "return the answer with publicationRefusal and no saved slug. Set debug=true to include the " +
        "selected chunks and their scores. Requires an LLM provider.",
      inputSchema: {
        question: z.string().describe("The natural-language question to answer."),
        save: z
          .boolean()
          .optional()
          .describe("Request a wiki/queries/ page; publication requires fresh citation validation."),
        debug: z
          .boolean()
          .optional()
          .describe("Include retrieval debug info (selected chunks/pages + scores)."),
        stackId: STACK_ID_SCHEMA,
      },
    },
    async ({ question, save, debug, stackId }) => {
      ensureProviderAvailable();
      const result = await withRequestEnv(stackId, (env) =>
        withEmbeddingStoreSource(env, (embeddingStoreSource) =>
          withRegistrySource(env, (registrySource) =>
            generateAnswer(root, question, {
              save,
              debug,
              registrySource,
              embeddingStoreSource,
            }),
          ),
        ),
      );
      return jsonResult(result);
    },
  );
}

function registerSearchTool(server: McpServer, root: string): void {
  server.registerTool(
    "search_pages",
    {
      title: "Search Pages",
      description:
        "Select pages relevant to a question and return their full content. " +
        "Uses semantic embeddings when available, falling back to LLM-based " +
        "selection over the wiki index. Requires an LLM provider.",
      inputSchema: {
        question: z.string().describe("The query used to rank pages."),
        stackId: STACK_ID_SCHEMA,
      },
    },
    async ({ question, stackId }) => {
      ensureProviderAvailable();
      // One source for ranking AND hydration, or a Stack-backed wiki ranks against
      // rows and then finds none of them on disk.
      const { records, refs, warnings } = await withRequestEnv(stackId, (env) =>
        withRegistrySource(env, async (registrySource) => {
          const selected = await pickSearchRefs(root, question, { registrySource });
          return {
            ...selected,
            records: await loadSelectedRefs(root, selected.refs, registrySource),
          };
        }),
      );
      // S6: surface degrade warnings in the RESULT payload (not a log) so an
      // agent SEES that an outdated index meant lexical-only contribution.
      return jsonResult({ pages: records, refs, warnings });
    },
  );
}

/**
 * Resolve one page by slug, from the registry when there is one.
 *
 * ## Why both sources are tried, in this order
 *
 * `concepts` before `queries` is the contract `read_page` has always documented, and
 * the registry source is asked in that same order so a slug that exists in both
 * resolves identically whether it came from a row or a file.
 *
 * The fallback is not defensive padding: a project with no database is a supported
 * deployment, and on it `pageSource` is `undefined` and the on-disk read is the only
 * correct answer. The two paths cannot disagree about a slug that exists in both,
 * because the registry is the compiled copy of that file.
 *
 * @param root - Absolute path to the wiki project root.
 * @param slug - Page slug, without the `.md` extension.
 * @param pageSource - Registry-backed reader, or `undefined` to read from disk.
 * @returns The page, or `null` when neither source has it.
 */
async function readPageBySlug(
  root: string,
  slug: string,
  pageSource: PageListingSource | undefined,
): Promise<{ slug: string; title: string; summary: string; body: string } | null> {
  if (pageSource === undefined) return readPageRecord(root, slug);
  for (const pageDirectory of READ_DIRECTORIES) {
    const page = await getPage(root, { pageDirectory, slug }, pageSource);
    // Orphaned pages are skipped to match `readPageRecord`, which only reports a page
    // whose sources still exist. Serving one would answer with a body no compilation
    // claims any more.
    if (page !== null && !page.orphaned) {
      return { slug: page.slug, title: page.title, summary: page.summary, body: page.body ?? "" };
    }
  }
  return null;
}

/**
 * Test seam for {@link readPageBySlug}, which builds its own environment lookup.
 *
 * Exists so the suite can inject a specific Stack instead of mutating global env, and
 * so the registry path can be exercised without constructing an MCP server.
 *
 * @param root - Absolute path to the wiki project root.
 * @param slug - Page slug, without the `.md` extension.
 * @param stackId - Stack whose registry should be read.
 * @returns The page, or `null` when the registry has no such page.
 */
export async function readPageBySlugForTest(
  root: string,
  slug: string,
  stackId: string,
): Promise<{ slug: string; title: string; summary: string; body: string } | null> {
  const env = { ...process.env, AKS_STACK_ID: stackId };
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    return await readPageBySlug(root, slug, createPageListingSource(dimensionsDb.db, stackId));
  } finally {
    await dimensionsDb.close();
  }
}

function registerReadTool(server: McpServer, root: string): void {
  server.registerTool(
    "read_page",
    {
      title: "Read Page",
      description:
        "Read one compiled wiki page by slug, including its frontmatter and full " +
        "body. Searches concepts/ then queries/. Read-only.",
      inputSchema: {
        slug: z.string().describe("Page slug, without the .md extension."),
        stackId: STACK_ID_SCHEMA,
      },
    },
    async ({ slug, stackId }) => {
      const page = await withRequestEnv(stackId, (env) =>
        withPageSource(env, (pageSource) => readPageBySlug(root, slug, pageSource)),
      );
      // Thrown, not returned as an isError result: this tool has always surfaced a
      // missing page as a rejection, and a caller that switches on the outcome would
      // silently start seeing "success" for a slug that does not exist.
      if (page === null) throw new Error(`Page not found: ${slug}`);
      return jsonResult(page);
    },
  );
}

function registerLintTool(server: McpServer, root: string): void {
  server.registerTool(
    "lint_wiki",
    {
      title: "Lint Wiki",
      description:
        "Run rule-based quality checks (broken wikilinks, orphans, duplicates, " +
        "empty pages, broken citations). Returns structured diagnostics. No LLM call.",
      inputSchema: { stackId: STACK_ID_SCHEMA },
    },
    async ({ stackId }) => {
      // `lint` takes only `root` and walks categories and rules that legitimately read
      // non-page project files, so it is NOT Stack-addressed yet: accepting the
      // argument here would promise an isolation it does not deliver. The parameter is
      // present for surface consistency and documented in the audit as unwired.
      const summary = await withRequestEnv(stackId, () => lint(root));
      return jsonResult(summary);
    },
  );
}

function registerStatusTool(server: McpServer, root: string): void {
  server.registerTool(
    "wiki_status",
    {
      title: "Wiki Status",
      description:
        "Summarize the wiki: page count, source count, last compile time, pending source " +
        "changes, and freshness-derived page health. stalePages lists concept slugs whose " +
        "source changed or partially disappeared since last compile. orphanedPages lists " +
        "concept slugs whose every owning source was deleted OR that are frontmatter-flagged " +
        "orphaned (superset of prior behavior). stateStatus reports state.json readability " +
        "(ok | missing | corrupt) so corrupt state is never silent. Each list (stalePages, " +
        "orphanedPages, pendingChanges) is capped at 100 entries for response size; the " +
        "corresponding *Count fields (staleCount, orphanedCount, pendingChangesCount) give " +
        "the true totals. Read-only — never modifies the workspace.",
      inputSchema: { stackId: STACK_ID_SCHEMA },
    },
    async ({ stackId }) =>
      jsonResult(
        await withRequestEnv(stackId, (env) =>
          withPageScan(env, (pageScan) => collectStatus(root, { pageScan })),
        ),
      ),
  );
}

/** Typed schema for `get_context_pack`; the return type is what makes `args` infer. */
function contextPackInputSchema() {
  return {
    prompt: z
      .string()
      .describe("Free-text task or topic to assemble context for."),
    budget: z
      .number()
      .optional()
      .describe("Approximate output token budget (default 8000)."),
    depth: z
      .number()
      .optional()
      .describe("Graph neighborhood depth, 0..2 (default 1, 0 disables expansion)."),
    topPages: z
      .number()
      .optional()
      .describe("Max primary pages (default 5, max 20)."),
    topChunks: z
      .number()
      .optional()
      .describe("Max semantic chunks to surface (default 8, max 50)."),
    omitRoot: z
      .boolean()
      .optional()
      .describe("Emit `project.root` as null instead of the absolute path."),
    includeSources: z
      .boolean()
      .optional()
      .describe(
        "Materialize `primary[].sourceWindows` from claim-level citations " +
          "(reads files under `sources/` only; path-confined).",
      ),
    stackId: STACK_ID_SCHEMA,
  };
}

/** Inline arg shape for {@link buildContextPackFromArgs}. */
interface ContextPackToolArgs {
  prompt: string;
  budget?: number;
  depth?: number;
  topPages?: number;
  topChunks?: number;
  omitRoot?: boolean;
  includeSources?: boolean;
  stackId?: string;
}

/**
 * Per-call adapter that fans the tool args into `buildContextPack`.
 *
 * Wrapped in BOTH retrieval seams for the same reason `query_wiki` is. They are not
 * interchangeable: the store says which vectors exist, the registry says which of
 * their pages are still live. With only the store, every chunk is discarded as stale
 * and the pack returns an empty `chunks` array that reads as "nothing was relevant".
 */
async function buildContextPackFromArgs(
  root: string,
  args: ContextPackToolArgs,
): Promise<Awaited<ReturnType<typeof buildContextPack>>> {
  return withRequestEnv(args.stackId, (env) =>
    withRegistrySource(env, (registryPageSource) =>
      withEmbeddingStoreSource(env, (embeddingStoreSource) =>
        buildContextPack({
          root,
          prompt: args.prompt,
          budget: args.budget,
          depth: args.depth,
          topPages: args.topPages,
          topChunks: args.topChunks,
          omitRoot: args.omitRoot,
          includeSources: args.includeSources,
          embeddingStoreSource,
          registryPageSource,
        }),
      ),
    ),
  );
}

function registerContextPackTool(server: McpServer, root: string): void {
  server.registerTool(
    "get_context_pack",
    {
      title: "Get Context Pack",
      description:
        "Build an agent-ready evidence pack for `prompt` over the compiled " +
        "wiki: primary pages, semantic chunks, graph neighbors, citations, " +
        "warnings, and suggested next actions. Returns the same v1 JSON " +
        "envelope as `llmwiki context --json`. Read-only; no provider " +
        "credentials required. Use this to PREPARE evidence; use " +
        "`query_wiki` to GENERATE a grounded natural-language answer.",
      inputSchema: contextPackInputSchema(),
    },
    async (args) => jsonResult(await buildContextPackFromArgs(root, args)),
  );
}
