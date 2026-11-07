/**
 * @file src/dimensions/wiki/page-string-list.ts
 * @description Coerce a value that arrived from YAML frontmatter or from a `jsonb`
 * column into the plain string list the per-page metadata fields are defined as.
 *
 * ## Why one definition
 *
 * The per-page metadata lists cross the row seam TWICE, in opposite directions: the
 * page write sink reads them out of the rendered frontmatter (a YAML value) and the row
 * store reads them back out of `wiki.pages` (a `jsonb` value). Both arrive as `unknown`
 * and both must reduce to a `string[]`, dropping anything that is not a string rather
 * than throwing: a page whose list was hand-edited into a scalar is a page without that
 * metadata, not a reason to fail a whole listing or a whole compile.
 *
 * Two copies of that rule is exactly how the write half and the read half of this seam
 * would come to disagree about a page neither of them can represent.
 */

/**
 * Reduce a frontmatter or `jsonb` value to the plain strings it may contain.
 *
 * @param raw - The value as it arrived; anything other than an array yields `[]`.
 * @returns The string elements, in order, trimmed of surrounding whitespace.
 */
export function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}
