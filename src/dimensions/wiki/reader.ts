/**
 * @file src/dimensions/wiki/reader.ts
 * @description The wiki dimension as a READER: it answers questions about the
 * compiled pages.
 *
 * ## What the wiki can and cannot answer
 *
 * The wiki stores COMPILED CONCEPTS — one markdown page per merged concept, with a
 * title, a summary, and the sources that contributed it. It has:
 *
 *   - entities  -> pages, whose kind is the page's directory (`concepts`, `queries`)
 *   - chunks    -> page bodies matched by the semantic search path
 *
 * It has NO relationships: interlinks are rendered as `[[wikilinks]]` inside a
 * body, and a link is not a typed edge with a confidence. So this reader returns
 * an empty `relationships` array rather than inventing an edge kind the store
 * cannot back. `confidence` is likewise absent — the wiki has no extraction
 * confidence, and faking one would make cross-dimension ranking meaningless.
 *
 * ## Why it reuses the existing search rather than querying files itself
 *
 * `pickSearchRefs` already owns the semantic path (chunk vectors, page vectors,
 * index fallback, degrade warnings). Re-implementing retrieval here would create a
 * second answer to "what is relevant" that drifts from the one `query` uses.
 */

import { listPages, getPage, type Page } from "../../pages/list.js";
import { pickSearchRefs } from "../../search/retrieval.js";
import type {
  DimensionAnswer,
  DimensionQuery,
  DimensionReader,
  GraphReadResult,
  ReadChunk,
  ReadEntity,
} from "../read-types.js";

/** Default cap when the caller does not set one. */
const DEFAULT_LIMIT = 20;

/** Map a compiled page onto the dimension-neutral entity shape. */
function toReadEntity(page: Page): ReadEntity {
  return {
    id: page.slug,
    name: page.title,
    // The page's directory is its kind: the wiki has no other taxonomy.
    kind: page.pageDirectory,
    description: page.summary,
  };
}

/**
 * Match pages whose title or summary contains the query text.
 *
 * A LITERAL, case-insensitive containment test, not a fuzzy match: the semantic
 * path is applied separately when the caller asks for `text`, and blending the two
 * here would make it impossible to tell which signal produced a result.
 *
 * @param pages - Pages to filter.
 * @param text - Lowercased needle.
 * @returns Pages that mention the text.
 */
function matchingPages(pages: readonly Page[], text: string): Page[] {
  const needle = text.toLowerCase();
  return pages.filter(
    (page) =>
      page.title.toLowerCase().includes(needle) ||
      page.summary.toLowerCase().includes(needle),
  );
}

/**
 * Answer one question against the compiled wiki.
 *
 * @param root - Absolute path to the wiki project root.
 * @param query - What to look for.
 * @returns The answer, or a coded failure.
 */
async function readWiki(
  root: string,
  query: DimensionQuery,
): Promise<GraphReadResult<DimensionAnswer>> {
  const limit = query.limit ?? DEFAULT_LIMIT;

  // A named lookup is answered by exact-or-containing title match, because the
  // caller asked for ONE thing and paging every page to find it would be wasteful.
  if (query.name !== undefined && query.name.trim() !== "") {
    return readByName(root, query.name, query.kinds);
  }

  const listing = await listPages(root, { limit });
  const scoped =
    query.kinds === undefined || query.kinds.length === 0
      ? listing.pages
      : listing.pages.filter((page) => query.kinds?.includes(page.pageDirectory));

  const entities = scoped.map(toReadEntity);

  // Text search is a SEPARATE capability: it needs the embedding store, and a
  // project without one still answers the listing.
  const chunks = query.text === undefined || query.text.trim() === ""
    ? []
    : await searchChunks(root, query.text, limit);

  return { ok: true, value: { entities, relationships: [], chunks } };
}

/**
 * One page by title, case-insensitively, falling back to a substring match.
 *
 * The two-step order matters: an exact title is unambiguous, while a substring is
 * a convenience that can match several pages, so it is only consulted when the
 * exact tier found nothing.
 *
 * @param root - Project root.
 * @param name - Requested title.
 * @param kinds - Optional directory restriction.
 * @returns The single match, or `not_found`.
 */
async function readByName(
  root: string,
  name: string,
  kinds: readonly string[] | undefined,
): Promise<GraphReadResult<DimensionAnswer>> {
  const listing = await listPages(root, { limit: Number.MAX_SAFE_INTEGER });
  const scoped =
    kinds === undefined || kinds.length === 0
      ? listing.pages
      : listing.pages.filter((page) => kinds.includes(page.pageDirectory));

  const needle = name.toLowerCase();
  const exact = scoped.filter((page) => page.title.toLowerCase() === needle);
  const found = exact.length > 0 ? exact : matchingPages(scoped, needle);
  const page = found[0];

  if (page === undefined) {
    return {
      ok: false,
      error: { code: "not_found", message: `No wiki page named '${name}'` },
    };
  }
  return { ok: true, value: { entities: [toReadEntity(page)], relationships: [], chunks: [] } };
}

/**
 * Retrieve page passages that match the query text.
 *
 * Reports `unavailable` when the retrieval path cannot run — a project with no
 * embedding store still has pages, and saying "no matches" would be
 * indistinguishable from "search is off".
 *
 * @param root - Project root.
 * @param text - Query text.
 * @param limit - Cap on returned passages.
 * @returns Matching passages, or an empty list when the store is absent.
 */
async function searchChunks(
  root: string,
  text: string,
  limit: number,
): Promise<readonly ReadChunk[]> {
  try {
    const selection = await pickSearchRefs(root, text, { embeddingFailure: "fallback" });
    const refs = selection.refs.slice(0, limit);
    const chunks: ReadChunk[] = [];
    for (const ref of refs) {
      chunks.push({
        content: await passageOf(root, ref.slug),
        sourceId: ref.slug,
        // `kind` is the signal that produced the ref, so it is the honest rank.
        score: ref.kind === "chunk" ? 1 : ref.kind === "page" ? 0.5 : 0.25,
      });
    }
    return chunks;
  } catch {
    // An absent or unusable embedding store is a capability gap, not a failure of
    // the question, so the listing still answers and the chunks are simply empty.
    return [];
  }
}

/** Read a page body for a chunk, returning an empty string when it vanished. */
async function passageOf(root: string, slug: string): Promise<string> {
  const page = await getPage(root, { slug, pageDirectory: "concepts" });
  return page?.body ?? "";
}

/**
 * Build the wiki dimension's reader.
 *
 * @param root - Absolute path to the wiki project root.
 * @returns A reader bound to that project.
 */
export function createWikiReader(root: string): DimensionReader {
  return {
    name: "wiki",
    read: (query: DimensionQuery) => readWiki(root, query),
  };
}
