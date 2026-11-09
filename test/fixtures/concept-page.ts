/**
 * @file test/fixtures/concept-page.ts
 * @description The two concept-page operations more than one compile-path test needs:
 * read a page's exact bytes, and declare an alias in its frontmatter.
 *
 * WHY A FIXTURE. `aliases` is a supported frontmatter field that the identity stage
 * persists and the reference review reads, and it is the only form of alias whose
 * canonical key can differ from the title's -- which is the form every curation case
 * anchors on. Writing that frontmatter by hand in each case is what a duplicated helper
 * block looks like, and the copies drift; the one implementation lives here.
 */

import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { buildFrontmatter, parseFrontmatter } from "../../packages/wiki/src/utils/markdown.js";
import { CONCEPTS_DIR } from "../../packages/wiki/src/utils/constants.js";
import { useTempRoot, type TempRootCtx } from "./temp-root.js";
import { writePage } from "./write-page.js";

/**
 * The full markdown of one concept page, frontmatter included.
 *
 * @param root - Project root.
 * @param slug - Page slug under `wiki/concepts`.
 * @returns The page's bytes.
 */
export async function readConceptPage(root: string, slug: string): Promise<string> {
  return await readFile(path.join(root, CONCEPTS_DIR, `${slug}.md`), "utf-8");
}

/**
 * Every concept-namespace page the wiki stores, in name order.
 *
 * Sorted, so an assertion about WHICH pages exist cannot depend on the order the filesystem
 * happens to return them in.
 *
 * @param root - Project root.
 * @returns Page file names under `wiki/concepts`, `.md` included.
 */
export async function listConceptPages(root: string): Promise<string[]> {
  const files = await readdir(path.join(root, CONCEPTS_DIR)).catch(() => [] as string[]);
  return files.filter((file) => file.endsWith(".md")).sort();
}

/**
 * Add one declared alias to a page's frontmatter, keeping every other field.
 *
 * The alias survives the next render of the page (`applyDeclaredAliases` carries a
 * declared alias forward), so a later compile can still be the run that reads it.
 *
 * @param root - Project root.
 * @param slug - Page to edit.
 * @param alias - Name to declare.
 */
export async function declareAlias(root: string, slug: string, alias: string): Promise<void> {
  const { meta, body } = parseFrontmatter(await readConceptPage(root, slug));
  const declared = Array.isArray(meta.aliases) ? meta.aliases.map(String) : [];
  const fields = { ...meta, aliases: [...declared, alias] };
  await writeFile(
    path.join(root, CONCEPTS_DIR, `${slug}.md`),
    `${buildFrontmatter(fields)}\n\n${body}\n`,
    "utf-8",
  );
}

/** A suite's throwaway root plus a writer bound to it. */
export interface ConceptPageSuite {
  /** Throwaway wiki root, filled in by the registered hooks. */
  ctx: TempRootCtx;
  /** Write one concept page into the throwaway wiki. */
  page: (slug: string, title: string, body: string) => Promise<void>;
}

/**
 * Bind a throwaway wiki root and a concept-page writer to the calling suite.
 *
 * Three command/context suites carried this pair copied verbatim. `useTempRoot` is
 * a composable that registers the calling suite's `beforeEach`/`afterEach` at
 * collection time, so it is called from here at that same moment and every
 * importing suite keeps its OWN temp root and lifecycle: the returned instance is
 * per-suite, never shared, and `page` closes over the live `ctx` object whose
 * `dir` the hook fills in.
 *
 * @returns The suite's root context and its page writer.
 */
export function useConceptPage(): ConceptPageSuite {
  const ctx = useTempRoot();
  const page = (slug: string, title: string, body: string): Promise<void> =>
    writePage(path.join(ctx.dir, "wiki/concepts"), slug, { title }, body);
  return { ctx, page };
}
