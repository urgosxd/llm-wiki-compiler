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
import path from "node:path";
import { buildFrontmatter, parseFrontmatter } from "../../src/utils/markdown.js";
import { CONCEPTS_DIR } from "../../src/utils/constants.js";

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
