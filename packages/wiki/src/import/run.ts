// src/import/run.ts
/** @file Output-free OKF import core shared by CLI/SDK/MCP: read→map→collision→validate→stage/write/preview, returning a structured report. Owns the .llmwiki lock. */
import path from "path";
import { importOkfBundle } from "./okf-import.js";
import { isWritable } from "../commands/import-core.js"; // leaf created in Task 4 Step 0
import { writeCandidate, listCandidates } from "../compiler/candidates.js";
import { withPageSeams, type PageSeams } from "../dimensions/wiki/page-source-seam.js";
import { atomicWrite } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { qualifiedPageId, type PageId } from "../utils/page-id.js";
import { refreshAfterImport } from "./okf-refresh.js";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../utils/mutation-lock.js";
import { withQuiet } from "../utils/output.js";
import { LockUnavailableError, QueueFullError } from "./run-errors.js";
import { buildBundleSections, type BundleReportSections, type ParsedBundleBlock } from "./bundle-block-read.js";
import type { ImportedOkfBundle } from "./okf-import.js";
import type { MappedOkfPage } from "./types.js";

export interface OkfImportSkip { slug: string; okfPath: string; reason: "live-page" | "pending-candidate" | "duplicate-in-bundle" | "invalid-page"; }
export interface OkfImportedPage { slug: string; okfPath: string; targetDirectory: "concepts" | "queries"; }
export interface OkfImportReport extends BundleReportSections {
  mode: "staged" | "written" | "dry-run";
  pages: OkfImportedPage[];
  skipped: OkfImportSkip[];
  warnings: string[];
  nextAction?: string;
}
export interface OkfImportOptions {
  trusted?: boolean;
  dryRun?: boolean;
  maxNewCandidates?: number;
  /** Environment deciding which Stack the page seams write to; defaults to the ambient one. */
  env?: NodeJS.ProcessEnv;
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

async function stageAll(root: string, valid: MappedOkfPage[], env: NodeJS.ProcessEnv): Promise<void> {
  for (const page of valid) {
    await writeCandidate(root, env, {
      title: page.title, slug: page.slug, summary: page.summary, sources: page.sources, body: page.body,
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
      targetDirectory: page.targetDirectory, okfPath: page.okfPath,
    });
  }
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

/**
 * Refuse a staging run that would push the pending candidate queue past its cap.
 *
 * Staging (`--untrusted`, the MCP `import_okf` default) ADDS candidates to the
 * review queue, so an operator-set `maxNewCandidates` bounds how many a single
 * import may add. `--trusted` writes live and adds none, and a dry run stages
 * nothing — both are exempt. `generate` mode is unmetered, so a generate-mode
 * import is metered by the same rule as `documents`: helpers-unmounted generate
 * imports go through the ordinary staging partition. The function DOES NOT
 * re-count for a generate import; it is called only after `partition` so
 * `generate`-only bundles are inert here.
 *
 * Lives outside {@link runOkfImport} so the metering can be reasoned about
 * without reading the whole import sequence; direction of the check matters —
 * `≥` (not `>`) because `maxNewCandidates` is a cap on the TOTAL pending count
 * after the import, not on additions alone.
 *
 * @param root - Project root whose candidate queue is measured.
 * @param validCount - How many pages this import would stage.
 * @param opts - Import options carrying the cap.
 * @throws {QueueFullError} When staging would exceed the cap.
 */
async function assertQueueCapacity(root: string, validCount: number, opts: OkfImportOptions): Promise<void> {
  if (opts.maxNewCandidates === undefined || opts.trusted || opts.dryRun) return;
  const pending = (await listCandidates(root)).length;
  if (pending + validCount > opts.maxNewCandidates) throw new QueueFullError();
}

/** Read→map→collision→validate→stage/write/preview an OKF bundle; output-free; returns a report. `opts.env` selects the Stack the page seams write to; it defaults to the ambient environment, so the CLI's behaviour is unchanged. */
export async function runOkfImport(root: string, dir: string, opts: OkfImportOptions = {}): Promise<OkfImportReport> {
  const env = opts.env ?? process.env;
  const warnings: string[] = [];
  const onWarn = (m: string): number => warnings.push(m);
  if (opts.dryRun) {
    const imported = await importOkfBundle(dir, root, {}, onWarn);
    const { valid, skipped: allSkipped } = partition(imported.pages, imported.skipped as OkfImportSkip[]);
    const bundle = await bundleSectionsFor(root, imported.bundleBlock);
    return { mode: "dry-run", pages: valid.map(toImported), skipped: allSkipped, warnings, ...bundle, nextAction: "Re-run without dryRun to apply." };
  }
  // withQuiet: acquireLock prints "Another compilation is running." on contention;
  // the typed LockUnavailableError is the signal, so the core stays output-free.
  const locked = await withQuiet(() => acquireMutationLock(root, "ordinary"));
  if (!locked) throw new LockUnavailableError();
  try {
    const imported = await importOkfBundle(dir, root, {}, onWarn);
    const { valid, skipped: allSkipped } = partition(imported.pages, imported.skipped as OkfImportSkip[]);
    await assertQueueCapacity(root, valid.length, opts);
    if (opts.trusted) await writeAll(root, valid, env);
    else await stageAll(root, valid, env);
    const bundle = await bundleSectionsFor(root, imported.bundleBlock);
    return {
      mode: opts.trusted ? "written" : "staged",
      pages: valid.map(toImported),
      skipped: allSkipped,
      warnings,
      ...bundle,
      nextAction: opts.trusted ? `${valid.length} page(s) written live.` : "Review and approve before it goes live: llmwiki review list.",
    };
  } finally {
    await releaseLock(root);
  }
}
