/**
 * @file src/linter/corpus.ts
 * @description The page corpus a lint run reads, resolved ONCE per run and
 * carried in an async scope so a rule cannot accidentally read the wrong one.
 *
 * ## The defect this closes
 *
 * Every rule reads pages through `collectAllPages`, which walks `wiki/concepts`
 * and `wiki/queries` on disk. A Stack-backed project has neither: its corpus is
 * `wiki.pages`. So on a Stack the linter walked an empty tree and answered
 * "nothing is wrong" — not because the wiki was clean, but because it saw nothing.
 *
 * ## Why a scope instead of a parameter
 *
 * Passing a corpus into every rule would change ~10 exported signatures that 20
 * files import (`eval/health.ts` alone imports 8 of them) and that the frozen
 * parity suites pin. Instead the corpus travels in an `AsyncLocalStorage` scope —
 * the same mechanism `utils/output.ts` uses for quiet/verbose mode. Rules keep
 * their `(root) => Promise<LintResult[]>` shape, nested runs cannot leak into each
 * other, and a rule that reads pages gets the resolved corpus for free.
 *
 * ## Why the assistant content is reconstructed, not just the body
 *
 * Rules call `parseFrontmatter(page.content)` and read `meta`. A row stores
 * `body` with the frontmatter ALREADY STRIPPED (`toPage` does that on the way in),
 * so serving `body` alone would parse every page as having no metadata at all and
 * turn the metadata rules into silent no-ops. Rebuilding the block with
 * `buildFrontmatter` is the inverse of the strip, so the same parse yields the same
 * fields a file would.
 *
 * That reconstruction is still LOSSY, and the loss is recorded rather than
 * hidden: see {@link METADATA_NOT_STORED_IN_ROWS}.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { buildFrontmatter } from "../utils/markdown.js";
import type { RawWikiPage } from "../wiki/collect.js";
import type { PageScope } from "./rules-shared.js";

/** One page as a rule consumes it: full markdown plus its diagnostic path. */
export interface LintPage {
  /** Path used in diagnostics. Synthesized for a row; never opened. */
  readonly filePath: string;
  /** Full markdown: frontmatter block rebuilt, then the body. */
  readonly content: string;
}

/** The resolved corpus for one lint run. */
export interface LintCorpus {
  /** Every page the run may inspect, in the run's declared scope. */
  readonly pages: readonly LintPage[];
  /**
   * Source documents, keyed by the filename a page cites.
   *
   * `undefined` means "not resolved — read from `sources/`", which is what a
   * file-backed project wants. An empty map is different and means "this project
   * has sources, and none of them is that filename": `checkBrokenCitations`
   * distinguishes the two, because a citation to a document that exists nowhere is
   * exactly what it reports.
   */
  readonly sources?: ReadonlyMap<string, string>;
}

/**
 * Frontmatter fields a page can carry that `wiki.pages` has no column for.
 *
 * These are dropped when a page is STORED, not when it is read: `upsertStoredPage`
 * writes a fixed column list, and `body` holds the page body without its
 * frontmatter. So on a row corpus the rules that depend on them cannot answer —
 * and they must say so rather than report "clean".
 *
 * Closing this needs a schema decision (columns on `wiki.pages`, or a provenance
 * side table), which is a separate feature. Until then, the set is named here, in
 * one place, and `test/lint-corpus-parity.test.ts` pins which rules fall inside it.
 */
export const METADATA_NOT_STORED_IN_ROWS: readonly string[] = [
  "confidence",
  "contradictedBy",
  "provenanceState",
  "promptModifiers",
];

/** Rules whose verdict depends on a field a row cannot carry. */
export const RULES_UNAVAILABLE_ON_ROWS: readonly string[] = [
  "low-confidence",
  "contradicted-page",
  "broken-citation",
];

const corpusScope = new AsyncLocalStorage<LintCorpus>();

/**
 * Run `fn` with the resolved corpus in scope.
 *
 * @param corpus - The pages this run may inspect.
 * @param fn - The lint body.
 * @returns Whatever `fn` returns.
 */
export async function withLintCorpus<T>(
  corpus: LintCorpus,
  fn: () => Promise<T>,
): Promise<T> {
  return await corpusScope.run(corpus, fn);
}

/**
 * The corpus in scope, or `undefined` when this call runs outside one.
 *
 * @returns The active corpus, if any.
 */
export function activeLintCorpus(): LintCorpus | undefined {
  return corpusScope.getStore();
}

/**
 * Rebuild the markdown a file would hold from a row-backed page.
 *
 * `buildFrontmatter` is the exact inverse of the `parseFrontmatter` call the row
 * write path performs, so the rules parse back the fields the page was stored
 * with. Fields with no column are simply absent — the same shape a file whose
 * frontmatter never carried them would have.
 *
 * @param page - One page as the raw source returns it.
 * @returns Full markdown plus the diagnostic path that came with it.
 */
function lintPageFromRaw(page: RawWikiPage): LintPage {
  const frontmatter = buildFrontmatter(page.frontmatter);
  return { filePath: page.filePath, content: `${frontmatter}\n\n${page.body}` };
}

/**
 * Narrow raw pages to the directories a scope covers.
 *
 * `"generic"` is the quality family's jurisdiction: `concepts/` and `queries/`
 * only, because on a profile project those judgements belong to the profile lint
 * family. `"wiki-wide"` takes every page the corpus holds.
 *
 * @param pages - The corpus, unfiltered.
 * @param scope - Which jurisdiction this rule family claims.
 * @returns The pages in that scope.
 */
function pagesInScope(pages: readonly RawWikiPage[], scope: PageScope): RawWikiPage[] {
  if (scope === "wiki-wide") return [...pages];
  return pages.filter(
    (page) => page.pageDirectory === "concepts" || page.pageDirectory === "queries",
  );
}

/**
 * Build the corpus for one run from the pages a raw source returned.
 *
 * @param pages - Every page the project holds.
 * @param scope - Which pages this run may inspect.
 * @param sources - Source documents by cited filename, when the project has rows.
 * @returns The corpus, ready to be put in scope.
 */
export function corpusFromRawPages(
  pages: readonly RawWikiPage[],
  scope: PageScope = "generic",
  sources?: ReadonlyMap<string, string>,
): LintCorpus {
  return {
    pages: pagesInScope(pages, scope).map(lintPageFromRaw),
    ...(sources === undefined ? {} : { sources }),
  };
}

/**
 * The source text for one cited filename, when a corpus is in scope and knows it.
 *
 * @param filename - The name a page cites.
 * @returns The text, `null` when the corpus says the document does not exist, or
 *   `undefined` when no corpus is in scope and the caller should read disk.
 */
export function lintSourceText(filename: string): string | null | undefined {
  const corpus = activeLintCorpus();
  if (corpus === undefined || corpus.sources === undefined) return undefined;
  return corpus.sources.get(filename) ?? null;
}
