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

import { listPages, getPage } from "../../pages/list.js";
import { pickSearchRefs } from "../../search/retrieval.js";
import type {
  DimensionAnswer,
  DimensionQuery,
  DimensionReader,
  GraphReadResult,
  ReadChunk,
} from "../read-types.js";
import {
  DEFAULT_PAGE_LIMIT,
  answerFromPages,
  resolvePageByName,
  scopeByKinds,
} from "./page-answer.js";

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
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT;

  // A named lookup is answered by exact-or-containing title match, because the
  // caller asked for ONE thing and paging every page to find it would be wasteful.
  if (query.name !== undefined && query.name.trim() !== "") {
    return readByName(root, query.name, query.kinds);
  }

  const listing = await listPages(root, { limit });
  const scoped = scopeByKinds(listing.pages, query.kinds);

  // Text search is a SEPARATE capability: it needs the embedding store, and a
  // project without one still answers the listing.
  const chunks = query.text === undefined || query.text.trim() === ""
    ? []
    : await searchChunks(root, query.text, limit);

  return { ok: true, value: { ...answerFromPages(scoped), chunks } };
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
  const page = resolvePageByName(scopeByKinds(listing.pages, kinds), name);

  if (page === undefined) {
    return {
      ok: false,
      error: { code: "not_found", message: `No wiki page named '${name}'` },
    };
  }
  return { ok: true, value: answerFromPages([page]) };
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
