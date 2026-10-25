/**
 * Concept-extraction phase (Phase 1) for the compilation pipeline.
 *
 * Owns the single responsibility of turning source files into
 * {@link ExtractionResult}s via the LLM: reading each source, sending it (with
 * the confined wiki index as dedup context) to the extraction model, and
 * fanning the batch out under a shared concurrency limit with first-failure
 * short-circuit. Expands the directly-changed batch to any unchanged sources
 * whose concepts overlap newly-extracted slugs. No pages are written here — the
 * results feed the page-generation phase in the orchestration spine.
 */

import { readFile } from "fs/promises";
import path from "path";
import {
  readConfinedWikiFile,
  warnDroppedWikiReadIfPresent,
} from "./confined-wiki-read.js";
import { callClaude } from "../utils/llm.js";
import type { SourceContentSource } from "./hasher.js";
import type {
  PageScanSource,
  ScannedPageShape,
} from "../dimensions/wiki/page-scan-source.js";
import {
  CONCEPT_EXTRACTION_TOOL,
  buildExtractionPrompt,
  parseConcepts,
} from "./prompts.js";
import {
  findLateAffectedSources,
  type ExtractionResult,
} from "./deps.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import { INDEX_FILE, SOURCES_DIR } from "../utils/constants.js";
import pLimit from "p-limit";
import { reusableExtraction } from "./extraction-snapshot.js";
import type {
  ExtractedConcept,
  SourceChange,
  WikiState,
} from "../utils/types.js";

/**
 * Extract a batch of sources in parallel under a shared concurrency limit.
 *
 * Promise.all preserves input order, so the result matches the old serial
 * order that mergeExtractions relies on when reconciling same-slug concepts.
 * On the first hard failure a shared `aborted` flag short-circuits every
 * not-yet-started source: pLimit keeps draining its queue after Promise.all
 * rejects, and without this guard those queued sources would still issue their
 * (now-pointless) LLM calls — wasted cost/quota exactly when the provider is
 * already failing. In-flight sources still finish; only the queue is skipped.
 */
async function extractSourcesLimited(
  root: string,
  files: string[],
  limit: ReturnType<typeof pLimit>,
  reuse: ExtractionReuse,
  contentSource?: SourceContentSource,
  scanSource?: PageScanSource,
): Promise<ExtractionResult[]> {
  let aborted = false;
  return Promise.all(files.map((file) => limit(async () => {
    if (aborted) throw new Error(`extraction skipped for ${file}: a prior source failed`);
    try {
      return await extractForSource(root, file, reuse, contentSource, scanSource);
    } catch (err) {
      aborted = true;
      throw err;
    }
  })));
}

/**
 * The two views a compile has of its own changes. They answer different
 * questions and are NOT interchangeable, so they travel as one named pair
 * rather than as two same-typed positional arguments that can be swapped.
 */
export interface ChangeSets {
  /** What this run acts on, after any `changeFilter`. */
  scoped: SourceChange[];
  /** Everything found on disk, before any `changeFilter`. */
  detected: SourceChange[];
}

/** Only unchanged sources not explicitly requested by this run may reuse metadata. */
interface ExtractionReuse {
  state: WikiState;
  eligible: ReadonlySet<string>;
}

/**
 * Phase 1: extract concepts for the directly-changed batch, then repeatedly
 * expand to unchanged sources whose concepts overlap newly extracted slugs.
 * Every batch shares one `pLimit(concurrency)` cap. Discovery continues to a
 * fixed point because a late owner's extraction can reveal another owner that
 * was absent from its prior state entry.
 */
export async function runExtractionPhases(
  root: string,
  toCompile: SourceChange[],
  state: WikiState,
  changeSets: ChangeSets,
  concurrency: number,
  reusableSources: ReadonlySet<string> = new Set(),
  contentSource?: SourceContentSource,
  scanSource?: PageScanSource,
): Promise<ExtractionResult[]> {
  const limit = pLimit(concurrency);
  const reuse = { state, eligible: reusableSources };
  const extractions = await extractSourcesLimited(
    root, toCompile.map((c) => c.file), limit, reuse, contentSource, scanSource,
  );

  while (true) {
    const extracted = new Set(extractions.map((result) => result.sourceFile));
    const lateAffected = findLateAffectedSources(
      extractions, state, changeSets.scoped, extracted, changeSets.detected,
    );
    if (lateAffected.length === 0) break;
    for (const file of lateAffected) {
      output.status("~", output.info(`${file} [shares concept with new source]`));
    }
    const batch = await extractSourcesLimited(
      root, lateAffected, limit, reuse, contentSource, scanSource,
    );
    extractions.push(...batch);
  }

  return extractions;
}

/**
 * Obtain a document's text, from the table when the run is Stack-backed.
 *
 * Keyed by source identity here, not by filename, because that is what change
 * detection now returns. A run that discovered rows and then read a directory would
 * look for a file named after a URL -- and fail on every document.
 *
 * `sourcePath` is reported only when a file was read. A caller that receives none
 * knows there is no path to re-read, which is what stops a later stage from
 * guessing one.
 *
 * @param root - Project root, used only by the file path.
 * @param sourceFile - Source identity, or filename when no Stack is configured.
 * @param contentSource - Row reader, or undefined to read the file.
 * @returns The text and, when it came from disk, its path.
 */
async function loadSourceText(
  root: string,
  sourceFile: string,
  contentSource: SourceContentSource | undefined,
): Promise<{ sourcePath?: { sourcePath: string }; sourceContent: string }> {
  if (contentSource !== undefined) {
    const document = await contentSource.read(sourceFile);
    // A row that vanished between detection and extraction is a race worth naming;
    // silently skipping it would retire the document without recording why.
    if (document === undefined) {
      throw new Error(`source document ${sourceFile} disappeared before extraction`);
    }
    return { sourceContent: document.content };
  }
  const sourcePath = path.join(root, SOURCES_DIR, sourceFile);
  return { sourcePath: { sourcePath }, sourceContent: await readFile(sourcePath, "utf-8") };
}

/**
 * Phase 1: Extract concepts from a source without generating pages.
 * Returns extraction data for the generation phase.
 */
async function extractForSource(
  root: string,
  sourceFile: string,
  reuse: ExtractionReuse,
  contentSource?: SourceContentSource,
  scanSource?: PageScanSource,
): Promise<ExtractionResult> {
  const { sourcePath, sourceContent } = await loadSourceText(root, sourceFile, contentSource);
  const cached = reuse.eligible.has(sourceFile)
    ? reusableExtraction(reuse.state.sources[sourceFile], sourceContent) : undefined;
  if (cached) {
    output.status("~", output.dim(`Reusing extraction: ${sourceFile}`));
    return { sourceFile, ...sourcePath, sourceContent, concepts: cached, reused: true };
  }
  output.status("*", output.info(`Extracting: ${sourceFile}`));
  const lines = sourceContent.split("\n").length;
  const chars = sourceContent.length;
  verbose(`source ${sourceFile}: ${lines} lines, ${chars} chars`);
  const existingIndex = await readConfinedExtractionIndex(root, scanSource);
  const concepts = await extractConcepts(sourceContent, existingIndex);

  if (concepts.length > 0) {
    const names = concepts.map((c) => c.concept).join(", ");
    output.status("*", output.dim(`  Found ${concepts.length} concepts: ${names}`));
  }
  return { sourceFile, ...sourcePath, sourceContent, concepts,
    previousConcepts: reuse.state.sources[sourceFile]?.concepts ?? [] };
}

/**
 * Render the same index text the prompt used to read from `index.md`.
 *
 * Only the concepts section: extraction asks the model not to duplicate a concept
 * that already exists, which depends on titles, not on queries or entity pages.
 *
 * @param scanned - Concept pages in the scan shape.
 * @returns A markdown list, or an empty string when there are no pages.
 */
function renderIndexFromScan(scanned: ScannedPageShape[]): string {
  const rows = scanned
    .filter(({ meta }) => typeof meta.title === "string" && meta.title !== "" && !meta.orphaned)
    .map(({ slug, meta }) => `- **[[${slug}|${String(meta.title)}]]**`);
  if (rows.length === 0) return "";
  return ["# Knowledge Wiki", "", "## Concepts", "", ...rows].join("\n");
}

/**
 * Read `wiki/index.md` through the confined helper for the EXTRACTION prompt.
 * The index bytes are sent to the extraction LLM as dedup context, so a
 * symlinked `wiki/index.md` whose target escapes the project root is dropped
 * (warned, skipped) and extraction proceeds with an EMPTY index — its
 * out-of-tree bytes never reach the provider. An absent index yields an empty
 * string, byte-identical to before.
 *
 * This is the fixed-file (`readConfinedWikiFile`) twin of the per-page
 * `readWikiPageContentOrWarn(..., warnAlways=false)` policy: absence is normal,
 * so the drop warning fires only when the file physically exists.
 */
async function readConfinedExtractionIndex(
  root: string,
  scanSource?: PageScanSource,
): Promise<string> {
  // Built from rows when they are the corpus: the prompt only needs each page's
  // title and summary to avoid duplicating a concept, and that is exactly what the
  // scan shape carries. `index.md` is a projection of this, so deriving it keeps the
  // prompt identical while removing the file as a requirement.
  if (scanSource !== undefined) return renderIndexFromScan(await scanSource.scan("concepts"));
  const result = await readConfinedWikiFile(root, INDEX_FILE);
  if ("content" in result) return result.content;
  // An absent index shares the escapes-dir reason; warn only when index.md
  // physically exists (an escaping symlink or a fail-closed read).
  await warnDroppedWikiReadIfPresent(path.join(root, INDEX_FILE), INDEX_FILE, result.dropped);
  return "";
}

/**
 * Call Claude to extract concepts from a source document.
 * @param sourceContent - Full source document text.
 * @param existingIndex - Current wiki index for deduplication.
 * @returns Parsed array of extracted concepts.
 */
async function extractConcepts(
  sourceContent: string,
  existingIndex: string,
): Promise<ExtractedConcept[]> {
  const system = buildExtractionPrompt(sourceContent, existingIndex);
  const rawOutput = await callClaude({
    system,
    messages: [{ role: "user", content: "Extract the key concepts from this source." }],
    tools: [CONCEPT_EXTRACTION_TOOL],
  });

  return parseConcepts(rawOutput);
}
