/**
 * @file The ONE canonical corpus the file-backed / row-backed parity suite replays (S7).
 *
 * ## Why one corpus instead of four per-artifact fixtures
 *
 * Parity is a claim about a WIKI, not about four independent stores. The four artifacts
 * interfere: the curated link is anchored on an ALIAS the identity tier folded onto a
 * page, the page the attribution census MARKED is the one that carries the link, and the
 * category was accepted because its criterion quotes a term of that marked page's body.
 * Four fixtures would let each artifact be measured against a corpus that cannot exhibit
 * the interference, so a backend could pass all four and still degrade the combination.
 *
 * ## The corpus, and the run sequence that produces every artifact
 *
 *  - `sistemas.md` the article "Sistemas distribuidos". Its body names a vector store by
 *                  an ALIAS, and it quotes the category criterion's term.
 *  - `consenso.md` a SECOND account of the same concept, so the merged page contributes
 *                  two sources while its prose cites only one: the attribution gap.
 *  - `vectores.md` a source whose extraction reports ONE concept under two spellings
 *                  (`Vector DB` / `Vector Database`), which the identity tier folds.
 *
 * Run 1 ingests `sistemas.md` + `consenso.md` in ONE compile: the merged page carries both
 * contributing sources, cites one, and is therefore marked and counted.
 * Run 2 ingests `vectores.md`: the target page is created with the folded alias, and the
 * reference review curates a link INTO the earlier page, anchored on that alias.
 * Run 3 revises both merged sources, so the marked page is REGENERATED: the curated link
 * can be there only if the record was read back and re-anchored, and the gap can be there
 * only if it survived the round trip.
 * Run 4 re-ingests them again with a body that no longer holds the mention: the record
 * must be dropped AND reported, which is the other direction of the same rule.
 *
 * ## Why the stream is captured around single compiles
 *
 * `captureProcessIo` REPLACES the stream spies on each call, so one capture held across
 * two compiles would collect only the second one's output. Each compile below therefore
 * gets its own capture, and only the capture of the phase being measured is kept.
 *
 * ## Why the comparison excludes `createdAt`
 *
 * Every field that decides whether a record can be re-anchored is compared byte for byte
 * -- source, target, the anchor's text and both prose sides, the provenance channel, the
 * stable key. The record's creation instant is the one field two runs of the same input
 * legitimately disagree about, and it is not observable through the link.
 */

import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { createFileCuratedLinkStore } from "../../packages/wiki/src/compiler/curated-links-store.js";
import type { CuratedLinkRecord, CuratedLinkStorePort } from "../../packages/wiki/src/compiler/curated-links.js";
import { createRowCuratedLinkStore } from "../../packages/wiki/src/dimensions/wiki/curated-links-row-store.js";
import { createPageContentSource } from "../../packages/wiki/src/dimensions/wiki/page-scan-source.js";
import { saveSourceDocument } from "../../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import type { CategoryMember, CategoryRecord } from "../../packages/wiki/src/categories/types.js";
import { CONCEPTS_DIR } from "../../packages/wiki/src/utils/constants.js";
import { parseFrontmatter } from "../../packages/wiki/src/utils/markdown.js";
import {
  proposal,
  proposalAnswer,
  readCategoryRecord,
  SISTEMAS_TITLE,
  sistemasProposal,
} from "./category-scenario.js";
import { categoryRows, memberRows, storeFor } from "./category-rows.js";
import { extractionAnswer, stubCompileProvider } from "./compile-provider.js";
import { MERGED_ALIAS, betaExtraction, writeSource } from "./curated-scenario.js";
import type { KgPostgresHarness } from "./kg-postgres.js";
import { captureProcessIo } from "./process-io.js";

/** Source whose article is the MERGED page: it draws on two sources. */
export const SISTEMAS_FILE = "sistemas.md";

/** Second source of the same concept, never cited by the page it contributes to. */
export const CONSENSO_FILE = "consenso.md";

/** Source whose ingest creates the link target and folds its alias. */
export const VECTORES_FILE = "vectores.md";

/** Page slug of the merged article, and the id of the category named after it. */
export const SISTEMAS_SLUG = "sistemas-distribuidos";

/** Slug of the link target, and of the page the folded alias landed on. */
export const TARGET_SLUG = "vector-db";

/** Slug the FOLDED spelling would own if the identity tier had not folded it. */
export const FOLDED_SLUG = "vector-database";

/** The target page's canonical title, which the fold must preserve. */
export const TARGET_TITLE = "Vector DB";

/** The alias the identity fold produced, and the text the curated link anchors on. */
export const TARGET_ALIAS = MERGED_ALIAS;

/** Marker that routes the extraction stub to each source. */
const SISTEMAS_MARKER = "SISTEMAS SOURCE TEXT";
const CONSENSO_MARKER = "CONSENSO SOURCE TEXT";
const VECTORES_MARKER = "VECTORES SOURCE TEXT";

/** The prose the merged page is rendered with: one citation, one alias mention. */
const MERGED_BODY =
  `Distribuidos: consenso distribuido, vectores en un ${TARGET_ALIAS}. ^[${SISTEMAS_FILE}:1-1]`;

/** The same page once the mention that justified the curated link is gone. */
const MERGED_BODY_WITHOUT_TARGET =
  `Distribuidos: consenso distribuido. ^[${SISTEMAS_FILE}:1-1]`;

/** The target page: a single contributing source, which its prose cites. */
const TARGET_BODY = `Vector DB keeps embeddings for retrieval. ^[${VECTORES_FILE}:1-1]`;

/** Source documents. A revision changes the SOURCE, never the rendered body. */
const SISTEMAS_DOCUMENT = `# Sistemas distribuidos\n\n${SISTEMAS_MARKER}. Consenso distribuido.\n`;
const SISTEMAS_DOCUMENT_REVISED = `${SISTEMAS_DOCUMENT.trimEnd()} Revisado.\n`;
const CONSENSO_DOCUMENT = `# Consenso\n\n${CONSENSO_MARKER}. Un segundo relato.\n`;
const CONSENSO_DOCUMENT_REVISED = `${CONSENSO_DOCUMENT.trimEnd()} Revisado.\n`;
const VECTORES_DOCUMENT = `# Vector DB\n\n${VECTORES_MARKER}. Vector DB keeps embeddings.\n`;

/** The link markup the overlay has to restore. */
export const LINK = `[[${TARGET_SLUG}|${TARGET_ALIAS}]]`;

/** The per-record line the overlay prints for a record it cannot re-anchor. */
export const DROP_LINE =
  `Curated link dropped on concepts/${SISTEMAS_SLUG}: concepts/${TARGET_SLUG} ` +
  `— anchor-missing ("${TARGET_ALIAS}" is no longer a plain mention).`;

/** The run's counted line for that drop. */
export const DROP_SUMMARY = "Curated links: 0 link(s) restored, 1 dropped (1 anchor-missing).";

/** The run's counted line for the marked page: one page, one missing source, both named. */
export const GAP_LINE = "Attribution: 1 page(s) not fully attributed (1 source reference(s) missing) " +
  `— ${SISTEMAS_TITLE} is missing ${CONSENSO_FILE}`;

/** Narrows a run's output to the lines that report the four artifacts. */
const ARTIFACT_MARKERS = ["Attribution:", "Curated links:", "Curated link dropped", "Categories:"];

/** One curated record, in the shape both stores answer, minus the wall-clock instant. */
export interface ComparableLink extends Record<string, unknown> {
  readonly stableKey: string;
  readonly sourcePageId: string;
  readonly targetPageId: string;
  readonly anchor: { text: string; before: string; after: string };
  readonly provenance: string;
}

/** One category, in the shape both stores answer. */
export interface ComparableCategory extends Record<string, unknown> {
  readonly categoryId: string;
  readonly canonicalName: string;
  readonly description: string;
  readonly inclusionCriterion: string;
  readonly members: readonly CategoryMember[];
}

/** Everything one backend produced from the corpus, as the other backend's run is compared. */
export interface ParityEvidence {
  /** Every concept page the backend stores, in slug order. */
  readonly conceptSlugs: readonly string[];
  /** The folded name the target page carries. */
  readonly targetAliases: readonly string[];
  /** The target page's title, which must survive the fold unchanged. */
  readonly targetTitle: string | undefined;
  /** True when the folded spelling got a page of its own, which would be a split. */
  readonly foldedPageExists: boolean;
  /** Every curated record the store holds after the restore run. */
  readonly curatedRecords: readonly ComparableLink[];
  /** The merged page's prose after the restore run, as a reader receives it. */
  readonly restoredBody: string;
  /** The merged page's marked sources, after the restore run. */
  readonly markedGaps: readonly string[];
  /** The link target's marked sources: fully attributed, so none. */
  readonly cleanGaps: readonly string[];
  /** The category the merged article was accepted into. */
  readonly category: ComparableCategory | undefined;
  /** Category rows and membership rows the Stack holds, read with SQL as a guard. */
  readonly categoryRowCount: number;
  readonly memberRowCount: number;
  /** The artifact lines of the FIRST run, where the category was accepted. */
  readonly firstReport: string;
  /** The artifact lines of the restore run. */
  readonly restoreReport: string;
  /** The artifact lines of the drop run. */
  readonly dropReport: string;
  /** Curated records left after the drop run. */
  readonly recordsAfterDrop: number;
  /** The merged page's prose after the drop run. */
  readonly bodyAfterDrop: string;
}

/**
 * Answer every provider call the corpus needs, for one compile.
 *
 * Extraction routes on the SOURCE text because the extraction prompt also carries the
 * wiki index and therefore every title compiled so far. The assignment call routes on the
 * ARTICLE, which its prompt names exactly once.
 *
 * @param mergedBody - The merged page's prose for the run about to happen.
 */
function stubCorpusProvider(mergedBody: string): void {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  stubCompileProvider({
    extraction: (system) => (system.includes(VECTORES_MARKER)
      ? betaExtraction()
      : extractionAnswer([SISTEMAS_TITLE])),
    body: (system) => (system.includes(`Concept to write about: "${TARGET_TITLE}"`)
      ? TARGET_BODY
      : mergedBody),
    review: () => JSON.stringify({ should_link: true, mention: TARGET_ALIAS }),
    categories: (system) => (system.includes(`Article to categorise: "${SISTEMAS_TITLE}"`)
      ? proposalAnswer(
        proposal({ name: "Kubernetes", criterion: 'Páginas que mencionen "kubernetes".' }),
        sistemasProposal(),
      )
      : proposalAnswer()),
  });
}

/**
 * Ingest one document into the Stack (when there is one) and leave the same bytes on disk.
 *
 * Writing both is what makes ONE corpus replayable through both backends: the row-backed
 * compile reads the document store, the file-backed one reads `sources/`.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @param file - Source filename, used as the identity AND written to `sources/`.
 * @param document - Markdown the compiler extracts from.
 */
async function ingestDocument(
  root: string,
  harness: KgPostgresHarness | undefined,
  file: string,
  document: string,
): Promise<void> {
  if (harness !== undefined) {
    await saveSourceDocument(harness.db, harness.stackId, {
      title: file.replace(/\.md$/u, ""),
      document,
      source: file,
    });
  }
  await writeSource(root, file, document);
}

/**
 * Ingest the merged article's two contributing sources.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @param revised - True for the revision, which must re-render the page.
 */
async function ingestMergedSources(
  root: string,
  harness: KgPostgresHarness | undefined,
  revised: boolean,
): Promise<void> {
  const sistemas = revised ? SISTEMAS_DOCUMENT_REVISED : SISTEMAS_DOCUMENT;
  const consenso = revised ? CONSENSO_DOCUMENT_REVISED : CONSENSO_DOCUMENT;
  await ingestDocument(root, harness, SISTEMAS_FILE, sistemas);
  await ingestDocument(root, harness, CONSENSO_FILE, consenso);
}

/**
 * Compile with the corpus stub installed and return what the run printed.
 *
 * @param root - Project root.
 * @param mergedBody - The merged page's prose for this run.
 * @returns Everything the compile wrote to stdout and stderr.
 */
async function compileStep(root: string, mergedBody: string): Promise<string> {
  stubCorpusProvider(mergedBody);
  const io = captureProcessIo();
  await compileAndReport(root);
  return io.out() + io.err();
}

/**
 * One page's full markdown, through the reader the compile itself uses for that backend.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @param slug - Page slug under `wiki/concepts`.
 * @returns Frontmatter plus body, or undefined when the backend has no such page.
 */
async function pageMarkdown(
  root: string,
  harness: KgPostgresHarness | undefined,
  slug: string,
): Promise<string | undefined> {
  if (harness !== undefined) {
    return await createPageContentSource(harness.db, harness.stackId).read("concepts", slug);
  }
  return await readFile(path.join(root, CONCEPTS_DIR, `${slug}.md`), "utf-8").catch(() => undefined);
}

/**
 * The concept pages one backend stores, in slug order.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @returns Page slugs, no directories and no extensions.
 */
async function conceptSlugs(
  root: string,
  harness: KgPostgresHarness | undefined,
): Promise<string[]> {
  if (harness !== undefined) {
    const slugs = await createPageContentSource(harness.db, harness.stackId).listSlugs("concepts");
    return [...slugs].sort();
  }
  const files = await readdir(path.join(root, CONCEPTS_DIR)).catch(() => [] as string[]);
  return files
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
}

/**
 * The curated-link store of one backend: the SAME port the compile path uses.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @returns The store port for that backend.
 */
function curatedStore(
  root: string,
  harness: KgPostgresHarness | undefined,
): CuratedLinkStorePort {
  return harness === undefined
    ? createFileCuratedLinkStore(root)
    : createRowCuratedLinkStore(harness.db, harness.stackId);
}

/**
 * The curated records of one backend, comparable across backends.
 *
 * @param store - The backend's store port.
 * @returns The comparable records, in stable-key order.
 */
async function comparableRecords(store: CuratedLinkStorePort): Promise<ComparableLink[]> {
  const records: readonly CuratedLinkRecord[] = await store.load();
  return records
    .map((record) => ({
      stableKey: record.stableKey,
      sourcePageId: record.sourcePageId,
      targetPageId: record.targetPageId,
      anchor: record.anchor,
      provenance: record.provenance,
    }))
    .sort((left, right) => (left.stableKey < right.stableKey ? -1 : 1));
}

/**
 * One category record, reduced to the fields both backends must agree on.
 *
 * The port answers `null` for a category a backend does not hold, so that is folded into
 * `undefined` here rather than asserted on: the anti-vacuity check in the suite is what
 * reports a backend that stored nothing, and it reports it as one failing artifact instead
 * of as a crash in the fixture.
 *
 * @param record - The record, or null/undefined when the backend stores none.
 * @returns The comparable record.
 */
function comparableCategory(
  record: CategoryRecord | null | undefined,
): ComparableCategory | undefined {
  if (record === null || record === undefined) return undefined;
  return {
    categoryId: record.categoryId,
    canonicalName: record.canonicalName,
    description: record.description,
    inclusionCriterion: record.inclusionCriterion,
    members: record.members,
  };
}

/**
 * The artifact-reporting lines of one run, joined; "" when the run reported none.
 *
 * @param printed - Everything the run wrote.
 * @returns The lines that report the four artifacts.
 */
export function artifactLines(printed: string): string {
  return printed
    .split("\n")
    .filter((line) => ARTIFACT_MARKERS.some((marker) => line.includes(marker)))
    .join("\n");
}

/**
 * Coerce a frontmatter list value into strings, dropping anything else.
 *
 * @param raw - The parsed frontmatter field.
 * @returns The field's strings, or an empty list.
 */
function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map(String) : [];
}

/**
 * The four artifacts of one backend, once the restore run has settled.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @param printed - What the restore run wrote.
 * @param firstPrinted - What the FIRST run wrote, where the category was accepted.
 * @returns That backend's evidence.
 */
async function evidenceOf(
  root: string,
  harness: KgPostgresHarness | undefined,
  printed: string,
  firstPrinted: string,
): Promise<Omit<ParityEvidence, "dropReport" | "recordsAfterDrop" | "bodyAfterDrop">> {
  const target = parseFrontmatter(await pageMarkdown(root, harness, TARGET_SLUG) ?? "");
  const merged = parseFrontmatter(await pageMarkdown(root, harness, SISTEMAS_SLUG) ?? "");
  const category = harness === undefined
    ? await readCategoryRecord(root, SISTEMAS_SLUG).catch(() => undefined)
    : await storeFor(harness).read(SISTEMAS_SLUG);
  return {
    conceptSlugs: await conceptSlugs(root, harness),
    targetAliases: stringList(target.meta.aliases),
    targetTitle: typeof target.meta.title === "string" ? target.meta.title : undefined,
    foldedPageExists: (await pageMarkdown(root, harness, FOLDED_SLUG)) !== undefined,
    curatedRecords: await comparableRecords(curatedStore(root, harness)),
    restoredBody: merged.body,
    markedGaps: stringList(merged.meta.attributionGaps),
    cleanGaps: stringList(target.meta.attributionGaps),
    category: comparableCategory(category),
    categoryRowCount: harness === undefined ? 0 : (await categoryRows(harness)).length,
    memberRowCount: harness === undefined ? 0 : (await memberRows(harness)).length,
    restoreReport: artifactLines(printed),
    firstReport: artifactLines(firstPrinted),
  };
}

/**
 * Replay the WHOLE corpus against one backend and collect all four artifacts.
 *
 * @param root - Project root for that backend.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @returns The backend's evidence, in the shape the other backend's run is compared on.
 */
export async function runParityCorpus(
  root: string,
  harness?: KgPostgresHarness,
): Promise<ParityEvidence> {
  await mkdir(path.join(root, CONCEPTS_DIR), { recursive: true });
  await ingestMergedSources(root, harness, false);
  const firstPrinted = await compileStep(root, MERGED_BODY);
  await ingestDocument(root, harness, VECTORES_FILE, VECTORES_DOCUMENT);
  await compileStep(root, MERGED_BODY);
  await ingestMergedSources(root, harness, true);
  const afterRestore = await evidenceOf(
    root, harness, await compileStep(root, MERGED_BODY), firstPrinted,
  );
  await ingestMergedSources(root, harness, false);
  const dropPrinted = await compileStep(root, MERGED_BODY_WITHOUT_TARGET);
  const store = curatedStore(root, harness);
  return {
    ...afterRestore,
    dropReport: artifactLines(dropPrinted),
    recordsAfterDrop: (await store.load()).length,
    bodyAfterDrop: parseFrontmatter(await pageMarkdown(root, harness, SISTEMAS_SLUG) ?? "").body,
  };
}
