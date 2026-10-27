/**
 * @file test/fixtures/src-tree.ts
 * @description The one src/ tree walker the structural gates share: the
 * absolute src/ root and every `.ts` or `.js` file under it as src-relative slash
 * paths. Two gates walking the tree with private copies is how their file
 * sets quietly diverge.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The absolute path of the repository's src/ directory. */
export const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

/** Every TypeScript or JavaScript file under src/, as src-relative slash paths. */
export function srcTsFiles(dir = SRC_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    // A directory is descended into; a source file is kept. Anything else (a README,
    // an asset) is neither, which is the third case worth naming.
    out.push(...(entry.isDirectory() ? srcTsFiles(path.join(dir, entry.name), rel) : keepIfSource(rel, entry.name)));
  }
  return out;
}

/** Is this file one of the sources this scan reports? */
const SOURCE_FILE_PATTERN = /\.(?:ts|js)$/;

/**
 * The relative path as a single-element list, or nothing when it is not source.
 *
 * Returning a list keeps the caller a single `push(...)`, which is what removed the
 * three-way branch from the recursion.
 *
 * @param rel - src-relative slash path.
 * @param name - The entry's basename, which decides the extension.
 * @returns One path, or an empty list.
 */
function keepIfSource(rel: string, name: string): string[] {
  return SOURCE_FILE_PATTERN.test(name) ? [rel] : [];
}
