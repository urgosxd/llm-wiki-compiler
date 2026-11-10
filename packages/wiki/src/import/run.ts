// src/import/run.ts
/**
 * @file Output-free OKF import core shared by SDK/MCP: read→map→collision→validate→write/preview,
 * returning a structured report. Owns the mutation lock.
 *
 * The live write is a TRUSTED operation. An untrusted import used to stage every document as a
 * review candidate under `.llmwiki/candidates/`, and no surface promotes a candidate into the
 * wiki, so those records could never become pages; that arm is retired and an untrusted call
 * now refuses with a typed error instead of staging. A `dryRun` preview still works: it writes
 * nothing at all.
 */
import path from "path";
import { importOkfBundle } from "./okf-import.js";
import { isWritable } from "../commands/import-core.js"; // leaf created in Task 4 Step 0
import { withPageSeams, type PageSeams } from "../dimensions/wiki/page-source-seam.js";
import { atomicWrite } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { qualifiedPageId, type PageId } from "../utils/page-id.js";
import { refreshAfterImport } from "./okf-refresh.js";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../utils/mutation-lock.js";
import { withQuiet } from "../utils/output.js";
import { LockUnavailableError } from "./run-errors.js";
import { buildBundleSections, type BundleReportSections, type ParsedBundleBlock } from "./bundle-block-read.js";
import type { ImportedOkfBundle } from "./okf-import.js";
import type { MappedOkfPage } from "./types.js";

export interface OkfImportSkip { slug: string; okfPath: string; reason: "live-page" | "pending-candidate" | "duplicate-in-bundle" | "invalid-page"; }
export interface OkfImportedPage { slug: string; okfPath: string; targetDirectory: "concepts" | "queries"; }
export interface OkfImportReport extends BundleReportSections {
  mode: "written" | "dry-run";
  pages: OkfImportedPage[];
  skipped: OkfImportSkip[];
  warnings: string[];
  nextAction?: string;
}
export interface OkfImportOptions {
  /**
   * Write the bundle's pages straight into the wiki. REQUIRED for a real import: it is
   * the only surviving import arm, so an import that does not name it refuses instead of
   * staging its documents as review candidates.
   */
  trusted?: boolean;
  dryRun?: boolean;
  /** Environment deciding which Stack the page seams write to; defaults to the ambient one. */
  env?: NodeJS.ProcessEnv;
}

/** Verbatim refusal text, so a caller can match on it and a test can pin it. */
const UNTRUSTED_IMPORT_REFUSAL =
  "The untrusted OKF import no longer exists: staging documents as review candidates " +
  "is retired, because no surface promotes a candidate into the wiki. Import with " +
  "{ trusted: true } to write the bundle's pages live; see docs/guides/open-knowledge-format.mdx.";

/**
 * The refusal an untrusted import raises.
 *
 * It teaches rather than merely blocks: it names what no longer happens (staging for review),
 * why (no surface promotes a candidate into the wiki), the surviving option, and where that
 * option is documented.
 */
export class UntrustedOkfImportError extends Error {
  constructor(message = UNTRUSTED_IMPORT_REFUSAL) {
    super(message);
    this.name = "UntrustedOkfImportError";
  }
}

const toImported = (p: MappedOkfPage): OkfImportedPage => ({ slug: p.slug, okfPath: p.okfPath, targetDirectory: p.targetDirectory });

/** Build the inert bundle-block report sections from a parsed block (none → {}). */
async function bundleSectionsFor(root: string, block: ParsedBundleBlock | undefined): Promise<BundleReportSections> {
  return block ? buildBundleSections(root, block) : {};
}

/** Partition mapped pages (single pass) + assemble the skip list (collisions ∪ invalid). */
function partition(pages: MappedOkfPage[], collisionSkips: OkfImportSkip[]): { valid: MappedOkfPage[]; skipped: OkfImportSkip[] } {
  const valid: MappedOkfPage[] = [];
  const invalid: OkfImportSkip[] = [];
  for (const p of pages) {
    if (isWritable(p)) valid.push(p);
    else invalid.push({ slug: p.slug, okfPath: p.okfPath, reason: "invalid-page" });
  }
  return { valid, skipped: [...collisionSkips, ...invalid] };
}

async function writeAll(root: string, valid: MappedOkfPage[], env: NodeJS.ProcessEnv): Promise<void> {
  // The namespace IS the targetDirectory basename ("concepts" / "queries"), so a
  // concept `foo` and a query `foo` imported together invalidate independently.
  const written: PageId[] = [];
  // A STACK STORES THESE AS ROWS. `concepts` and `queries` are exactly the two
  // namespaces `wiki.pages.page_directory` admits, so there IS a row to write here —
  // unlike the entity paths, which have to refuse. `withPageSeams` resolves the sink
  // for a Stack and yields all-undefined for a file project, whose branch is
  // unchanged. It is handed `env` rather than `process.env` so a caller that named a
  // Stack (the MCP tool) writes to THAT Stack instead of the bound one.
  await withPageSeams(env, async (seams) => {
    try {
      for (const page of valid) {
        await writeOneImportedPage(root, page, seams);
        written.push(qualifiedPageId(page.targetDirectory, page.slug));
      }
    } finally {
      if (written.length) await refreshAfterImport(root, written, env);
    }
  });
}

/**
 * Write one imported page to the backend this project uses.
 *
 * @param root - Absolute project root.
 * @param page - The mapped bundle page.
 * @param seams - Resolved page seams; `sink` is absent on a file-backed project.
 */
async function writeOneImportedPage(
  root: string,
  page: MappedOkfPage,
  seams: PageSeams,
): Promise<void> {
  if (seams.sink !== undefined) {
    await seams.sink({ directory: page.targetDirectory, slug: page.slug, body: page.body });
    return;
  }
  const dir = page.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
  await atomicWrite(path.join(root, dir, `${page.slug}.md`), page.body);
}

/** Read→map→collision→validate→write/preview an OKF bundle; output-free; returns a report. `opts.env` selects the Stack the page seams write to; it defaults to the ambient environment, so the CLI's behaviour is unchanged. */
export async function runOkfImport(root: string, dir: string, opts: OkfImportOptions = {}): Promise<OkfImportReport> {
  const env = opts.env ?? process.env;
  const warnings: string[] = [];
  const onWarn = (m: string): number => warnings.push(m);
  if (opts.dryRun) {
    const imported = await importOkfBundle(dir, root, {}, onWarn);
    const { valid, skipped: allSkipped } = partition(imported.pages, imported.skipped as OkfImportSkip[]);
    const bundle = await bundleSectionsFor(root, imported.bundleBlock);
    return { mode: "dry-run", pages: valid.map(toImported), skipped: allSkipped, warnings, ...bundle, nextAction: "Re-run with { trusted: true } to write these pages live." };
  }
  // Refuse BEFORE asking for the lock: the refusal is a property of the CALL, not of the
  // project's state, so an untrusted import must not contend for (or wait on) the lock.
  if (!opts.trusted) throw new UntrustedOkfImportError();
  // withQuiet: acquireLock prints "Another compilation is running." on contention;
  // the typed LockUnavailableError is the signal, so the core stays output-free.
  const locked = await withQuiet(() => acquireMutationLock(root, "ordinary"));
  if (!locked) throw new LockUnavailableError();
  try {
    const imported = await importOkfBundle(dir, root, {}, onWarn);
    const { valid, skipped: allSkipped } = partition(imported.pages, imported.skipped as OkfImportSkip[]);
    await writeAll(root, valid, env);
    const bundle = await bundleSectionsFor(root, imported.bundleBlock);
    return {
      mode: "written",
      pages: valid.map(toImported),
      skipped: allSkipped,
      warnings,
      ...bundle,
      nextAction: `${valid.length} page(s) written live.`,
    };
  } finally {
    await releaseLock(root);
  }
}
