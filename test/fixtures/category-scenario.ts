/**
 * @file The two-article scenario every CATEGORY compile-path case measures.
 *
 * WHY A FIXTURE. Category assignment is measured at two levels -- through a real
 * compile (`test/compiler/category-compile.test.ts`) and at the stage itself
 * (`test/categories/category-assign.test.ts`) -- and both must describe the SAME
 * articles, bodies and proposals, or the two levels would prove different things.
 * The sources, the rendered bodies and the proposal builders live here once.
 *
 * WHY THE ARTICLE AND THE CATEGORY ARE BOTH NAMED "Sistemas distribuidos". That
 * collision is the requirement (`S4`): the concept explains the topic and the
 * category groups pages, and they must stay two files with two identities. The
 * fixture therefore has to produce a page and a category with the same stem.
 *
 * EVERY criterion term is a real word of the article body on purpose: a criterion
 * quotes the words that decide membership, and the stage checks the article against
 * them. A fixture whose body did not contain its own criterion would exercise the
 * refusal path, which is a separate case.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseCategory } from "../../src/categories/markdown.js";
import type { CategoryRecord } from "../../src/categories/types.js";

/** The source whose article is titled {@link SISTEMAS_TITLE}. */
export const SISTEMAS_SOURCE = "sistemas.md";

/** Marker that routes the extraction stub to the sistemas source. */
export const SISTEMAS_MARKER = "SISTEMAS SOURCE TEXT";

/** The article title, deliberately equal to the category's canonical name. */
export const SISTEMAS_TITLE = "Sistemas distribuidos";

/** The rendered body of that article; it contains every criterion term below. */
export const SISTEMAS_BODY =
  "Los sistemas distribuidos coordinan varios nodos con consenso distribuido, " +
  "replicación, tolerancia a fallos y el teorema CAP. ^[sistemas.md]";

/** The source whose article is titled {@link ALMACENES_TITLE}. */
export const ALMACENES_SOURCE = "almacenes.md";

/** Marker that routes the extraction stub to the almacenes source. */
export const ALMACENES_MARKER = "ALMACENES SOURCE TEXT";

/** The second article, so a run always has a second thing to do. */
export const ALMACENES_TITLE = "Almacenes de vectores";

/** The rendered body of the second article. */
export const ALMACENES_BODY =
  "Un almacén de vectores guarda embeddings para búsqueda semántica. ^[almacenes.md]";

/** The category description the stub proposes. */
export const CATEGORY_DESCRIPTION = "Agrupa páginas sobre sistemas que coordinan varios nodos.";

/** The proposed inclusion criterion: prose plus the QUOTED term that decides it. */
export const CATEGORY_CRITERION =
  'Páginas que mencionen "consenso distribuido" o "replicación".';

/** The per-member justification the stub proposes. */
export const CATEGORY_REASON = "El artículo explica el consenso distribuido como mecanismo central.";

/** One category proposal, as the model's tool answer carries it. */
export interface ProposalInput {
  /** Canonical name of the category. */
  name: string;
  /** Description; defaults to a generated sentence. */
  description?: string;
  /** Inclusion criterion; must quote at least one term to be checkable. */
  criterion?: string;
  /** Why the CURRENT article belongs. */
  reason?: string;
}

/**
 * Build one proposal in the tool's own field names.
 *
 * @param input - The category being proposed for the current article.
 * @returns The proposal as the model would answer it.
 */
export function proposal(input: ProposalInput): Record<string, unknown> {
  return {
    canonical_name: input.name,
    description: input.description ?? `Descripción de ${input.name}.`,
    inclusion_criterion: input.criterion ?? `Páginas que mencionen "${input.name}".`,
    reason: input.reason ?? `El artículo trata ${input.name}.`,
  };
}

/**
 * Serialise the proposals as the tool answer.
 *
 * @param proposals - Proposals, in the order the model offers them.
 * @returns The JSON the provider stub returns.
 */
export function proposalAnswer(...proposals: Record<string, unknown>[]): string {
  return JSON.stringify({ categories: proposals });
}

/** The proposal the sistemas article makes: a category named like the article. */
export function sistemasProposal(): Record<string, unknown> {
  return proposal({
    name: SISTEMAS_TITLE,
    description: CATEGORY_DESCRIPTION,
    criterion: CATEGORY_CRITERION,
    reason: CATEGORY_REASON,
  });
}

/** Extraction payload naming one concept. */
export function extractionFor(title: string): string {
  return JSON.stringify({ concepts: [{ concept: title, summary: `Resumen de ${title}.`, is_new: true }] });
}

/**
 * Which article an extraction prompt is about, decided by the SOURCE text.
 *
 * Routing on the source rather than on a title is deliberate: the extraction prompt
 * also carries the existing wiki index, so it mentions every title compiled so far
 * and a title-based branch would answer for the wrong source.
 *
 * @param system - The extraction system prompt.
 * @returns The article title that source produces.
 */
export function titleForSource(system: string): string {
  return system.includes(ALMACENES_MARKER) ? ALMACENES_TITLE : SISTEMAS_TITLE;
}

/**
 * Which article a page-render prompt is about, from its trailing instruction.
 *
 * @param system - The page prompt.
 * @returns The rendered body for that article.
 */
export function bodyForArticle(system: string): string {
  return system.includes(`Concept to write about: "${ALMACENES_TITLE}"`)
    ? ALMACENES_BODY
    : SISTEMAS_BODY;
}

/**
 * Write both sources into a project root.
 *
 * @param root - Project root.
 */
export async function writeScenarioSources(root: string): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(
    path.join(root, "sources", SISTEMAS_SOURCE),
    `# ${SISTEMAS_TITLE}\n\n${SISTEMAS_MARKER}. ${SISTEMAS_BODY}\n`,
    "utf-8",
  );
  await writeFile(
    path.join(root, "sources", ALMACENES_SOURCE),
    `# ${ALMACENES_TITLE}\n\n${ALMACENES_MARKER}. ${ALMACENES_BODY}\n`,
    "utf-8",
  );
}

/**
 * Revise ONE source, so the next compile re-renders only that source's pages.
 *
 * @param root - Project root.
 * @param source - Which source to revise.
 */
export async function reviseSource(root: string, source: string): Promise<void> {
  const file = path.join(root, "sources", source);
  const current = await readFile(file, "utf-8");
  await writeFile(file, `${current.trimEnd()} Revisado.\n`, "utf-8");
}

/**
 * Read one category file's bytes.
 *
 * @param root - Project root.
 * @param categoryId - The category's stable id.
 * @returns The file's markdown.
 */
export async function readCategoryFile(root: string, categoryId: string): Promise<string> {
  return await readFile(path.join(root, "wiki", "categories", `${categoryId}.md`), "utf-8");
}

/**
 * Read and parse one category file.
 *
 * @param root - Project root.
 * @param categoryId - The category's stable id.
 * @returns The record the file stores.
 */
export async function readCategoryRecord(root: string, categoryId: string): Promise<CategoryRecord> {
  return parseCategory(await readCategoryFile(root, categoryId));
}

/**
 * The category ids present on disk, sorted; empty when the directory is absent.
 *
 * @param root - Project root.
 * @returns File stems of `wiki/categories/*.md`.
 */
export async function categoryIds(root: string): Promise<string[]> {
  const names = await readdir(path.join(root, "wiki", "categories")).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort();
}
