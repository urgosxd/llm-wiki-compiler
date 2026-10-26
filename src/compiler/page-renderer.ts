/**
 * Wiki page rendering for the llmwiki compile pipeline.
 *
 * Encapsulates the single-page generation step: gather related pages, call
 * the LLM, build frontmatter, and produce the final markdown blob. Splitting
 * this away from the orchestrator (`compiler/index.ts`) keeps the orchestrator
 * focused on phase sequencing and lets the review-candidate code path reuse
 * the exact same renderer used for direct writes.
 */

import { readdir } from "fs/promises";
import path from "path";
import {
  buildFrontmatter,
  parseFrontmatter,
} from "../utils/markdown.js";
import { readWikiPageFrom } from "./confined-wiki-read.js";
import type { PageContentSource } from "../dimensions/wiki/page-scan-source.js";
import { callClaude } from "../utils/llm.js";
import { buildPagePrompt } from "./prompts.js";
import { addObsidianMeta } from "./obsidian.js";
import { addModelProvenanceMeta, addProvenanceMeta, reportContradictionWarnings } from "./provenance.js";
import { normalizeCitationsInBody } from "./citation-normalize.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
import type { SchemaConfig } from "../schema/index.js";
import type { ExtractedConcept } from "../utils/types.js";

/** Maximum number of existing concept pages to include as cross-reference context. */
const RELATED_PAGE_CONTEXT_LIMIT = 5;

/** A merged-concept input from the orchestrator (multiple sources merged into one). */
interface RenderableConcept {
  slug: string;
  concept: ExtractedConcept;
  sourceFiles: string[];
  combinedContent: string;
  rebuild?: boolean;
}

/**
 * Render a wiki page (frontmatter + body) for a merged concept by calling
 * the LLM with cross-referencing context from existing concept pages.
 * @param root - Project root directory.
 * @param entry - The merged concept to render.
 * @param schema - Resolved schema config, used to stamp `kind` on frontmatter.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns Full markdown content (frontmatter + body, trailing newline).
 */
export async function renderMergedPageContent(
  root: string,
  entry: RenderableConcept,
  schema: SchemaConfig,
  source?: PageContentSource,
): Promise<string> {
  const existingPage = await readWikiPageFrom(
    root, CONCEPTS_DIR, entry.slug, source, false /* new page — absence is normal */,
  );
  const relatedPages = await loadRelatedPages(root, entry.slug, source);

  const system = buildPagePrompt(
    entry.concept.concept,
    entry.combinedContent,
    entry.rebuild ? "" : existingPage,
    relatedPages,
  );

  const rawPageBody = await callClaude({
    system,
    messages: [
      { role: "user", content: `Write the wiki page for "${entry.concept.concept}".` },
    ],
  });

  const pageBody = normalizeCitationsInBody(
    rawPageBody,
    entry.sourceFiles,
    entry.combinedContent,
    entry.rebuild === true,
  );

  const frontmatter = buildMergedFrontmatter(entry, existingPage, schema);
  reportContradictionWarnings(entry.concept.concept, entry.concept);
  return `${frontmatter}\n\n${pageBody}\n`;
}

/**
 * Construct the frontmatter block for a merged concept, preserving createdAt
 * and stamping the `kind` field from the schema's default kind.
 */
function buildMergedFrontmatter(
  entry: RenderableConcept,
  existingPage: string,
  schema: SchemaConfig,
): string {
  const now = new Date().toISOString();
  const existing = existingPage ? parseFrontmatter(existingPage) : null;
  const createdAt = (existing?.meta.createdAt && typeof existing.meta.createdAt === "string")
    ? existing.meta.createdAt
    : now;
  const frontmatterFields: Record<string, unknown> = {
    title: entry.concept.concept,
    summary: entry.concept.summary,
    sources: entry.sourceFiles,
    kind: schema.defaultKind,
    createdAt,
    updatedAt: now,
  };
  addObsidianMeta(frontmatterFields, entry.concept.concept, entry.concept.tags ?? []);
  addProvenanceMeta(frontmatterFields, entry.concept);
  addModelProvenanceMeta(frontmatterFields);
  return buildFrontmatter(frontmatterFields);
}

/**
 * Load related wiki pages to provide cross-referencing context.
 * Returns concatenated content of up to RELATED_PAGE_CONTEXT_LIMIT pages.
 * Each per-file read is confined to `wiki/concepts`: a symlinked entry whose
 * target escapes that dir is dropped (warned, skipped) so its bytes never enter
 * the generation prompt.
 * @param root - Project root directory.
 * @param excludeSlug - Slug of the current page to exclude.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns Concatenated related page contents (empty when no related page exists).
 */
async function loadRelatedPages(
  root: string,
  excludeSlug: string,
  source?: PageContentSource,
): Promise<string> {
  const slugs = await listRelatedSlugs(root, excludeSlug, source);
  const contents: string[] = [];
  for (const slug of slugs) {
    // warnAlways=true: the list proved this page exists, so a drop is a real escape.
    const content = await readWikiPageFrom(root, CONCEPTS_DIR, slug, source);
    if (!content) continue;
    const { meta } = parseFrontmatter(content);
    if (meta.orphaned) continue;
    contents.push(content);
  }

  return contents.join("\n\n---\n\n");
}

/**
 * The sibling concept slugs a page may cross-reference, capped at the limit.
 *
 * Listing is separated from reading because the two backends list differently: the
 * file branch walks a directory, the row branch is handed every page and filters.
 *
 * @param root - Project root directory.
 * @param excludeSlug - Slug of the current page to exclude.
 * @param source - Row-backed page reader, or undefined to list `wiki/concepts`.
 * @returns Slugs to read, in a stable order.
 */
async function listRelatedSlugs(
  root: string,
  excludeSlug: string,
  source: PageContentSource | undefined,
): Promise<string[]> {
  if (source === undefined) {
    const files = await readdir(path.join(root, CONCEPTS_DIR)).catch(() => [] as string[]);
    return files
      .filter((f) => f.endsWith(".md") && f !== `${excludeSlug}.md`)
      .slice(0, RELATED_PAGE_CONTEXT_LIMIT)
      .map((f) => f.replace(/\.md$/, ""));
  }
  return (await source.listSlugs("concepts"))
    .filter((slug) => slug !== excludeSlug)
    .slice(0, RELATED_PAGE_CONTEXT_LIMIT);
}
