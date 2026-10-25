/**
 * @file src/dimensions/wiki/page-registry-source.ts
 * @description Answer the live page registry's questions from `wiki.pages` rows
 * instead of from the `wiki/` directory.
 *
 * ## Why this file exists
 *
 * `src/utils/page-registry.ts` is the search and answer path's reader: it decides
 * which pages are live, whether a stored vector is still fresh, and which pages a
 * language model may be shown. Its answers come from directory scans and confined
 * file reads. Compiled pages now live in Postgres, so the same questions have to be
 * answerable from rows -- and the answers must be IDENTICAL, because both backends
 * feed ONE embedding store. A page that is live to the file scan and dead to a row
 * read makes every stored vector look stale on one deployment and fresh on the next.
 *
 * ## Why the eligibility gates are imported rather than restated
 *
 * "Is this page live?" is a security-relevant decision: an ineligible page must not
 * be rankable, rehydratable, or visible to the fallback selector's model. Re-deriving
 * that rule here would give the product two truth tables that drift the first time
 * the write gate changes, so this adapter applies the very predicates the disk path
 * applies, through the same `RawEntityScan` shape they consume.
 *
 * ## Why the source contract is re-exported rather than declared here
 *
 * `RegistryPageSource` and `LiveHashes` are owned by `page-registry.ts`, which is
 * also where the seam that consumes them lives. Declaring a second copy beside this
 * adapter would let the two diverge the first time the seam grows a method, and the
 * divergence would surface as a runtime shape mismatch rather than a compile error.
 * Re-exporting keeps ONE declaration per contract while still letting a caller import
 * the whole adapter -- type and factory -- from this module.
 *
 * ## What a row genuinely cannot answer
 *
 * `wiki.pages.page_directory` is constrained to the two reserved directory names, so
 * typed entity pages have no rows at all; and a row keeps only the columns the table
 * declares, so a typed page's declared frontmatter fields are not available for a
 * field-contract check. Both gaps are stated at the code that hits them rather than
 * papered over with a permissive default.
 */

import type { Page, PageDirectory } from "../../pages/list.js";
import type { PageRecord } from "../../pages/read.js";
import type { LoadedProfile } from "../../profile/types.js";
import type { RawEntityScan } from "../../wiki/collect.js";
import {
  RESERVED_NAMESPACES,
  isLegacyScanEligible,
  isScanEligible,
  isTypedScanSurfaceEligible,
  type LiveHashes,
  type RegistryPageSource,
  type SurfaceCandidate,
} from "../../utils/page-registry.js";
import { parseQualifiedPageId, qualifiedPageId } from "../../utils/page-id.js";
import { hashChunkText, splitIntoChunks } from "../../utils/retrieval.js";
import { buildEmbeddingText } from "../../utils/embeddings-pages.js";
import { getStoredPage, listStoredPagesUnfiltered } from "./page-store.js";

/**
 * The only capability this module needs from the database handle.
 *
 * Declared as `unknown` for the same reason `page-scan-source.ts` does: naming the
 * real client type here would pull `llmwiki-kg` into `tsup`'s declaration build,
 * which cannot resolve it, and a failed build clears the build stamp and wedges
 * every later test run. The real type check still happens at each `page-store` call.
 */
type PageStoreHandle = unknown;

/**
 * Re-exported so this module is a complete import site for the adapter: a caller that
 * needs the contract and the factory gets both from one path.
 *
 * `LiveHashes` is named here on purpose even though nothing imports it FROM this path
 * yet -- `page-registry.ts` owns both declarations and remains their canonical home,
 * so this is a re-export rather than a second definition. The suppression below is
 * that decision recorded, not a blind spot: if a consumer ever does import it here,
 * the suppression stops being necessary and fallow reports it as stale.
 *
 * @see RegistryPageSource - for the method-by-method contract, owned by the registry.
 */
// fallow-ignore-next-line unused-type
export type { LiveHashes, RegistryPageSource };

/** The retrieval surfaces a typed page's `RetrievalDef` is consulted for. */
type SurfaceName = "search" | "context";

/** The rows this source reads, bound to the Stack that owns them. */
interface StoreContext {
  readonly db: PageStoreHandle;
  readonly stackId: string;
}

/**
 * Build the row-backed registry source for one Stack.
 *
 * @param db - Database handle.
 * @param stackId - Stack whose pages to read.
 * @returns A source search, answer grounding and fallback selection can use.
 */
export function createRegistryPageSource(
  db: PageStoreHandle,
  stackId: string,
): RegistryPageSource {
  const context: StoreContext = { db, stackId };
  return {
    liveIds: (namespaces, namespaceDirs, profile) =>
      collectLiveIds(context, namespaces, namespaceDirs, profile),
    liveEntry: (pageId, namespaceDirs) => collectLiveHashes(context, pageId, namespaceDirs),
    records: async (pageIds) =>
      (await resolveRecordPairs(context, pageIds)).map(({ record }) => record),
    recordPairs: (pageIds) => resolveRecordPairs(context, pageIds),
    surfaceCandidates: (surface, namespaces, namespaceDirs, profile) =>
      collectSurfaceCandidates(context, surface, namespaces, namespaceDirs, profile),
  };
}

/**
 * Every page of the Stack, orphaned and archived ones INCLUDED.
 *
 * UNFILTERED, and this is load-bearing rather than incidental: the disk scan returns
 * orphans and the eligibility gates then decide about them, and the typed gate does
 * not test `orphaned` at all. A pre-filtered query would produce the right answer for
 * reserved namespaces by accident and the wrong one for typed namespaces, while also
 * making every orphan count here silently zero.
 *
 * @param context - Bound store.
 * @returns All pages, body included.
 */
function readAllPages(context: StoreContext): Promise<Page[]> {
  return listStoredPagesUnfiltered(context.db as never, context.stackId);
}

/**
 * Translate a namespace into the `page_directory` value its rows carry.
 *
 * Two independent refusals, both deliberate. An unknown namespace (absent from the
 * caller's map) is dropped exactly as the directory scan drops it, so a caller cannot
 * reach rows by inventing a namespace. And `wiki.pages.page_directory` is constrained
 * to the reserved directory names, which means a typed entity namespace has NO rows:
 * typed pages are not stored in this table, so the honest answer is "nothing here"
 * rather than a permissive guess at where they might live.
 *
 * @param namespace - Namespace name from the caller.
 * @param namespaceDirs - Namespace→directory map, when the caller supplied one.
 * @returns The storage directory, or `undefined` when this table cannot hold it.
 */
function storedDirectory(
  namespace: string,
  namespaceDirs?: Map<string, string>,
): PageDirectory | undefined {
  if (namespaceDirs !== undefined && !namespaceDirs.has(namespace)) return undefined;
  return RESERVED_NAMESPACES.has(namespace) ? (namespace as PageDirectory) : undefined;
}

/**
 * Rebuild the scan shape the eligibility predicates consume.
 *
 * `filePath` is empty because a row has no file. That is not a weakened input: none
 * of the gates reach for it -- they read `stem`, `frontmatter` and `parseStatus` --
 * so filling in a plausible path would be inventing evidence rather than supplying it.
 *
 * The parse flags are constants for the reason `createRawPageSource` documents: a row
 * could not have been written without valid metadata, so a row always has a parsed
 * frontmatter block and never carries a YAML failure.
 *
 * @param page - A page from the row store.
 * @returns The scan shape, faithful in every field a gate reads.
 */
function toScan(page: Page): RawEntityScan {
  return {
    stem: page.slug,
    filePath: "",
    frontmatter: frontmatterFromRow(page),
    body: (page.body ?? "").trim(),
    parseStatus: {
      hasFrontmatterBlock: true,
      malformedFrontmatter: false,
      hasTitle: page.title !== "",
      orphaned: page.orphaned,
    },
  };
}

/**
 * Rebuild the frontmatter object a file's YAML would have produced.
 *
 * Falsy status flags are OMITTED rather than written as `false`, matching the parser:
 * a page without `orphaned: true` in its frontmatter has no `orphaned` key at all, and
 * every gate tests for `true` specifically. Emitting `false` would read the same today
 * and stop reading the same the moment a gate tests the key's presence.
 *
 * @param page - A page from the row store.
 * @returns The metadata under the names the frontmatter parser uses.
 */
function frontmatterFromRow(page: Page): Record<string, unknown> {
  return {
    title: page.title,
    summary: page.summary,
    tags: page.tags,
    ...(page.orphaned ? { orphaned: true } : {}),
    ...(page.archived ? { archived: true } : {}),
  };
}

/**
 * Build a `PageRecord` from a row, matching the disk reader's projection.
 *
 * `body` is TRIMMED and that is not cosmetic: the disk reader builds records from
 * `page.body.trim()`, and the body is what answer grounding renders and what chunk
 * text is re-split from. An untrimmed row would hand a consumer a leading blank line
 * the file path never produced. Note the chunk HASHES are insensitive to this -- see
 * {@link collectLiveHashes} -- so the trim protects the text, not the hashes.
 *
 * `title` falls back to the slug when the column is empty, because the disk reader
 * falls back to the slug when the TITLE IS ABSENT, and "absent" is what a row can only
 * express as an empty column. The write path already stamps the slug into that column
 * for a frontmatter with no title (`buildPage`), so the two paths agree twice over.
 * The one case they differ is a frontmatter that explicitly says `title: ""`, which the
 * disk reader preserves and this cannot distinguish from no title at all.
 *
 * @param page - A page from the row store.
 * @returns Its record, in the shape the registry loaders return.
 */
function toRecord(page: Page): PageRecord {
  return {
    slug: page.slug,
    title: page.title === "" ? page.slug : page.title,
    summary: page.summary,
    body: (page.body ?? "").trim(),
  };
}

/**
 * Resolve one qualified page id to a record, or null.
 *
 * An orphaned page yields null. Two rules exist on the disk side and they differ:
 * `readConfinedPageRecord` (the embedding collector, `embeddings-pages.ts`) drops an
 * orphan, while this registry's own `resolvePageRecord` does not test `orphaned` at
 * all. Excluding it is the stricter of the two, and it is the one that matters here:
 * records feed answer GROUNDING, so an orphan slipping through would put a retired
 * page's prose in front of the reader as evidence. The divergence is named rather
 * than hidden -- a caller that needs the looser disk behaviour would have to ask for
 * it explicitly.
 *
 * @param context - Bound store.
 * @param pageId - Qualified page id.
 * @returns The record, or null when absent, malformed, or orphaned.
 */
async function resolveRecord(context: StoreContext, pageId: string): Promise<PageRecord | null> {
  const parsed = parseQualifiedPageId(pageId);
  if (parsed === null) return null;
  const directory = storedDirectory(parsed.namespace);
  if (directory === undefined) return null;
  const page = await getStoredPage(context.db as never, context.stackId, directory, parsed.pagePart);
  if (page === undefined || page.orphaned) return null;
  return toRecord(page);
}

/**
 * Resolve ids to `{pageId, record}` pairs, dropping the ones that do not resolve.
 *
 * @param context - Bound store.
 * @param pageIds - Qualified page ids.
 * @returns Pairs, in the order the ids were given.
 */
async function resolveRecordPairs(
  context: StoreContext,
  pageIds: string[],
): Promise<Array<{ pageId: string; record: PageRecord }>> {
  const pairs: Array<{ pageId: string; record: PageRecord }> = [];
  for (const pageId of pageIds) {
    const record = await resolveRecord(context, pageId);
    if (record !== null) pairs.push({ pageId, record });
  }
  return pairs;
}

/**
 * Collect the embed-eligible page ids across namespaces.
 *
 * @param context - Bound store.
 * @param namespaces - Namespace names to include.
 * @param namespaceDirs - Namespace→directory map.
 * @param profile - Active profile, for typed-namespace gating.
 * @returns Qualified ids of the pages that pass the shared gate.
 */
async function collectLiveIds(
  context: StoreContext,
  namespaces: string[],
  namespaceDirs: Map<string, string>,
  profile?: LoadedProfile,
): Promise<Set<string>> {
  const pages = await readAllPages(context);
  const ids = new Set<string>();
  for (const namespace of namespaces) {
    for (const page of pagesIn(namespace, namespaceDirs, pages)) {
      if (!isScanEligible(toScan(page), namespace, profile)) continue;
      ids.add(qualifiedPageId(namespace, page.slug));
    }
  }
  return ids;
}

/**
 * The rows belonging to one namespace, in table order.
 *
 * @param namespace - Namespace name.
 * @param namespaceDirs - Namespace→directory map.
 * @param pages - Every page of the Stack.
 * @returns The subset this namespace names; empty when it names no stored directory.
 */
function pagesIn(namespace: string, namespaceDirs: Map<string, string>, pages: Page[]): Page[] {
  const directory = storedDirectory(namespace, namespaceDirs);
  if (directory === undefined) return [];
  return pages.filter((page) => page.pageDirectory === directory);
}

/**
 * Collect the candidates one retrieval surface may show.
 *
 * Reserved namespaces take the legacy gate; a typed namespace needs its profile
 * declaration and takes the surface-flag gate. Keeping those two rules in one place
 * means a reserved page can never be admitted by the typed rule or vice versa.
 *
 * @param context - Bound store.
 * @param surface - Retrieval surface being served.
 * @param namespaces - Namespace names to include.
 * @param namespaceDirs - Namespace→directory map.
 * @param profile - Active profile, for typed-namespace gating.
 * @returns Candidates carrying title and summary for fallback selection.
 */
async function collectSurfaceCandidates(
  context: StoreContext,
  surface: SurfaceName,
  namespaces: string[],
  namespaceDirs: Map<string, string>,
  profile?: LoadedProfile,
): Promise<SurfaceCandidate[]> {
  const pages = await readAllPages(context);
  const candidates: SurfaceCandidate[] = [];
  for (const namespace of namespaces) {
    for (const page of pagesIn(namespace, namespaceDirs, pages)) {
      if (!isSurfaceEligible(toScan(page), namespace, surface, profile)) continue;
      candidates.push({
        pageId: qualifiedPageId(namespace, page.slug),
        slug: page.slug,
        title: page.title,
        summary: page.summary,
      });
    }
  }
  return candidates;
}

/**
 * Whether a scan passes the eligibility gate for one SURFACE.
 *
 * The typed branch needs the entity type's declaration, so a typed namespace with no
 * declaration yields nothing -- the same fail-closed answer the disk path gives. That
 * branch is also where the row's information gap is: a row stores no declared fields,
 * so a type with required fields can never validate here.
 *
 * @param scan - The page in scan shape.
 * @param namespace - Namespace the page belongs to.
 * @param surface - Retrieval surface being served.
 * @param profile - Active profile, when one is loaded.
 * @returns True when the page may be surfaced.
 */
function isSurfaceEligible(
  scan: RawEntityScan,
  namespace: string,
  surface: SurfaceName,
  profile?: LoadedProfile,
): boolean {
  if (RESERVED_NAMESPACES.has(namespace)) return isLegacyScanEligible(scan);
  const definition = profile?.profile.entities[namespace];
  if (definition === undefined) return false;
  return isTypedScanSurfaceEligible(scan, definition, surface);
}

/**
 * Compute the live hashes for one page id.
 *
 * Both hashes use `hashChunkText`, the same function the chunk store uses, so a
 * stored vector's `contentHash` is byte-comparable against these values.
 *
 * Measured while writing this: `splitIntoChunks` trims every paragraph, so body-edge
 * whitespace does not reach a chunk and therefore cannot change these hashes. The trim
 * in {@link toRecord} is still required for parity -- it protects the TEXT a consumer
 * reads, which is a different contract from the hash.
 *
 * @param context - Bound store.
 * @param pageId - Qualified page id.
 * @param namespaceDirs - Namespace→directory map.
 * @returns The live hashes, or null when the id is absent or unreadable.
 */
async function collectLiveHashes(
  context: StoreContext,
  pageId: string,
  namespaceDirs: Map<string, string>,
): Promise<LiveHashes | null> {
  const parsed = parseQualifiedPageId(pageId);
  if (parsed === null) return null;
  const directory = storedDirectory(parsed.namespace, namespaceDirs);
  if (directory === undefined) return null;
  const page = await getStoredPage(context.db as never, context.stackId, directory, parsed.pagePart);
  if (page === undefined) return null;
  const record = toRecord(page);
  return {
    embeddingTextHash: hashChunkText(buildEmbeddingText(record)),
    chunkHashes: splitIntoChunks(record.body).map(hashChunkText),
  };
}
