/**
 * Wiki index generator.
 *
 * Scans all concept pages in wiki/concepts/, extracts frontmatter metadata,
 * and produces wiki/index.md with a sorted list of all concepts and their
 * summaries. Used after each compilation pass.
 */

import { readdir } from "fs/promises";
import path from "path";
import { atomicWrite, parseFrontmatter } from "../utils/markdown.js";
import { withDerivedSource } from "../dimensions/wiki/derived-artifact-source.js";
import { readWikiPageInDirOrWarn, readConfinedWikiPage } from "./confined-wiki-read.js";
import { toPosixPath } from "../utils/path-confine.js";
import { projectSummaries } from "../dimensions/wiki/page-scan-source.js";
import { CONCEPTS_DIR, QUERIES_DIR, INDEX_FILE } from "../utils/constants.js";
import {
  summarizeScanned,
  type PageScanSource,
} from "../dimensions/wiki/page-scan-source.js";
import * as output from "../utils/output.js";
import type { PageSummary } from "../utils/types.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import type { EntityPage } from "../profile/types.js";

/**
 * Generate the wiki/index.md listing all concept pages with summaries.
 *
 * For a NON-DEFAULT profile project this ADDITIVELY appends one section per
 * declared entity type, enumerating each promoted typed page with a link to
 * `<entityType>/<slug>.md`. For a DEFAULT project (no profile.json) the index is
 * built byte-identically to before — the typed sections only ever appear when a
 * non-default profile is active.
 *
 * @param root - Project root directory.
 * @param env - The RUN's environment; it names the Stack the render is stored in.
 *   Required rather than defaulted to `process.env`: a default is what let a
 *   per-request run render this artifact into the AMBIENT Stack, and a required
 *   parameter makes every caller state its tenant instead of inheriting one.
 * @param scanSource - Row-backed scan source, or undefined to scan `wiki/` on disk.
 */
export async function generateIndex(
  root: string,
  env: NodeJS.ProcessEnv,
  scanSource?: PageScanSource,
): Promise<void> {
  output.status("*", output.info("Generating index..."));

  const [concepts, queries] = scanSource === undefined
    ? await Promise.all([
      collectPageSummaries(path.join(root, CONCEPTS_DIR)),
      collectPageSummaries(path.join(root, QUERIES_DIR)),
    ])
    // Rows when they are the corpus: the file path would summarize an empty
    // directory and write an index listing nothing.
    : await Promise.all([
      scanSource.scan("concepts").then(summarizeScanned),
      scanSource.scan("queries").then(summarizeScanned),
    ]);

  concepts.sort((a, b) => a.title.localeCompare(b.title));
  queries.sort((a, b) => a.title.localeCompare(b.title));

  const entityPages = await collectTypedPages(root);
  const indexContent = buildIndexContent(concepts, queries, entityPages);
  // A Stack stores the render; the file is what a project without one gets, byte for
  // byte as before. `index.md` is DERIVED -- nothing reads it back -- so there is no
  // reader to keep in sync, only the write to redirect.
  //
  // The Stack is the one `env` names, NOT the ambient one: this render belongs to the
  // run that produced it, and reading `process.env` here wrote one tenant's index into
  // another tenant's rows.
  const stored = await withDerivedSource(env, async (source) => {
    if (source === undefined) return false;
    if (isSameRender(await source.read("index"), indexContent)) return true;
    await source.save("index", indexContent);
    return true;
  });
  if (!stored && !isSameRender(await readStoredIndex(root), indexContent)) {
    await atomicWrite(path.join(root, INDEX_FILE), indexContent, { confineRoot: root });
  }

  // Typed pages are rendered in the index, so the count must include them too
  // (empty for a DEFAULT project → unchanged "concepts + queries" total).
  const total = concepts.length + queries.length + entityPages.length;
  output.status("+", output.success(`Index updated with ${total} pages.`));
}

/**
 * No typed entity pages exist any more, so the index has no entity sections.
 *
 * @param _root - Project root directory (unused).
 * @returns Always an empty list.
 */
async function collectTypedPages(_root: string): Promise<EntityPage[]> {
  return [];
}

/**
 * The run stamp the index carries, which is the ONE part of a render that changes by
 * itself.
 *
 * Matched by shape rather than by `\S+` so the closing emphasis of the footer line is
 * not swallowed with the timestamp: a difference in the markup must still count as a
 * difference.
 */
const RUN_STAMP = /Generated [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/u;

/** What both sides of the comparison carry instead of a run stamp. */
const STAMP_PLACEHOLDER = "Generated <stamp>";

/**
 * Whether an already-rendered index says the same thing as this run's render.
 *
 * WHY THIS EXISTS AND WHAT IT PROTECTS. `index.md` used to be rewritten on every
 * regeneration with a fresh `Generated <ISO>` footer, so a compile whose sources did not
 * change still dirtied a tracked file -- a compile that did no work left a diff behind,
 * and a no-op ingest could not be told apart from a real one by looking at the wiki. The
 * timestamp is a build marker, not content: the page list, its order and its counts are
 * the content. So the stamp is EXCLUDED from the comparison and two renders that agree on
 * everything else are the same index, which then is not written at all. The stamp is
 * deliberately NOT made stable in the artifact (a single frozen timestamp would claim a
 * build date the wiki never had); it simply keeps the value from the last real change,
 * which is the honest answer to "when did this listing last change".
 *
 * @param existing - Bytes already stored, or undefined when nothing was generated yet.
 * @param next - This run's render.
 * @returns True when writing `next` would change no byte that is not a run stamp.
 */
function isSameRender(existing: string | undefined, next: string): boolean {
  if (existing === undefined) return false;
  return withoutRunStamp(existing) === withoutRunStamp(next);
}

/**
 * Replace the run stamp with a fixed marker so two renders can be compared on content.
 *
 * @param markdown - A rendered or stored index.
 * @returns The same text with its own stamp neutralised.
 */
function withoutRunStamp(markdown: string): string {
  return markdown.replace(RUN_STAMP, STAMP_PLACEHOLDER);
}

/**
 * The index currently on disk, read through the confined no-follow reader.
 *
 * A drop -- absent file, escaping symlink, unreadable leaf -- yields `undefined`, which
 * reads as "no current render" and therefore as a real change. That is the safe
 * direction: the alternative would skip a write because the previous file could not be
 * inspected.
 *
 * @param root - Project root the index lives under.
 * @returns Its bytes, or undefined when there are none to compare against.
 */
async function readStoredIndex(root: string): Promise<string | undefined> {
  const result = await readConfinedWikiPage(root, WIKI_ROOT, path.basename(INDEX_FILE, ".md"));
  return "content" in result ? result.content : undefined;
}

/** A scanned page paired with its parsed frontmatter. */
interface ScannedPage {
  slug: string;
  meta: Record<string, unknown>;
}

/**
 * Scan a wiki directory and return every .md page paired with its parsed
 * frontmatter. Read-only utility shared by index generation and the MCP
 * server's status tool.
 * @param dirPath - Absolute path to a wiki page directory.
 * @returns Array of {slug, meta} entries — empty when the directory is missing.
 */
export async function scanWikiPages(dirPath: string): Promise<ScannedPage[]> {
  let files: string[];
  try {
    files = await readdir(dirPath);
  } catch {
    return [];
  }

  // The scan directory is itself the confinement boundary: a symlinked entry
  // whose target escapes `dirPath` is dropped (warned, skipped) and never enters
  // the scan, keeping its bytes out of any index/summary derived from it.
  const scanned: ScannedPage[] = [];
  for (const file of files.filter((f) => f.endsWith(".md"))) {
    const slug = file.replace(/\.md$/, "");
    const result = await readWikiPageInDirOrWarn(dirPath, slug);
    if (!("content" in result)) continue; // dropped (symlink escape / fail-closed)
    const { meta } = parseFrontmatter(result.content);
    scanned.push({ slug, meta });
  }
  return scanned;
}

/**
 * Project a wiki directory into PageSummary entries (excludes orphaned and
 * untitled pages). Built on top of scanWikiPages so the MCP server can share
 * the underlying scan logic without re-reading the directory.
 * @param conceptsPath - Absolute path to wiki/concepts/.
 * @returns Array of page summary objects.
 */
export async function collectPageSummaries(
  conceptsPath: string,
): Promise<PageSummary[]> {
  // The projection is SHARED with the row-backed scan, so an index built from files
  // and one built from rows cannot disagree about which pages are listable.
  return projectSummaries(await scanWikiPages(conceptsPath));
}

/** Strip [[wikilink]] brackets from text, leaving the inner text intact. */
function stripWikilinks(text: string): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, "$1");
}

/**
 * Build the index.md markdown content from page summaries.
 *
 * The concepts/queries/footer rendering is UNCHANGED — when `entityPages` is
 * empty (every DEFAULT project) the output is byte-identical to before. Typed
 * entity sections are appended only when a non-default profile supplied pages.
 *
 * @param concepts - Sorted concept page summaries.
 * @param queries - Sorted saved-query page summaries.
 * @param entityPages - Non-default profile entity pages (empty for defaults).
 * @returns Full index.md content string.
 */
function buildIndexContent(
  concepts: PageSummary[],
  queries: PageSummary[],
  entityPages: EntityPage[] = [],
): string {
  const lines = ["# Knowledge Wiki", "", "## Concepts", ""];

  for (const page of concepts) {
    lines.push(`- **[[${page.slug}|${page.title}]]** — ${stripWikilinks(page.summary)}`);
  }

  if (queries.length > 0) {
    lines.push("", "## Saved Queries", "");
    for (const page of queries) {
      lines.push(`- **[[${page.slug}|${page.title}]]** — ${stripWikilinks(page.summary)}`);
    }
  }

  lines.push(...buildEntitySections(entityPages));

  // Footer count mirrors what's rendered: concepts + queries + typed pages.
  // entityPages is empty for DEFAULT projects, keeping that footer byte-identical.
  const total = concepts.length + queries.length + entityPages.length;
  lines.push("");
  lines.push(`_${total} pages | Generated ${new Date().toISOString()}_`);
  lines.push("");

  return lines.join("\n");
}

/**
 * The wiki root the index lives in (`wiki`), derived from {@link INDEX_FILE}
 * (`wiki/index.md`). Entity-page links are relativized against this so a link
 * stays correct relative to the index regardless of the configured wiki root.
 */
const WIKI_ROOT = path.dirname(INDEX_FILE);

/** Capitalize an entity type for a section heading (e.g. `papers` → `Papers`). */
function entityTypeHeading(entityType: string): string {
  return entityType.charAt(0).toUpperCase() + entityType.slice(1);
}

/**
 * Render one additive markdown section per entity type, each listing its typed
 * pages with a link to `<entityType>/<slug>.md` (relative to the index, which
 * lives in `wiki/`). Pages are grouped by type and sorted by slug for stable
 * output. Returns `[]` for a default project so the footer rendering is unchanged.
 *
 * The link target is derived from the page's already-confined `directory`/`slug`
 * (relativized against `wiki/`), so this only renders what the collector validated.
 * The relative segment is forced back to POSIX: `path.relative` emits `path.sep`,
 * so on win32 a NESTED entity directory (`wiki/research/papers`) produced the
 * broken link `research\papers/foo.md` (issue #163, output-side instance).
 *
 * @param entityPages - The non-default profile's collected entity pages.
 * @returns The markdown lines for the typed sections (empty when no pages).
 */
function buildEntitySections(entityPages: EntityPage[]): string[] {
  if (entityPages.length === 0) return [];
  const byType = new Map<string, EntityPage[]>();
  for (const page of entityPages) {
    const group = byType.get(page.entityType) ?? [];
    group.push(page);
    byType.set(page.entityType, group);
  }

  const lines: string[] = [];
  for (const entityType of [...byType.keys()].sort()) {
    const pages = byType.get(entityType)!.sort((a, b) => a.slug.localeCompare(b.slug));
    lines.push("", `## ${entityTypeHeading(entityType)}`, "");
    for (const page of pages) {
      const link = `${toPosixPath(path.relative(WIKI_ROOT, page.directory))}/${page.slug}.md`;
      lines.push(`- **[${page.title ?? page.slug}](${link})** — \`${page.id}\``);
    }
  }
  return lines;
}
