/**
 * Serve the wiki page SCAN shape from rows.
 *
 * ## Why this shape and not `Page`
 *
 * Several consumers (`status`, the index builder, the refresh planner) read pages
 * through `scanWikiPages`, which returns `{ slug, meta }` -- the parsed frontmatter,
 * not a typed page. Rebuilding that from a `Page` would mean re-serialising metadata
 * a row already stores as columns, and the inverse mapping is where these would
 * drift. The adapter therefore produces the shape the consumers actually ask for.
 *
 * ## Why the handle is typed structurally
 *
 * This module reaches the DTS graph through `compiler-cli`, which cannot resolve the
 * `llmwiki-kg` package -- the same limitation documented at `compiler/index.ts`. A
 * nominal `Database` import breaks `tsup`'s declaration build, and a failed build
 * CLEARS `.llmwiki/build-stamp.json`, which wedges every subsequent test run. The
 * parameter is therefore declared by the only method this module calls.
 *
 * ## Why `meta` is reconstructed rather than stored
 *
 * `wiki.pages` keeps `title`, `summary`, `tags`, `orphaned` and `archived` as
 * columns; `meta` is just those columns under the names the file's frontmatter
 * parser produces. Building it here keeps one translation in one place instead of
 * making every consumer know both vocabularies.
 */

import { getStoredPage, listStoredPages, listStoredPagesUnfiltered } from "./page-store.js";
import type { Page, PageDirectory } from "../../pages/list.js";
import type { ResolverPageSource } from "../../compiler/resolver.js";
import type { RawWikiPage } from "../../wiki/collect.js";
import type { NamespacedPageRecord } from "../../utils/embeddings-pages.js";
import path from "node:path";

/** A page as `scanWikiPages` reports it: identity plus parsed frontmatter. */
export interface ScannedPageShape {
  slug: string;
  meta: Record<string, unknown>;
}

/** A page as `collectPageSummaries` reports it. */
export interface PageSummaryShape {
  title: string;
  slug: string;
  summary: string;
}

/**
 * The only capability this module needs from the database handle.
 *
 * Declared locally as `unknown` on purpose. `Parameters<typeof listStoredPages>[0]`
 * would pull `page-store.ts`'s real client type into the declaration graph, and that
 * type names `llmwiki-kg`, which `tsup`'s DTS build cannot resolve from here. The
 * real check happens at the CALL SITE, where `listStoredPages` still demands its own
 * parameter type -- so nothing is actually loosened.
 */
type PageStoreHandle = unknown;

/** Where the scan-shaped reads come from. */
export interface PageScanSource {
  /**
   * Every page in one wiki directory, in the scan's shape.
   *
   * @param directory - `concepts` or `queries`.
   * @returns Pages with parsed frontmatter, archived ones included (the file scan
   *   does not filter, so neither may this).
   */
  scan(directory: PageDirectory): Promise<ScannedPageShape[]>;
}

/**
 * Build the row-backed scan source for one Stack.
 *
 * @param db - Database handle.
 * @param stackId - Stack whose pages to read.
 * @returns A source for `status`, the index builder and the refresh planner.
 */
export function createPageScanSource(
  db: PageStoreHandle,
  stackId: string,
): PageScanSource {
  return {
    scan: async (directory) => {
      // UNFILTERED, and this is load-bearing: `scanWikiPages` does not filter either,
      // and its consumers classify orphaned pages rather than hiding them. Filtering
      // here would report `orphaned: false` for every page while also dropping the
      // real orphans -- a stale/orphaned count that is silently always zero.
      const pages = await listStoredPagesUnfiltered(db as never, stackId);
      return pages
        .filter((page) => page.pageDirectory === directory)
        .map(toScannedShape);
    },
  };
}

/**
 * Translate a stored page into the scan shape.
 *
 * `orphaned` and `archived` are always present, never omitted, because the file
 * frontmatter parser reports them as `undefined` when absent and every caller tests
 * them for truthiness -- a missing key and a `false` value read the same there.
 *
 * @param page - A page from the row store.
 * @returns Its scan shape.
 */
function toScannedShape(page: Page): ScannedPageShape {
  const meta: Record<string, unknown> = {
    title: page.title,
    summary: page.summary,
    tags: page.tags,
    orphaned: page.orphaned,
    archived: page.archived,
  };
  if (page.createdAt !== undefined) meta.createdAt = page.createdAt;
  if (page.updatedAt !== undefined) meta.updatedAt = page.updatedAt;
  return { slug: page.slug, meta };
}

/**
 * The `collectPageSummaries` projection, applied to a scan source.
 *
 * Mirrors `collectPageSummaries` exactly: a title is required and an orphaned page
 * is excluded. Kept beside the source so the two filter rules cannot diverge.
 *
 * @param scanned - Pages in the scan shape.
 * @returns Summaries as the index builder and status expect them.
 */
export function summarizeScanned(scanned: ScannedPageShape[]): PageSummaryShape[] {
  return scanned
    .filter(({ meta }) => meta.title && typeof meta.title === "string" && !meta.orphaned)
    .map(({ slug, meta }) => ({
      title: meta.title as string,
      slug,
      summary: typeof meta.summary === "string" ? meta.summary : "",
    }));
}

/**
 * Serve the resolver's read-modify-write view from rows.
 *
 * ## Why `content` is rebuilt from columns
 *
 * The resolver rewrites a page by replacing its BODY inside its FULL markdown
 * (`content`), then writes that back. A row stores the body and the metadata as
 * separate columns, so `content` is reconstructed here -- frontmatter rendered from
 * those columns, then the body. Rendering it in one place keeps the two from
 * drifting, and keeps the resolver from having to know a row's shape.
 *
 * @param db - Database handle.
 * @param stackId - Stack whose pages to read.
 * @returns A source for `resolveLinks`.
 */
export function createResolverPageSource(
  db: PageStoreHandle,
  stackId: string,
): ResolverPageSource {
  return {
    listConcepts: async () => {
      // Unfiltered then filtered here, so the eligibility rule lives in ONE place
      // rather than being split between this query and `indexFromSource`.
      const pages = await listStoredPagesUnfiltered(db as never, stackId);
      return pages
        .filter((page) => page.pageDirectory === "concepts" && !page.orphaned)
        .map((page) => ({
          slug: page.slug,
          title: page.title,
          content: renderPageMarkdown(page),
          body: page.body ?? "",
        }));
    },
  };
}

/**
 * Render a stored page back to the markdown a resolver expects.
 *
 * Only the fields link resolution acts on are emitted. A field the row does not hold
 * is omitted rather than written as an empty value, because `orphaned: false` and a
 * missing `orphaned` mean the same thing to the parser but render differently.
 *
 * @param page - A page from the row store.
 * @returns Frontmatter plus the page's body.
 */
function renderPageMarkdown(page: Page): string {
  const lines = [`title: ${JSON.stringify(page.title)}`];
  if (page.summary !== "") lines.push(`summary: ${JSON.stringify(page.summary)}`);
  if (page.tags.length > 0) lines.push(`tags:\n${page.tags.map((t) => `  - ${t}`).join("\n")}`);
  if (page.orphaned) lines.push("orphaned: true");
  if (page.archived) lines.push("archived: true");
  return `---\n${lines.join("\n")}\n---\n\n${page.body ?? ""}`;
}

/**
 * Serve the `RawWikiPage` shape from rows, for the export and viewer collectors.
 *
 * ## Why the parse flags are constants here
 *
 * `RawPageParseStatus` describes how well a FILE parsed. A row could not have been
 * written without valid metadata, so by construction it has a frontmatter block, has
 * no malformed YAML, and carries a title unless the column is empty. Reporting `true`
 * for `hasFrontmatterBlock` is therefore not a shortcut -- it is the only value a row
 * can have.
 *
 * @param db - Database handle.
 * @param stackId - Stack whose pages to read.
 * @param root - Project root, used only to synthesize a diagnostic path per page.
 * @returns Both wiki directories as one list, concepts first, matching the scan order.
 */
export function createRawPageSource(
  db: PageStoreHandle,
  stackId: string,
  root: string,
): RawPageSource {
  return {
    collect: async () => {
      // UNFILTERED: the collectors classify orphaned pages themselves, and the
      // listing query would have dropped them before they could be counted.
      const pages = await listStoredPagesUnfiltered(db as never, stackId);
      const toRaw = (page: Page): RawWikiPage => ({
        slug: page.slug,
        pageDirectory: page.pageDirectory,
        // Synthesized for diagnostics only: a row has no file, but every consumer
        // treats this as a label rather than opening it.
        filePath: path.join(root, "wiki", page.pageDirectory, `${page.slug}.md`),
        title: page.title === "" ? undefined : page.title,
        frontmatter: {
          title: page.title,
          summary: page.summary,
          tags: page.tags,
          ...(page.orphaned ? { orphaned: true } : {}),
          ...(page.archived ? { archived: true } : {}),
        },
        body: page.body ?? "",
        parseStatus: {
          hasFrontmatterBlock: true,
          malformedFrontmatter: false,
          hasTitle: page.title !== "",
          orphaned: page.orphaned,
        },
      });
      const inDir = (dir: PageDirectory) =>
        pages.filter((page) => page.pageDirectory === dir).map(toRaw);
      // Concepts before queries, matching `collectRawWikiPages`.
      return [...inDir("concepts"), ...inDir("queries")];
    },
  };
}

/** Where the raw page list comes from. */
export interface RawPageSource {
  /**
   * Every page in both wiki directories, concepts first.
   *
   * @returns Untitled and orphaned pages INCLUDED -- the collectors filter.
   */
  collect(): Promise<RawWikiPage[]>;
}

/**
 * Serve the embedding collector's page records from rows.
 *
 * ## Why orphaned pages are dropped here
 *
 * `readConfinedPageRecord` returns null for an orphaned page, so the disk path never
 * embeds one. Matching that rule here is not an optimisation: a row corpus that
 * embedded orphans would compute vectors for pages the next disk-backed run considers
 * gone, and the store would disagree with itself across a deployment change.
 *
 * @param db - Database handle.
 * @param stackId - Stack whose pages to read.
 * @returns Namespaced records for the two reserved directories.
 */
export function createEmbeddingPageSource(
  db: PageStoreHandle,
  stackId: string,
): EmbeddingPageSource {
  return {
    collectNamespaced: async () => {
      const pages = await listStoredPagesUnfiltered(db as never, stackId);
      const out: NamespacedPageRecord[] = [];
      for (const namespace of ["concepts", "queries"] as const) {
        for (const page of pages) {
          if (page.pageDirectory !== namespace || page.orphaned) continue;
          if (page.title === "") continue;
          out.push({
            namespace,
            record: {
              slug: page.slug,
              title: page.title,
              summary: page.summary,
              // TRIMMED, and this is load-bearing rather than cosmetic: the disk
              // reader builds its record from `page.body.trim()`, and this body goes
              // straight into `splitIntoChunks`. An untrimmed row would embed a
              // leading newline the file path never had, producing different vectors
              // for the same page -- text drift that no test of the store would show.
              body: (page.body ?? "").trim(),
            },
          });
        }
      }
      return out;
    },
    exists: async (pageId) => {
      // A qualified id is `<namespace>/<slug>`; anything else is not a page this
      // store can answer for, and "unknown" is the honest answer rather than
      // reporting it absent and pruning its vectors.
      const slash = pageId.indexOf("/");
      if (slash <= 0) return "unknown";
      const namespace = pageId.slice(0, slash);
      const slug = pageId.slice(slash + 1);
      if (namespace !== "concepts" && namespace !== "queries") return "unknown";
      const found = await getStoredPage(db as never, stackId, namespace, slug);
      return found === undefined ? "absent" : "present";
    },
  };
}

/** Where embedding collection reads pages from. */
export interface EmbeddingPageSource {
  /**
   * Every embeddable page in the two reserved directories, orphaned ones excluded.
   *
   * @returns Namespaced records, concepts before queries.
   */
  collectNamespaced(): Promise<NamespacedPageRecord[]>;

  /**
   * Whether one page id still exists for this Stack.
   *
   * @param pageId - Qualified id, e.g. `concepts/alpha`.
   * @returns `present`, `absent`, or `unknown` when the id cannot be read.
   */
  exists(pageId: string): Promise<"present" | "absent" | "unknown">;
}
