/**
 * @file `llmwiki categories-here <page-id>` — the categories one page belongs to (S11).
 *
 * The other half of category navigation: a reader who is ON an article wants to know
 * which groups it is filed under, without opening every category to look for it. The
 * answer comes from the category store — each category records its members with the
 * reason and evidence key that admitted them — so this command reads categories and
 * nothing else: no page is opened, no lock is taken, no model is called.
 *
 * A PAGE THAT IS IN NO CATEGORY IS A NORMAL ANSWER. Most pages of a young wiki are in
 * none, and a wiki with no categories at all is an ordinary state: the exit code stays
 * 0 and the envelope reports an empty list, so a caller can tell "not grouped" from
 * "command failed" without parsing prose.
 *
 * NAME RESOLUTION: a bare slug means `concepts/<slug>`, the default namespace and the
 * only one a default project writes, exactly like `links-here`. A namespaced id is
 * accepted as given when its namespace is one the wiki records pages under
 * (`concepts`, `queries`); anything else cannot be a member of a category, so it is
 * reported unresolved instead of silently returning an empty list.
 */

import { listCategories } from "../categories/store.js";
import { categoryObjectId } from "../categories/identity.js";
import type { CategoryRecord } from "../categories/types.js";

/** Versioned JSON envelope, incremented independently of other commands. */
const CATEGORIES_HERE_JSON_VERSION = 1;

/** The page namespaces a category can record a member under. */
const PAGE_NAMESPACES: readonly string[] = ["concepts", "queries"];

/** CLI options for `llmwiki categories-here`. */
export interface CategoriesHereOptions {
  /** Emit the stable JSON envelope instead of the human list. */
  json?: boolean;
}

/** One category as reported to the caller. */
interface ReportedCategory {
  categoryId: string;
  objectId: string;
  canonicalName: string;
  description: string;
}

/** Split a requested name into a page namespace and a slug, or null when it is usable as given. */
function pageIdFor(requested: string): string | null {
  const trimmed = requested.trim();
  if (trimmed === "") return null;
  const separator = trimmed.indexOf("/");
  if (separator === -1) return `concepts/${trimmed}`;
  const namespace = trimmed.slice(0, separator);
  const slug = trimmed.slice(separator + 1);
  return slug !== "" && PAGE_NAMESPACES.includes(namespace) ? `${namespace}/${slug}` : null;
}

/**
 * The categories whose recorded members include the page, in id order.
 *
 * @param categories - Every category in the wiki, in id order.
 * @param pageId - The namespaced page id to look for.
 * @returns The matching categories, projected for reporting.
 */
function categoriesContaining(
  categories: readonly CategoryRecord[],
  pageId: string,
): ReportedCategory[] {
  return categories
    .filter((record) => record.members.some((member) => member.pageId === pageId))
    .map((record) => ({
      categoryId: record.categoryId,
      objectId: categoryObjectId(record.categoryId),
      canonicalName: record.canonicalName,
      description: record.description,
    }));
}

/**
 * Render the human-readable answer.
 *
 * @param pageId - The page id asked about.
 * @param categories - The categories that contain it.
 * @returns The text to print, without a trailing newline.
 */
function renderHuman(pageId: string, categories: readonly ReportedCategory[]): string {
  if (categories.length === 0) {
    return [
      `No category contains ${pageId}.`,
      "This wiki may have no categories yet: a compile creates them as it assigns pages.",
    ].join("\n");
  }
  const listed = categories.map((category) => `  [[${category.objectId}]] ${category.canonicalName}`);
  return [
    `${categories.length} category(ies) contain ${pageId}:`,
    "",
    ...listed,
    "",
    "Run `llmwiki category <category-id>` to list a category's members.",
  ].join("\n");
}

/** The stable JSON envelope, for a page id that resolved or one that could not. */
function buildJsonPayload(
  requested: string,
  pageId: string | null,
  categories: readonly ReportedCategory[],
) {
  return {
    version: CATEGORIES_HERE_JSON_VERSION,
    requested,
    pageId,
    resolved: pageId !== null,
    categoryCount: categories.length,
    categories,
  };
}

/**
 * Run `llmwiki categories-here <page-id>`.
 * @param requested - Namespaced page id (`concepts/foo`) or a bare slug (`foo`).
 * @param options - `--json` switches to the stable envelope.
 * @returns Process exit code; always 0 for a successful inspection.
 */
export default async function categoriesHereCommand(
  requested: string,
  options: CategoriesHereOptions = {},
): Promise<number> {
  const pageId = pageIdFor(requested);
  const categories = pageId === null
    ? []
    : categoriesContaining(await listCategories(process.cwd()), pageId);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(buildJsonPayload(requested, pageId, categories), null, 2)}\n`);
  } else if (pageId === null) {
    process.stdout.write(
      `"${requested}" is not a page id this wiki records.\n` +
        "Use a page id such as `concepts/some-concept`, or a bare slug.\n",
    );
  } else {
    process.stdout.write(`${renderHuman(pageId, categories)}\n`);
  }
  return 0;
}
