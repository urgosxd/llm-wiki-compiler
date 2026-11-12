/**
 * @file scripts/link-candidates-report.ts
 * @description Assembles and renders the two artifacts one run produces: a complete
 * machine-readable JSON record, and a markdown view a human can label by hand.
 *
 * ## Why two artifacts and not one
 *
 * They answer different questions. The JSON has to be COMPLETE — every incremental
 * pair at every threshold, every count, the read-only proof — because it is the
 * record of what the run saw, and a record that dropped rows to stay readable would
 * be worthless. The markdown has to be LABELLABLE — a bounded sample per threshold
 * with a checkbox and an empty verdict slot — because the number this whole channel
 * exists to produce (precision) is not computable from the data at all: a human has
 * to decide, pair by pair, whether the relation is real. Rendering the same object
 * twice makes the two views provably about the same run.
 *
 * ## Why there are no timestamps
 *
 * The artifacts are meant to be diffed: rerun the measurement on an unchanged corpus
 * and the report should be byte-identical, so a reviewer sees only what actually
 * changed. A clock reading anywhere in here would break that on every run, and an
 * unordered map would break it intermittently, which is worse.
 *
 * ## Why the caveats are part of the artifact
 *
 * Two of them change how the numbers may be read: the alias half of the
 * lexical-exclusion filter never ran against real data (the corpora carry no
 * declared aliases), and the 398-page corpus's dangling-link rate is a separate
 * population that these counts must not be read against. A reader who has only the
 * markdown must not be able to reach a stronger conclusion than the run supports, so
 * the caveats travel with the numbers instead of living in a chat message.
 */

import {
  sampleCandidates,
  stratifyCandidates,
  type RenderedCandidatePair,
  type StratumReport,
} from "./link-candidates.js";
import { redactSecrets, type CorpusMeasurement, type ReadOnlyCounts } from "./link-candidates-db.js";

/** Decimal places for a threshold in a heading, so `0.8` renders as `0.80`. */
const THRESHOLD_DECIMALS = 2;

/** Decimal places for a cosine in a pair line, matching the core's own rows. */
const COSINE_DECIMALS = 4;

/** How many incremental pairs the inspection table shows before a reader goes to the JSON. */
const TOP_PAIRS_TABLE_SIZE = 50;

/** What the report calls itself, so a stored artifact cannot be mistaken for a change. */
const MODE_LINE = "report-only: this run read stored vectors and wrote nothing but this report";

/** One sentence describing the measurement, printed in both artifacts. */
const METHOD_LINE =
  "Each concept page's STORED page vector is used as the query for the query path's own " +
  "ranker (`rankChunksInSql`), with k equal to the stack's chunk count; the ranked rows are " +
  "then inverted to per-paragraph top-k concepts. Pairs whose concept title occurs in the " +
  "paragraph (word-bounded) are excluded as already reachable by a lexical channel; the " +
  "remainder is the incremental set, stratified by inclusive cosine lower bound.";

/** The four things a reader must know before quoting any number below. */
const CAVEATS: readonly string[] = [
  "Declared aliases do not exist in either real corpus (the live database has no `aliases` " +
    "column and `wiki.concept_aliases` is empty), so the lexical-exclusion filter ran against " +
    "**canonical titles only**; the alias branch is covered by a fixture test and nothing else.",
  "The 398-page stack has 43.2% dangling links (1617 of 2849 resolve). That is a property of " +
    "that corpus and a **separate population**: candidate counts here come from stored vectors " +
    "only and are unaffected by link soundness.",
  "No embeddings were computed and no provider was called; all vectors were read from storage.",
  "Precision at each threshold is unknown until a human marks the samples; this report carries " +
    "no automatic correctness claim.",
];

/** One threshold's numbers and lists, as the report carries them. */
export interface ThresholdReport {
  threshold: number;
  candidateCount: number;
  excludedByLexicalCount: number;
  incrementalCount: number;
  /** The whole incremental set at this threshold, in report order. */
  incremental: RenderedCandidatePair[];
  /** The bounded sample a human labels. */
  sample: RenderedCandidatePair[];
}

/** One corpus's section of the report. */
export interface CorpusReport {
  label: string;
  stackId: string;
  skipped: boolean;
  skipReason: string | null;
  counts: ReadOnlyCounts | null;
  rankingCalls: number;
  coverageComplete: boolean;
  shortfallConcepts: number;
  readOnly: { before: ReadOnlyCounts; after: ReadOnlyCounts; identical: boolean } | null;
  thresholds: ThresholdReport[];
}

/** The whole artifact. */
export interface LinkCandidateReport {
  /** What the run was asked for, so both artifacts are reproducible from them. */
  options: ReportOptions;
  corpora: CorpusReport[];
}

/** How the report is assembled: which strata, and which sample. */
export interface ReportOptions {
  thresholds: readonly number[];
  sampleSize: number;
  seed: number;
}

/**
 * Build one threshold's report from the core's stratum.
 *
 * @param stratum - The stratified candidates at this threshold.
 * @param options - Sample size and seed.
 * @returns That threshold's numbers, full list, and sample.
 */
function thresholdReport(stratum: StratumReport, options: ReportOptions): ThresholdReport {
  return {
    threshold: stratum.threshold,
    candidateCount: stratum.candidateCount,
    excludedByLexicalCount: stratum.excludedByLexicalCount,
    incrementalCount: stratum.incrementalCount,
    incremental: stratum.incremental,
    sample: sampleCandidates(stratum.incremental, options.sampleSize, options.seed),
  };
}

/**
 * Build one corpus's report. A skipped corpus has no strata: rendering an empty
 * table for it would read as "no candidates", which is a different claim.
 *
 * @param measurement - What the database layer read.
 * @param options - Which strata, and which sample.
 * @returns That corpus's report.
 */
function corpusReport(measurement: CorpusMeasurement, options: ReportOptions): CorpusReport {
  const strata = measurement.skipped
    ? []
    : stratifyCandidates(measurement.pairs, options.thresholds);
  return {
    label: measurement.spec.label,
    stackId: measurement.spec.stackId,
    skipped: measurement.skipped,
    skipReason: measurement.skipReason,
    counts: measurement.counts,
    rankingCalls: measurement.rankingCalls,
    coverageComplete: measurement.coverageComplete,
    shortfallConcepts: measurement.shortfallConcepts,
    readOnly: measurement.readOnly,
    thresholds: strata.map((stratum) => thresholdReport(stratum, options)),
  };
}

/**
 * Assemble the report from every measured corpus.
 *
 * @param measurements - One entry per corpus, in the order the caller named them.
 * @param options - Which strata, and which sample.
 * @returns The report both renderers consume.
 */
export function buildReport(
  measurements: readonly CorpusMeasurement[],
  options: ReportOptions,
): LinkCandidateReport {
  return { options, corpora: measurements.map((measurement) => corpusReport(measurement, options)) };
}

/**
 * Project a pair onto the fields S6 names, and nothing else.
 *
 * @param pair - A rendered candidate.
 * @returns The JSON shape of one pair.
 */
function jsonPair(pair: RenderedCandidatePair): Record<string, unknown> {
  return {
    corpus: pair.corpus,
    paragraphId: pair.paragraphId,
    documentId: pair.documentId,
    conceptId: pair.conceptId,
    conceptTitle: pair.conceptTitle,
    cosine: pair.cosine,
    documentMention: pair.documentMention,
    excerpt: pair.excerpt,
  };
}

/**
 * Render the complete, machine-readable artifact.
 *
 * @param report - The assembled report.
 * @returns JSON text, redacted, ending in one newline.
 */
export function renderReportJson(report: LinkCandidateReport): string {
  const corpora = report.corpora.map((corpus) => ({
    ...corpus,
    thresholds: corpus.thresholds.map((threshold) => ({
      ...threshold,
      incremental: threshold.incremental.map(jsonPair),
      // The empty verdict slot is the point of the sample: a human fills it in.
      sample: threshold.sample.map((pair) => ({ ...jsonPair(pair), verdict: "" })),
    })),
  }));
  const payload = {
    mode: MODE_LINE,
    method: METHOD_LINE,
    options: report.options,
    caveats: CAVEATS,
    corpora,
  };
  return redactSecrets(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Render a count as a fixed-width cosine.
 *
 * @param cosine - Any cosine.
 * @returns The cosine at {@link COSINE_DECIMALS} places.
 */
function formatCosine(cosine: number): string {
  return cosine.toFixed(COSINE_DECIMALS);
}

/**
 * Render one sampled pair as the line a human marks.
 *
 * @param pair - The sampled pair.
 * @param index - Its 1-based position in the sample.
 * @returns Two lines: the checkbox line and its excerpt.
 */
function renderSampleLine(pair: RenderedCandidatePair, index: number): string {
  const fields = [
    `cos=${formatCosine(pair.cosine)}`,
    `paragraph=${pair.paragraphId}`,
    `concept=${pair.conceptId}`,
    `documentMention=${pair.documentMention ? "yes" : "no"}`,
    "verdict=[ ]",
  ];
  return `- [ ] ${index}. ${fields.join(" ")}\n      excerpt: "${pair.excerpt}"`;
}

/**
 * Escape the one character that would break a markdown table cell.
 *
 * @param text - Cell text.
 * @returns The text with pipes escaped.
 */
function toCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/**
 * Render the count summary every corpus section opens with.
 *
 * @param corpus - One corpus's report.
 * @returns Markdown lines.
 */
function renderCorpusFacts(corpus: CorpusReport): string[] {
  if (corpus.counts === null) return ["_No row counts could be read for this corpus._"];
  const coverage = corpus.coverageComplete
    ? `complete: every concept ranked all ${corpus.counts.chunkEmbeddings} chunks`
    : `INCOMPLETE: ${corpus.shortfallConcepts} concept(s) ranked fewer rows than the stack has chunks`;
  const readOnly = corpus.readOnly === null
    ? "_no read-only proof: the corpus was not read_"
    : `identical before/after — pages ${corpus.readOnly.before.pages}/${corpus.readOnly.after.pages}, ` +
      `page_embeddings ${corpus.readOnly.before.pageEmbeddings}/${corpus.readOnly.after.pageEmbeddings}, ` +
      `chunk_embeddings ${corpus.readOnly.before.chunkEmbeddings}/${corpus.readOnly.after.chunkEmbeddings}`;
  return [
    `- pages ${corpus.counts.pages} · page embeddings ${corpus.counts.pageEmbeddings} · ` +
      `chunk embeddings ${corpus.counts.chunkEmbeddings} · ranking calls ${corpus.rankingCalls}`,
    `- coverage: ${coverage}`,
    `- read-only: ${readOnly}`,
  ];
}

/**
 * Render one corpus's counts table.
 *
 * @param corpus - One corpus's report.
 * @returns Markdown lines.
 */
function renderCountTable(corpus: CorpusReport): string[] {
  const rows = corpus.thresholds.map(
    (threshold) =>
      `| ${threshold.threshold.toFixed(THRESHOLD_DECIMALS)} | ${threshold.candidateCount} | ` +
      `${threshold.excludedByLexicalCount} | ${threshold.incrementalCount} |`,
  );
  return [
    "| threshold | candidates | excluded by lexical match | incremental |",
    "| --- | --- | --- | --- |",
    ...rows,
  ];
}

/**
 * Render the inspection table of the largest incremental pairs at one threshold.
 *
 * @param pairs - The incremental set at this threshold.
 * @returns Markdown lines, or none when the set is empty.
 */
function renderPairTable(pairs: readonly RenderedCandidatePair[]): string[] {
  if (pairs.length === 0) return [];
  const rows = pairs.slice(0, TOP_PAIRS_TABLE_SIZE).map(
    (pair) =>
      `| ${formatCosine(pair.cosine)} | ${toCell(pair.paragraphId)} | ${toCell(pair.conceptId)} | ` +
      `${pair.documentMention ? "yes" : "no"} | ${toCell(pair.excerpt)} |`,
  );
  return [
    `Top ${Math.min(pairs.length, TOP_PAIRS_TABLE_SIZE)} incremental pairs (the JSON carries all ${pairs.length}):`,
    "",
    "| cosine | paragraph | concept | document mention | excerpt |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ];
}

/**
 * Render one threshold's section, including the sample a human labels.
 *
 * @param threshold - That threshold's report.
 * @param seed - The seed the sample was drawn with, printed so it can be reproduced.
 * @returns Markdown lines.
 */
function renderThresholdSection(threshold: ThresholdReport, seed: number): string[] {
  const heading =
    `### threshold ${threshold.threshold.toFixed(THRESHOLD_DECIMALS)} — ` +
    `${threshold.candidateCount} candidates, ${threshold.excludedByLexicalCount} excluded by lexical ` +
    `match, ${threshold.incrementalCount} incremental`;
  if (threshold.incrementalCount === 0) {
    return [
      heading,
      "",
      "_No incremental pairs at this threshold: every candidate in the slice is already produced " +
        "by a lexical channel._",
    ];
  }
  return [
    heading,
    "",
    `Sample to label (${threshold.sample.length} of ${threshold.incrementalCount}, seed ${seed}):`,
    "",
    ...threshold.sample.map((pair, index) => renderSampleLine(pair, index + 1)),
    "",
    ...renderPairTable(threshold.incremental),
  ];
}

/**
 * Render one corpus's whole section.
 *
 * @param corpus - One corpus's report.
 * @param seed - The sample seed, printed per threshold.
 * @returns Markdown lines.
 */
function renderCorpusSection(corpus: CorpusReport, seed: number): string[] {
  const header = [`## corpus ${corpus.label} (\`${corpus.stackId}\`)`, ""];
  if (corpus.skipped) {
    // No added full stop: a driver or ranker reason already ends its own sentence,
    // and appending one produced `..` in the artifact.
    return [...header, `_Skipped: ${corpus.skipReason ?? "no reason recorded"}_`, ""];
  }
  return [
    ...header,
    ...renderCorpusFacts(corpus),
    "",
    ...renderCountTable(corpus),
    "",
    ...corpus.thresholds.flatMap((threshold) => [...renderThresholdSection(threshold, seed), ""]),
  ];
}

/**
 * Render the hand-labellable view.
 *
 * @param report - The assembled report.
 * @returns Markdown text, redacted, ending in one newline.
 */
export function renderReportMarkdown(report: LinkCandidateReport): string {
  const lines = [
    "# Semantic link candidates — report-only measurement",
    "",
    `**Mode.** ${MODE_LINE}`,
    "",
    `**Method.** ${METHOD_LINE}`,
    "",
    "## Caveats",
    "",
    ...CAVEATS.map((caveat) => `- ${caveat}`),
    "",
    ...report.corpora.flatMap((corpus) => renderCorpusSection(corpus, report.options.seed)),
  ];
  return redactSecrets(`${lines.join("\n").replace(/\n+$/u, "")}\n`);
}
