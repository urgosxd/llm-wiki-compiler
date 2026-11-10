/**
 * @file Orchestrate an OKF import: read the bundle (confined + bounded), invert each
 * doc to a llmwiki page, then apply the collision policy. Side-effect free with respect
 * to wiki/ — the caller decides to write the pages live or to preview them.
 */
import path from "path";
import { slugify } from "../utils/markdown.js";
import { readOkfBundle, readIndexFrontmatter } from "./okf-read.js";
import { okfDocToPage, slugFromRelPath, type OkfMapContext } from "./okf-map.js";
import { filterCollisions } from "./okf-collision.js";
import { parseBundleBlock, type ParsedBundleBlock } from "./bundle-block-read.js";
import { DEFAULT_OKF_LIMITS } from "./okf-limits.js";
import type { OkfImportLimits, MappedOkfPage, RawOkfDoc } from "./types.js";
import type { SkippedOkfPage } from "./okf-collision.js";

/** Stable, filesystem-safe bundle id derived from the bundle directory name. */
function bundleIdFor(bundleDir: string): string {
  return slugify(path.basename(path.resolve(bundleDir))) || "bundle";
}

/** Build a slug->title resolver over the whole bundle so intra-bundle links reverse cleanly. */
function titleResolver(docs: RawOkfDoc[]): (slug: string) => string | null {
  const map = new Map<string, string>();
  for (const d of docs) {
    const slug = slugFromRelPath(d.relPath);
    if (typeof d.meta.title === "string") map.set(slug, d.meta.title);
  }
  return (slug) => map.get(slug) ?? null;
}

/**
 * The read+map+collision result of an OKF bundle: the mapped pages plus the inert
 * bundle block. Every doc is a native concept or query page; there is no typed leg
 * to partition and no profile for the bundle to carry.
 */
export interface ImportedOkfBundle {
  /** Concept/query pages that survived the collision policy. */
  pages: MappedOkfPage[];
  /** Collision skips. */
  skipped: SkippedOkfPage[];
  /** The inert bundle-level `x-llmwiki` block. */
  bundleBlock?: ParsedBundleBlock;
}

/**
 * Read + map + collision-filter an OKF bundle into pages ready to write, ALSO
 * parsing the bundle-level `x-llmwiki` metadata block off `index.md` as untrusted
 * input (CLP 7.6). Parse warnings are forwarded through `onWarn`; the parsed block
 * (relations/workflows/profile) is returned INERT for the caller to surface — it
 * is never applied here.
 */
export async function importOkfBundle(
  bundleDir: string,
  root: string,
  overrides: Partial<OkfImportLimits> = {},
  onWarn?: (msg: string) => void,
): Promise<ImportedOkfBundle> {
  const limits = { ...DEFAULT_OKF_LIMITS, ...overrides };
  const docs = await readOkfBundle(bundleDir, overrides, onWarn);
  const indexMeta = await readIndexFrontmatter(bundleDir, limits, onWarn);
  const { block, warnings } = parseBundleBlock(indexMeta, limits);
  if (onWarn) warnings.forEach(onWarn);
  const ctx: OkfMapContext = { bundleId: bundleIdFor(bundleDir), titleOf: titleResolver(docs) };
  const { kept, skipped } = await filterCollisions(root, docs.map((d) => okfDocToPage(d, ctx)));
  return { pages: kept, skipped, bundleBlock: block };
}
