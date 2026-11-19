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
 * The argument is REQUIRED and nothing is inherited from the process environment on
 * the tool path: a single-Stack deployment must name its Stack explicitly too. S6 keeps
 * that inheritance for resources only, which have no input schema to carry an argument.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateAnswer } from "../commands/query.js";
import { buildContextPack } from "../context/build.js";
import { createDimensionsDatabase } from "../dimensions/activation.js";
import {
  withEmbeddingStoreSource,
  withPageScan,
  withPageSource,
  withRegistrySource,
  withSourceDocuments,
} from "../dimensions/wiki/page-source-seam.js";
import { createPageListingSource } from "../dimensions/wiki/page-write-sink.js";
import { lint } from "../linter/index.js";
import { getPage } from "../pages/list.js";
import type { PageListingSource } from "../pages/list.js";
import { readPageRecord, pageLinkRefs } from "../pages/read.js";
import type { PageLinkRef } from "../pages/read.js";
import { parseQualifiedPageId, qualifiedPageId } from "../utils/page-id.js";
import { pickSearchRefs, loadSelectedRefs } from "../search/retrieval.js";
import { collectStatus } from "../status/collect.js";
import { ensureProviderAvailable } from "../utils/provider-guard.js";
import { jsonResult } from "./result.js";
import { isRefusal, refusalResult, withRequestEnv } from "./tenant-db.js";
import type { Refusal } from "./tenant-db.js";
import { STACK_ARG_REQUIRED_NOTE, STACK_ID_SCHEMA } from "./stack-arg.js";

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
        "selected chunks and their scores. Requires an LLM provider. " +
        STACK_ARG_REQUIRED_NOTE,
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
              // The gate inside generateAnswer asks whether pages exist through a
              // DIFFERENT route than the source above: it builds its own page source
              // from an environment. Passing it the same one is what stops a named
              // Stack from being told "nothing is compiled" while its 73 pages sit in
              // the source that was just opened.
              env,
            }),
          ),
        ),
      );
      if (isRefusal(result)) return refusalResult(result);
      return jsonResult(result);
    },
  );
}

/**
 * The `search_pages` description, hoisted out of `registerSearchTool` because
 * that function already sits at the `max-lines-per-function` limit and this
 * operand is longer than the remaining headroom. At that ceiling the fix is
 * extraction, never compaction of the prose.
 */
const SEARCH_PAGES_DESCRIPTION =
  "Select pages relevant to a question and return their full content. " +
  "Ranks with semantic embeddings whenever an embedding store is reachable, " +
  "including one stored in a Stack's rows; otherwise it falls back to " +
  "LLM-based selection over the wiki index. Ranking from embeddings embeds " +
  "the question, so that path needs an embedding provider and bills one " +
  "embedding request per call. Requires an LLM provider. " +
  "Returns `{ pages, refs, warnings }`: `pages` holds the full page " +
  "records, `refs` the ranked references. Each ref is " +
  "`{ pageId, slug, title, kind, score? }` where `kind` is `chunk`, `page` " +
  "or `index`; `score` is present only when an embedding scored that ref: " +
  "it is the cosine similarity between the query embedding and that page's " +
  "or chunk's embedding, in -1..1 where higher is more similar (in practice " +
  "roughly 0..1), and refs of kind `chunk`/`page` are ordered by it " +
  "descending. `score` is OMITTED for kind `index` refs, which are chosen " +
  "by an LLM over the index and carry no similarity. " +
  STACK_ARG_REQUIRED_NOTE;

function registerSearchTool(server: McpServer, root: string): void {
  server.registerTool(
    "search_pages",
    {
      title: "Search Pages",
      description: SEARCH_PAGES_DESCRIPTION,
      inputSchema: {
        question: z.string().describe("The query used to rank pages."),
        stackId: STACK_ID_SCHEMA,
      },
    },
    async ({ question, stackId }) => {
      ensureProviderAvailable();
      // TWO sources, composed exactly as `query_wiki` composes them, because they
      // answer different questions and neither substitutes for the other: the
      // embedding store says which VECTORS exist (a Stack keeps them in
      // `wiki.page_embeddings` / `wiki.page_chunk_embeddings` and has no
      // `embeddings.json` to find), and the registry says which of their pages are
      // still live.
      //
      // Supplying only the registry source -- which is what this tool did -- made
      // `pickSearchRefs` take its ON-DISK branch and rank nothing, so a corpus with
      // 114 chunk embeddings answered with index refs plus "No embedding index
      // found." Dropping the registry source instead would rank from rows and then
      // hydrate against files that a Stack does not have, discarding every hit as
      // absent. Both, or the answer is wrong either way.
      const found = await withRequestEnv(stackId, (env) =>
        withEmbeddingStoreSource(env, (embeddingStoreSource) =>
          withRegistrySource(env, async (registrySource) => {
            const selected = await pickSearchRefs(root, question, {
              registrySource,
              embeddingStoreSource,
            });
            return {
              ...selected,
              records: await loadSelectedRefs(root, selected.refs, registrySource),
            };
          }),
        ),
      );
      if (isRefusal(found)) return refusalResult(found);
      // `records` is the internal name; the envelope has always called it `pages`.
      // S6: surface degrade warnings in the RESULT payload (not a log) so an
      // agent SEES that an outdated index meant lexical-only contribution.
      return jsonResult({ pages: found.records, refs: found.refs, warnings: found.warnings });
    },
  );
}

/**
 * What one `read_page` argument addresses: which directories to search, and under
 * which page part.
 *
 * A BARE slug keeps the documented concepts-then-queries order under itself. A
 * QUALIFIED id (`<namespace>/<page-part>`) addresses exactly one directory — an
 * explicit namespace is never second-guessed, and a namespace that is not one of the
 * wiki's directories addresses nothing, which is why the list comes back EMPTY rather
 * than falling back to the bare order.
 *
 * `qualified` is reported so the caller can answer with the id it was asked with
 * without parsing the argument a second time.
 *
 * @param slug - The `read_page` argument, bare or qualified.
 * @returns The directories to try, the page part to look up, and whether the argument
 *   named a namespace.
 */
function lookupScope(slug: string): {
  directories: readonly (typeof READ_DIRECTORIES)[number][];
  pageSlug: string;
  qualified: boolean;
} {
  const parsed = parseQualifiedPageId(slug);
  if (parsed === null) {
    return { directories: READ_DIRECTORIES, pageSlug: slug, qualified: false };
  }
  return {
    directories: READ_DIRECTORIES.filter((directory) => directory === parsed.namespace),
    pageSlug: parsed.pagePart,
    qualified: true,
  };
}

/**
 * Resolve one page by slug or qualified page id, from the registry when there is one.
 *
 * ## Why both sources are tried, in this order
 *
 * `concepts` before `queries` is the contract `read_page` has always documented, and
 * the registry source is asked in that same order so a slug that exists in both
 * resolves identically whether it came from a row or a file.
 *
 * A QUALIFIED id (`queries/x`) is a different question and gets a different answer: it
 * addresses that one directory and never the other, because an explicit namespace is
 * what the caller used to disambiguate. It is resolved against the SAME source the bare
 * form uses, so the two branches of this function cannot disagree about which page a
 * given id names.
 *
 * The fallback is not defensive padding: a project with no database is a supported
 * deployment, and on it `pageSource` is `undefined` and the on-disk read is the only
 * correct answer. The two paths cannot disagree about a slug that exists in both,
 * because the registry is the compiled copy of that file.
 *
 * @param root - Absolute path to the wiki project root.
 * @param slug - Page slug without the `.md` extension, or a qualified page id.
 * @param pageSource - Registry-backed reader, or `undefined` to read from disk.
 * @returns The page, or `null` when neither source has it.
 */
async function readPageBySlug(
  root: string,
  slug: string,
  pageSource: PageListingSource | undefined,
): Promise<{
  slug: string;
  title: string;
  summary: string;
  body: string;
  links: readonly PageLinkRef[];
} | null> {
  if (pageSource === undefined) {
    const record = await readPageRecord(root, slug);
    if (record === null) return null;
    // `links` is OPTIONAL on `PageRecord` because other producers of that shape cannot
    // fill it; the WIRE field is not optional, so it is resolved here from the same
    // helper `readPageRecord` uses.
    return { ...record, links: record.links ?? pageLinkRefs(record.body) };
  }
  const { directories, pageSlug, qualified } = lookupScope(slug);
  for (const pageDirectory of directories) {
    const page = await getPage(root, { pageDirectory, slug: pageSlug }, pageSource);
    // Orphaned pages are skipped to match `readPageRecord`, which only reports a page
    // whose sources still exist. Serving one would answer with a body no compilation
    // claims any more.
    if (page === null || page.orphaned) continue;
    const body = page.body ?? "";
    // Both branches take the links from the SAME helper over the body, so the wire
    // object cannot differ by source. The body is already in hand, so this costs no
    // extra query — and it reads the page's own wikilinks rather than the curated
    // overlay, which is a different (review-added) edge set.
    return {
      // A bare read reports the bare stem it found; a qualified read reports the id
      // it was given, which is the form a caller can pass straight back.
      slug: qualified ? qualifiedPageId(pageDirectory, page.slug) : page.slug,
      title: page.title,
      summary: page.summary,
      body,
      links: pageLinkRefs(body),
    };
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
 * @param slug - Page slug without the `.md` extension, or a qualified page id.
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
        "Read one compiled wiki page by `slug`, including its frontmatter and full " +
        "body. `slug` is either a bare page slug (`retrieval`) or a qualified page id " +
        "(`concepts/retrieval`). A bare slug searches concepts/ then queries/; a " +
        "qualified id searches ONLY the namespace it names, which is the only way to " +
        "reach one of two pages that share a stem. Read-only. Returns the page plus " +
        "`links`: an array of `{ slug, label }` describing the page's OUTGOING " +
        "wikilinks, where `slug` is the target page's bare slug or qualified page id " +
        "— the same form this tool accepts — so it can be passed straight back to " +
        "`read_page` to follow the reference, and `label` is the " +
        "anchor text the page used (the target text itself when the wikilink has no " +
        "alias). `links` is always an array and is empty when the page links " +
        "nowhere. " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: {
        slug: z
          .string()
          .describe(
            "Page slug without the .md extension (`retrieval`), or a qualified page id " +
              "naming its directory (`concepts/retrieval`, `queries/retrieval`).",
          ),
        stackId: STACK_ID_SCHEMA,
      },
    },
    async ({ slug, stackId }) => {
      const page = await withRequestEnv(stackId, (env) =>
        withPageSource(env, (pageSource) => readPageBySlug(root, slug, pageSource)),
      );
      // A nonexistent Stack is a REFUSAL, distinct from a missing page: the caller
      // asked about a wiki that is not there, so "Page not found" would be true and
      // misleading at once.
      if (isRefusal(page)) return refusalResult(page);
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
        "empty pages, broken citations). Returns structured diagnostics. No LLM call. " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: { stackId: STACK_ID_SCHEMA },
    },
    async ({ stackId }) => {
      // `lint` IS Stack-addressed now: it resolves its page corpus, its source
      // documents and its freshness snapshot from the env it is handed. Passing the
      // per-request env is what makes a `stackId` argument mean something, and NOT
      // passing it would read whichever Stack the process happens to be bound to.
      // The remaining rule that is not Stack-addressed is `journal-health`, whose
      // subject (revert batches) does not exist for a row corpus.
      const summary = await withRequestEnv(stackId, (env) => lint(root, env));
      if (isRefusal(summary)) return refusalResult(summary);
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
        "the true totals. Read-only — never modifies the workspace. " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: { stackId: STACK_ID_SCHEMA },
    },
    async ({ stackId }) => {
      const status = await withRequestEnv(stackId, (env) =>
        withPageScan(env, (pageScan) =>
          withSourceDocuments(env, (sourceDocuments) =>
            // `env`, explicitly: the compile state is Stack-scoped, and every
            // default in `collectStatus` resolves to `process.env` — the deployment
            // this process serves, not the Stack the caller named.
            collectStatus(root, { pageScan, sourceDocuments, env }),
          ),
        ),
      );
      if (isRefusal(status)) return refusalResult(status);
      return jsonResult(status);
    },
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
  stackId: string;
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
): Promise<Awaited<ReturnType<typeof buildContextPack>> | Refusal> {
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
          // The same environment the two seams above were opened with. The pack
          // builds its page list, its counts, its freshness and its review-queue
          // length from an environment of its own; defaulted, that is `process.env`
          // -- the deployment, not the Stack the caller named.
          env,
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
        "`query_wiki` to GENERATE a grounded natural-language answer. " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: contextPackInputSchema(),
    },
    async (args) => {
      const pack = await buildContextPackFromArgs(root, args);
      if (isRefusal(pack)) return refusalResult(pack);
      return jsonResult(pack);
    },
  );
}
