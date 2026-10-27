/**
 * Repair wikilinks that name an existing page too briefly to resolve.
 *
 * Page generation writes a link using a concept's short canonical name while
 * the page it means carries a longer descriptive title — `[[Argo CD]]` against
 * a page slugged `argo-cd-image-update-ownership-model`. Extraction picks the
 * page titles and generation picks the link text, independently and in that
 * order, so nothing reconciles the two and the link stays broken even though
 * its target is sitting right there on disk.
 *
 * This pass runs once every page is written and rewrites only the link TARGET,
 * never the text around it: the example above becomes
 * `[[argo-cd-image-update-ownership-model|Argo CD]]`. The visible label is
 * retained, while code examples and frontmatter remain untouched.
 *
 * Only an unambiguous prefix match is repaired. A slug that prefixes two pages
 * is left alone rather than guessed at, and so is one that prefixes none: a link
 * to a concept the wiki genuinely lacks is a signal about what is missing, not
 * noise to be hidden.
 */

import path from "path";
import { readdir } from "node:fs/promises";
import { parseFrontmatter, slugify } from "../utils/markdown.js";
import { readConfinedWikiPage, warnDroppedWikiReadIfPresent } from "./confined-wiki-read.js";
import { isLiteralMarkdown } from "./link-repair-code.js";
import { listLinkResolvablePendingSlugs } from "./candidate-read.js";
import { applyCompilePageWritesLocked } from "./compile-write.js";
import type { CompilePageNamespace, CompilePageWrite } from "./compile-write.js";
import type { PageContentSource, PageScanSource } from "../dimensions/wiki/page-scan-source.js";
import { pageStoreOptions, type PageRemover, type PageSink } from "../trust/page-apply.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import * as output from "../utils/output.js";

/** `[[target]]` and `[[target|alias]]`, capturing everything between brackets. */
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

/** Separator joining slug words, and therefore the prefix boundary. */
const SLUG_SEPARATOR = "-";

/**
 * Shortest link slug considered for repair. Below this a slug prefixes pages it
 * has nothing to do with — `[[a]]` would claim `a-b-c` — and the uniqueness
 * check cannot tell that apart from a real abbreviation.
 */
const MIN_REPAIRABLE_SLUG_LENGTH = 3;

/**
 * Candidate slugs an exact-modulo-morphology match would accept, or null.
 *
 * Extraction names a concept in the singular while its page title often lands in
 * the plural (or vice versa), so `[[graph]]` misses `graphs` and `[[weighted-graph]]`
 * misses `weighted-graphs`. Both name the same thing, and the link sits broken
 * pointing at a page that is right there.
 *
 * Only the LAST word is inflected: `graph-theory` and `graphs-theory` are not the
 * same concept, but `weighted-graph`/`weighted-graphs` are.
 */
function morphologyVariants(targetSlug: string): string[] {
  const separatorIndex = targetSlug.lastIndexOf(SLUG_SEPARATOR);
  const head = separatorIndex === -1 ? "" : targetSlug.slice(0, separatorIndex + 1);
  const lastWord = separatorIndex === -1 ? targetSlug : targetSlug.slice(separatorIndex + 1);
  if (lastWord.length < MIN_REPAIRABLE_SLUG_LENGTH) return [];
  const variants: string[] = [];
  // plural -> singular, then singular -> plural. Both directions are needed:
  // which one the link uses depends on how the extractor phrased it.
  if (lastWord.endsWith("ies") && lastWord.length > 4) {
    variants.push(head + lastWord.slice(0, -3) + "y");
  }
  if (lastWord.endsWith("es") && lastWord.length > 3) {
    variants.push(head + lastWord.slice(0, -2));
  }
  if (lastWord.endsWith("s") && !lastWord.endsWith("ss")) {
    variants.push(head + lastWord.slice(0, -1));
  } else {
    variants.push(head + lastWord + "s");
    variants.push(head + lastWord + "es");
  }
  return variants;
}

/**
 * Resolve a broken link slug to the single page it identifies, or null.
 *
 * Tried in order of certainty: an exact match, then a unique prefix (the original
 * rule), then a unique singular/plural variant. Null when a step finds none or
 * more than one -- an ambiguous target is still left alone rather than guessed at,
 * because a wrong link is worse than a visibly missing one.
 */
function resolveUniquePrefix(targetSlug: string, slugs: string[]): string | null {
  if (targetSlug.length < MIN_REPAIRABLE_SLUG_LENGTH) return null;
  const existing = new Set(slugs);
  // Morphology BEFORE prefix. `[[graph]]` beside both `graphs` and `graph-theory`
  // is far more likely to mean the plural of itself than a longer unrelated page:
  // inflection is a naming difference, while a prefix match is a truncation, and
  // truncations are what produce wrong links. Both still require exactly ONE
  // candidate, so an ambiguous inflection falls through to the prefix rule rather
  // than being guessed at.
  const inflected = morphologyVariants(targetSlug).filter((variant) => existing.has(variant));
  if (inflected.length === 1) return inflected[0]!;
  if (inflected.length > 1) return null;
  const prefix = targetSlug + SLUG_SEPARATOR;
  let match: string | null = null;
  for (const slug of slugs) {
    if (!slug.startsWith(prefix)) continue;
    if (match) return null;
    match = slug;
  }
  if (match) return match;
  // A link written as `[[algorithms.md]]` slugifies to `algorithmsmd`: `slugify`
  // drops the dot and joins the words, because a dot is not a word separator it
  // knows about. Split a trailing `md` back off and retry the exact lookup.
  if (targetSlug.endsWith("md") && targetSlug.length > MIN_REPAIRABLE_SLUG_LENGTH + 2) {
    const withoutExtension = targetSlug.slice(0, -2);
    if (existing.has(withoutExtension)) return withoutExtension;
  }
  return null;
}

/** Reuse the production retained-only prefix rule, including pending ambiguity. */
export function createRepairResolver(slugs: string[], pending: Set<string>): (target: string) => string | null {
  const existing = new Set(slugs);
  const possible = [...slugs, ...[...pending].filter(slug => !existing.has(slug))];
  // Exact pending targets must not be redirected to a different retained page.
  return (writtenTarget: string): string | null => {
    const targetSlug = slugify(writtenTarget);
    // An EXISTING slug is the page this link names -- return it so the caller can
    // normalise a title-shaped target (`[[Some Concept]]`) to its slug. Returning
    // null here would mean "nothing to do", which is only true when the link is
    // already written as that slug.
    if (existing.has(targetSlug)) return targetSlug;
    if (pending.has(targetSlug)) return null;
    const match = resolveUniquePrefix(targetSlug, possible);
    return match && existing.has(match) ? match : null;
  };
}

/** Split `target|alias` into its parts, preserving an alias that contains a pipe. */
function splitWikilink(inner: string): { target: string; alias: string } {
  const [rawTarget, ...aliasParts] = inner.split("|");
  const target = rawTarget.trim();
  const alias = aliasParts.length > 0 ? aliasParts.join("|").trim() : target;
  return { target, alias };
}

/**
 * Normalise every wikilink that names a page to ONE form: `[[slug|label]]`.
 *
 * A wiki may not have two ways to spell a link. Generation writes concept TITLES
 * (`[[Betweenness Centrality]]`) while pages are stored under SLUGS
 * (`betweenness-centrality`), and a reader tolerates that inconsistency only by
 * guessing -- matching case-insensitively, folding spaces to hyphens, hoping no
 * two titles collide once folded. Every one of those guesses is a way for a link
 * to be silently wrong.
 *
 * So the CANONICAL form is the slug, always, with the original words kept as the
 * alias: `[[betweenness-centrality|Betweenness Centrality]]`. The page reads the
 * same, the target is exact, and nothing downstream has to reconstruct which page
 * a link meant. A link is left alone only when it already IS its own slug.
 *
 * @param body - Page markdown with the frontmatter already stripped.
 * @param identify - Maps a written target to the ONE page it names, or null.
 * @returns The rewritten body and how many links changed.
 */
function repairBody(
  body: string,
  identify: (writtenTarget: string) => string | null,
): { body: string; repaired: number } {
  let repaired = 0;
  const literal = isLiteralMarkdown(body);
  const next = body.replace(WIKILINK_PATTERN, (match, inner: string, offset: number) => {
    if (literal(offset)) return match;
    const { target, alias } = splitWikilink(inner);
    const slug = identify(target);
    if (!slug) return match;
    // Compare the RESULT, not the inputs. A link already written as
    // `[[slug|Original Title]]` re-derives to exactly the same bytes, and counting
    // that as a repair would make every pass rewrite every page -- re-embedding the
    // whole wiki each compile for output identical to what was already there.
    const canonical = `[[${slug}|${alias}]]`;
    if (canonical === match) return match;
    repaired += 1;
    return canonical;
  });
  return { body: next, repaired };
}

/**
 * The pages a repair pass rewrites, keyed by the identity its writes need.
 *
 * `namespace` and `slug` are carried alongside the text because a row has no path:
 * deriving a namespace by splitting a path only works on the file branch, and doing
 * it there and something else here is how the two backends drift apart.
 */
interface RepairPage {
  namespace: CompilePageNamespace;
  slug: string;
  content: string;
}

/** Read only pages whose opened bytes remain within their expected directory. */
async function collectRepairPages(
  root: string,
  source: PageContentSource | undefined,
  scan: PageScanSource | undefined,
): Promise<RepairPage[]> {
  if (source !== undefined && scan !== undefined) {
    return await collectRepairPagesFromRows(source, scan);
  }
  return await collectRepairPagesFromDisk(root);
}

/**
 * Collect the pages a repair pass must consider from a row corpus.
 *
 * The scan supplies the identities and the content source supplies each body, which
 * is the same split the disk branch performs by listing a directory and reading each
 * entry. Both directories are read because a `concepts` page may link to a `queries`
 * page.
 *
 * @param source - Per-page reader for the Stack.
 * @param scan - Listing source for the Stack.
 * @returns Every page with a body that could be read.
 */
async function collectRepairPagesFromRows(
  source: PageContentSource,
  scan: PageScanSource,
): Promise<RepairPage[]> {
  const pages: RepairPage[] = [];
  for (const namespace of ["concepts", "queries"] as const) {
    for (const scanned of await scan.scan(namespace)) {
      const content = await source.read(namespace, scanned.slug);
      // A listing entry whose body cannot be read is skipped rather than repaired
      // against empty text, which would rewrite a page into nothing.
      if (content === undefined) continue;
      pages.push({ namespace, slug: scanned.slug, content });
    }
  }
  return pages;
}

/**
 * Collect the pages a repair pass must consider from `wiki/` on disk.
 *
 * @param root - Absolute project root the reads are confined under.
 * @returns Every page whose opened bytes stay inside its expected directory.
 */
async function collectRepairPagesFromDisk(root: string): Promise<RepairPage[]> {
  const pages: RepairPage[] = [];
  for (const dir of [CONCEPTS_DIR, QUERIES_DIR]) {
    const files = await readdir(path.join(root, dir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files.filter(file => file.endsWith(".md"))) {
      const filePath = path.join(root, dir, file);
      const result = await readConfinedWikiPage(root, dir, file.slice(0, -3));
      if ("dropped" in result) {
        await warnDroppedWikiReadIfPresent(filePath, path.join(dir, file), result.dropped);
        continue;
      }
      pages.push({ namespace: namespaceForPage(filePath), slug: file.slice(0, -3), content: result.content });
    }
  }
  return pages;
}

/** Derive the compile namespace from a page's absolute file path. */
function namespaceForPage(filePath: string): CompilePageNamespace {
  return path.dirname(filePath).endsWith(path.basename(QUERIES_DIR)) ? "queries" : "concepts";
}

/**
 * COMPUTE the repair rewrites for every page in the project.
 *
 * Scans all pages rather than only changed ones: a link broken today becomes
 * repairable the moment a later compile creates the page it names, and that
 * page's arrival never touches the file holding the link. The pass reads files
 * and calls no model, so the cost is the same order as `llmwiki lint`.
 *
 * @param root - Absolute project root the reads and writes are confined under.
 * @param source - Row-backed page reader, or undefined to read `wiki/`.
 * @param scan - Row-backed listing, or undefined to list `wiki/`.
 * @returns One write per page whose body actually changed.
 */
export async function repairLinks(
  root: string,
  source?: PageContentSource,
  scan?: PageScanSource,
): Promise<CompilePageWrite[]> {
  const pages = await collectRepairPages(root, source, scan);
  if (pages.length === 0) return [];

  const slugs = pages.map((page) => page.slug.toLowerCase());
  const pending = await listLinkResolvablePendingSlugs(root);
  const resolve = createRepairResolver(slugs, pending);

  const writes: CompilePageWrite[] = [];
  let repairedLinks = 0;
  for (const page of pages) {
    const { body } = parseFrontmatter(page.content);
    const result = repairBody(body, resolve);
    if (result.repaired === 0) continue;
    repairedLinks += result.repaired;
    writes.push({
      namespace: page.namespace,
      slug: page.slug,
      body: page.content.replace(body, () => result.body),
    });
  }

  if (repairedLinks > 0) {
    output.status(
      "🔗",
      output.dim(`Repaired ${repairedLinks} wikilink(s) in ${writes.length} page(s)`),
    );
  }
  return writes;
}

/**
 * COMPUTE the repairs and APPLY them in one step — the single seam callers
 * should use, so the "{@link repairLinks} returns writes you MUST apply"
 * contract cannot be forgotten.
 *
 * PRECONDITION: the caller MUST already hold the project lock. This routes
 * through the LOCK-FREE {@link applyCompilePageWritesLocked}, matching how
 * interlink resolution is applied from the same place in the pipeline.
 *
 * @param root - Absolute project root the writes are confined under.
 * @param source - Row-backed page reader, or undefined to read `wiki/`.
 * @param scan - Row-backed listing, or undefined to list `wiki/`.
 * @param sink - Row writer, or undefined to write files.
 */
export async function repairAndApplyLinks(
  root: string,
  source?: PageContentSource,
  scan?: PageScanSource,
  sink?: PageSink,
  remover?: PageRemover,
): Promise<void> {
  await applyCompilePageWritesLocked(
    root, await repairLinks(root, source, scan), pageStoreOptions(sink, remover));
}
