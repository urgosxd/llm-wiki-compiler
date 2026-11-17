/**
 * MCP resource registrations for llmwiki.
 *
 * Resources expose read-only views of the wiki under the llmwiki:// URI
 * scheme. Hosts can attach these as context without invoking a tool —
 * useful for letting agents browse the wiki passively.
 *
 * ## The price of "do not invent ambient resolution", stated here on purpose
 *
 * A resource URI has nowhere to put a Stack: there is no `stackId` argument on this
 * surface, and this build no longer invents one from the process environment. So on a
 * run WITH a database configured, every resource that reads a Stack REFUSES BY NAME —
 * `llmwiki://state`, `llmwiki://concept/{slug}` and `llmwiki://query/{slug}` are
 * unusable there until the URI itself can carry a Stack.
 *
 * Making them usable again means changing the URI contract: `llmwiki://pages/foo`
 * becomes `llmwiki://<stack>/pages/foo`. That renames a surface clients already
 * consume, so it is a DELIBERATE breaking change to a published interface, named as
 * S5's price in `odd/tasks/stack-authority-per-request.md` so that it is never later
 * filed as a stylistic gap or an open question.
 *
 * The resources that read only THIS checkout's files and never consulted a database —
 * `llmwiki://index`, `llmwiki://sources`, `llmwiki://eval/report`,
 * `llmwiki://eval/history` — keep answering. Refusing them would invent a failure the
 * old code did not have, and S3 forbids falling back to files only where a database
 * actually holds the rows.
 */

import path from "path";
import { readdir } from "fs/promises";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isDatabaseConfigured } from "../dimensions/activation.js";
import {
  readStateClassifiedFor,
  withPageScan,
  withPageSource,
} from "../dimensions/wiki/page-source-seam.js";
import { loadPreviousReport, loadHistory } from "../eval/stats.js";
import type { PageDirectory } from "../export/types.js";
import { missingStackRefusal } from "../services/stacks/resolve-stack.js";
import { listSelectedSourceFiles } from "../sources/scan.js";
import { CONCEPTS_DIR, INDEX_FILE, QUERIES_DIR, SOURCES_DIR, STATE_FILE } from "../utils/constants.js";
import { safeReadFile, parseFrontmatter } from "../utils/markdown.js";

/** Standard JSON content block for an MCP resource read result. */
function jsonContent(uri: URL, payload: unknown): {
  uri: string;
  mimeType: string;
  text: string;
} {
  return {
    uri: uri.href,
    mimeType: "application/json",
    text: JSON.stringify(payload, null, 2),
  };
}

/**
 * Refuse a Stack-scoped resource read on a run that has a database configured.
 *
 * ## Why the reason is the SHAPE of the surface
 *
 * The caller did not forget anything: an `llmwiki://` URI has no argument in which to
 * carry a Stack, so "name one" would be advice it cannot follow. The refusal says so,
 * and points at the surface that CAN carry one — which is the sentence a client learns
 * the limits of this API from.
 *
 * ## Why it runs BEFORE anything else
 *
 * A database-configured run must not read this checkout's files and present them as the
 * Stack's answer (S3), and it must not resolve a Stack from the environment either (S5).
 * Refusing at the top means neither can happen for want of a check later on.
 *
 * @param read - The URI, or the URI template, the caller asked for.
 * @throws {Error} always, when a database is configured; the resource surface's only
 *   failure channel, since a resource read has no `isError` envelope.
 */
function refuseStackScopedResource(read: string): void {
  if (!isDatabaseConfigured(process.env)) return;
  throw new Error(
    missingStackRefusal(
      `${read} was read as an MCP resource, and a resource URI cannot carry a Stack.`,
      "Call a tool that takes a stackId argument instead (read_page, wiki_status), " +
        "or run this server with no database configured.",
    ),
  );
}

/** Standard markdown content block for an MCP resource read result. */
function markdownContent(uri: URL, text: string): {
  uri: string;
  mimeType: string;
  text: string;
} {
  return {
    uri: uri.href,
    mimeType: "text/markdown",
    text,
  };
}

/** Register all 7 read-only wiki resources on the given MCP server. */
export function registerWikiResources(server: McpServer, root: string): void {
  registerIndexResource(server, root);
  registerSourcesResource(server, root);
  registerStateResource(server, root);
  // Page READS resolve their backend lazily, per request. Registration happens once
  // at server start, but a Stack is an environment fact that can differ between
  // invocations -- and opening a pool at registration would hold one for the life of
  // the server even when no page is ever read.
  registerConceptResource(server, root);
  registerQueryResource(server, root);
  registerEvalReportResource(server, root);
  registerEvalHistoryResource(server, root);
}

function registerIndexResource(server: McpServer, root: string): void {
  server.registerResource(
    "wiki-index",
    "llmwiki://index",
    {
      title: "Wiki Index",
      description: "Full content of wiki/index.md (auto-generated table of contents).",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const content = await safeReadFile(path.join(root, INDEX_FILE));
      return { contents: [markdownContent(uri, content)] };
    },
  );
}

function registerSourcesResource(server: McpServer, root: string): void {
  server.registerResource(
    "wiki-sources",
    "llmwiki://sources",
    {
      title: "Wiki Sources",
      description: "List of ingested source files with frontmatter metadata.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [jsonContent(uri, await listSources(root))],
    }),
  );
}

function registerStateResource(server: McpServer, root: string): void {
  server.registerResource(
    "wiki-state",
    "llmwiki://state",
    {
      title: "Compilation State",
      description: "Per-source hashes, concepts, and last compile times from the compile state.",
      mimeType: "application/json",
    },
    async (uri) => {
      refuseStackScopedResource(uri.href);
      const { status, state } = await readStateClassifiedFor(root);
      // Fail closed on a too-new state: every sibling surface branches on
      // `status`, so the resource must too rather than streaming a body written
      // by a newer llmwiki as if it were healthy. "ok"/"missing"/"corrupt" keep
      // their current byte-identical output (the carried state body).
      if (status === "too-new") {
        return {
          contents: [
            jsonContent(uri, {
              stateStatus: "too-new",
              error: "written by a newer llmwiki version",
            }),
          ],
        };
      }
      return { contents: [jsonContent(uri, state)] };
    },
  );
}

function registerConceptResource(server: McpServer, root: string): void {
  server.registerResource(
    "wiki-concept",
    new ResourceTemplate("llmwiki://concept/{slug}", {
      list: async () => listPagesUnder(root, CONCEPTS_DIR, "concept", "concepts"),
    }),
    {
      title: "Wiki Concept",
      description: "A single concept page from wiki/concepts/ — frontmatter plus body.",
      mimeType: "application/json",
    },
    async (uri, { slug }) => {
      refuseStackScopedResource(uri.href);
      return {
        contents: [jsonContent(uri, await loadPageWithMeta(root, CONCEPTS_DIR, String(slug), "concepts"))],
      };
    },
  );
}

function registerQueryResource(server: McpServer, root: string): void {
  server.registerResource(
    "wiki-query",
    new ResourceTemplate("llmwiki://query/{slug}", {
      list: async () => listPagesUnder(root, QUERIES_DIR, "query", "queries"),
    }),
    {
      title: "Wiki Query",
      description: "A single saved query page from wiki/queries/ — frontmatter plus body.",
      mimeType: "application/json",
    },
    async (uri, { slug }) => {
      refuseStackScopedResource(uri.href);
      return {
        contents: [jsonContent(uri, await loadPageWithMeta(root, QUERIES_DIR, String(slug), "queries"))],
      };
    },
  );
}

/** Source listing: filename, frontmatter (truncation, source URL, etc.). */
async function listSources(root: string): Promise<Array<Record<string, unknown>>> {
  const sourcesPath = path.join(root, SOURCES_DIR);
  const files = await listSelectedSourceFiles(root);

  const records: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const content = await safeReadFile(path.join(sourcesPath, file));
    const { meta } = parseFrontmatter(content);
    records.push({ filename: file, ...meta });
  }
  return records;
}

/** Read a single page and return a structured payload (slug, meta, body). */
async function loadPageWithMeta(
  root: string,
  dir: string,
  slug: string,
  directory?: PageDirectory,
): Promise<{ slug: string; meta: Record<string, unknown>; body: string }> {
  if (directory !== undefined) {
    // The LISTING source, not the scan source: a body is a column here, and the
    // scan shape carries only frontmatter. Reading it from `meta` would have been
    // reading a key that does not exist.
    const fromRows = await withPageSource(process.env, (source) =>
      source === undefined
        ? Promise.resolve(null)
        : source.get(directory, slug));
    if (fromRows !== null) {
      return {
        slug,
        meta: { title: fromRows.title, summary: fromRows.summary, tags: fromRows.tags },
        body: (fromRows.body ?? "").trim(),
      };
    }
  }
  const filePath = path.join(root, dir, `${slug}.md`);
  const content = await safeReadFile(filePath);
  if (!content) {
    throw new Error(`Page not found: ${dir}/${slug}.md`);
  }

  const { meta, body } = parseFrontmatter(content);
  return { slug, meta, body: body.trim() };
}

function registerEvalReportResource(server: McpServer, root: string): void {
  server.registerResource(
    "eval-report",
    "llmwiki://eval/report",
    {
      title: "Eval Report",
      description: "Latest eval report — health score, citation coverage, corpus stats.",
      mimeType: "application/json",
    },
    async (uri) => {
      const report = await loadPreviousReport(root);
      return { contents: [jsonContent(uri, report ?? {})] };
    },
  );
}

function registerEvalHistoryResource(server: McpServer, root: string): void {
  server.registerResource(
    "eval-history",
    "llmwiki://eval/history",
    {
      title: "Eval History",
      description: "Eval run history — trend table of past eval reports.",
      mimeType: "application/json",
    },
    async (uri) => {
      const reports = await loadHistory(root);
      return { contents: [jsonContent(uri, reports)] };
    },
  );
}

/** Build a resource list payload by enumerating .md files in a wiki directory. */
async function listPagesUnder(
  root: string,
  dir: string,
  scheme: "concept" | "query",
  directory?: PageDirectory,
): Promise<{ resources: Array<{ uri: string; name: string }> }> {
  // A listing is a resource read too: on a database-configured run it would enumerate the
  // rows of a Stack nobody named. An empty list would read as "this Stack has no pages".
  refuseStackScopedResource(`llmwiki://${scheme}/{slug}`);
  if (directory !== undefined) {
    const fromRows = await withPageScan(process.env, (scan) =>
      scan === undefined ? Promise.resolve(undefined) : scan.scan(directory));
    if (fromRows !== undefined) {
      return {
        resources: fromRows.map((page) => ({
          uri: `llmwiki://${scheme}/${page.slug}`,
          name: typeof page.meta.title === "string" ? page.meta.title : page.slug,
        })),
      };
    }
  }
  const pagesPath = path.join(root, dir);
  let files: string[];
  try {
    files = await readdir(pagesPath);
  } catch {
    return { resources: [] };
  }

  const resources = files
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const slug = f.replace(/\.md$/, "");
      // S13: percent-encode the slug so a page-part containing spaces or `#`
      // (e.g. `Foo #1`) round-trips through the URI rather than truncating at
      // the `#` fragment delimiter. The read template decodes `{slug}` back.
      return { uri: `llmwiki://${scheme}/${encodeURIComponent(slug)}`, name: slug };
    });

  return { resources };
}
