/**
 * @file scripts/measure-semantic-link-candidates.ts
 * @description The command: it parses argv, wires the read-only database session to
 * the report assembly, writes the two artifacts, and decides the exit code.
 *
 * ## Why this file holds no measurement logic
 *
 * Everything that decides a number lives in `link-candidates-db.ts` (what the
 * database holds, and how the ranking is inverted) or in the store-independent core
 * (`link-candidates.ts`: lexical exclusion, stratification, sampling) and the report
 * module (assembly, rendering). A shell that also reasoned about cosines would make
 * the unit tests the only place that logic is not duplicated by a second, live path.
 *
 * ## Why the defaults are imported rather than written here
 *
 * `--sample` defaults to `DEFAULT_SAMPLE_SIZE` and the threshold set defaults to
 * `CANDIDATE_THRESHOLDS`, both from the core. Re-declaring `20` or
 * `[0.86, 0.8, 0.75]` here would let the command and the tests drift onto different
 * strata without any test failing, and a report whose sampling contract is not the
 * one the tests pin is a report nobody can compare across runs.
 *
 * ## Exit codes
 *
 * `0` the run finished (including a corpus it had to skip: "say so for that corpus
 * and skip it" is not a failure), `1` something failed at run time, `2` the caller's
 * arguments were wrong. `process.exitCode` is assigned and never `process.exit()`:
 * the driver's pool is still draining, and a hard exit would truncate the report.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { EMBEDDING_TOP_K } from "../packages/wiki/src/utils/constants.js";
import { CANDIDATE_THRESHOLDS, DEFAULT_SAMPLE_SEED, DEFAULT_SAMPLE_SIZE } from "./link-candidates.js";
import {
  measureCorpus,
  openReadOnlySession,
  redactSecrets,
  resolveDatabaseUrl,
  type CorpusMeasurement,
  type CorpusSpec,
} from "./link-candidates-db.js";
import {
  buildReport,
  renderReportJson,
  renderReportMarkdown,
  type CorpusReport,
  type LinkCandidateReport,
  type ThresholdReport,
} from "./link-candidates-report.js";

/** Where the artifacts land when the caller names no path. */
const DEFAULT_OUTPUT_DIRECTORY = ".llmwiki/link-candidates";

/** The two artifact file names inside the output directory. */
const JSON_FILE_NAME = "report.json";
const MARKDOWN_FILE_NAME = "report.md";

/** The `--corpus` prefix that means "a Postgres stack", the only source this command reads. */
const DB_CORPUS_PREFIX = "db:";

/** Exit statuses, named so a reader does not have to decode integers. */
const EXIT_SUCCESS = 0;
const EXIT_RUNTIME_FAILURE = 1;
const EXIT_USAGE_ERROR = 2;

/** Decimal places a threshold is validated and reported at, matching the core's strata. */
const THRESHOLD_DECIMALS = 2;

/** What the caller asked for, after validation. */
interface CliRequest {
  corpora: CorpusSpec[];
  outputDirectory: string;
  topK: number;
  sampleSize: number;
  seed: number;
  thresholds: number[];
}

/** A malformed invocation: the caller's mistake, reported with the usage text. */
class UsageError extends Error {}

/** The usage text, kept beside the parser so the two cannot disagree. */
const USAGE = [
  "usage: node --import tsx scripts/measure-semantic-link-candidates.ts \\",
  "         --corpus db:<stackId>:<label> [--corpus db:<stackId>:<label> ...] \\",
  `         [--out ${DEFAULT_OUTPUT_DIRECTORY}] [--top-k ${EMBEDDING_TOP_K}] \\`,
  `         [--sample ${DEFAULT_SAMPLE_SIZE}] [--seed ${DEFAULT_SAMPLE_SEED}] \\`,
  `         [--thresholds ${CANDIDATE_THRESHOLDS.join(",")}]`,
].join("\n");

/**
 * Read a whole number option, rejecting anything that is not one.
 *
 * @param raw - The value as written, or undefined when the option was omitted.
 * @param fallback - The value to use when it was omitted.
 * @param name - The option name, for the error message.
 * @returns The parsed integer.
 */
function numericOption(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new UsageError(`${name} must be a whole number, got "${raw}"`);
  return parsed;
}

/**
 * Parse the comma-separated threshold list, or fall back to the core's strata.
 *
 * @param raw - The value as written, or undefined when the option was omitted.
 * @returns Thresholds, highest first, without duplicates.
 */
function thresholdOption(raw: string | undefined): number[] {
  if (raw === undefined) return [...CANDIDATE_THRESHOLDS];
  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
  if (parsed.length === 0) throw new UsageError(`--thresholds needs at least one number, got "${raw}"`);
  return [...new Set(parsed)].sort((left, right) => right - left);
}

/**
 * Parse one `db:<stackId>:<label>` corpus argument.
 *
 * The label is everything after the stack id, so a label may itself contain a colon.
 *
 * @param raw - The argument as written.
 * @returns The stack and the label it is reported under.
 */
function corpusOption(raw: string): CorpusSpec {
  const body = raw.startsWith(DB_CORPUS_PREFIX) ? raw.slice(DB_CORPUS_PREFIX.length) : "";
  const [stackId = "", ...labelParts] = body.split(":");
  const label = labelParts.join(":");
  if (stackId.trim() === "" || label.trim() === "") {
    throw new UsageError(`--corpus must be ${DB_CORPUS_PREFIX}<stackId>:<label>, got "${raw}"`);
  }
  return { stackId: stackId.trim(), label: label.trim() };
}

/**
 * Read the raw option values, turning the driver's own complaint into a usage error.
 *
 * @param argv - Arguments after the script name.
 * @returns The parsed values, each still unvalidated.
 * @throws {UsageError} when an option is unknown or is missing its value.
 */
function readOptionValues(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        corpus: { type: "string", multiple: true },
        out: { type: "string" },
        "top-k": { type: "string" },
        sample: { type: "string" },
        seed: { type: "string" },
        thresholds: { type: "string" },
      },
    }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Turn argv into a validated request.
 *
 * @param argv - Arguments after the script name.
 * @returns The request.
 * @throws {UsageError} when the caller's arguments cannot be honoured.
 */
function parseRequest(argv: readonly string[]): CliRequest {
  const values = readOptionValues(argv);
  const rawCorpora = values.corpus ?? [];
  if (rawCorpora.length === 0) throw new UsageError("at least one --corpus is required");
  return {
    corpora: rawCorpora.map(corpusOption),
    outputDirectory: values.out ?? DEFAULT_OUTPUT_DIRECTORY,
    topK: numericOption(values["top-k"], EMBEDDING_TOP_K, "--top-k"),
    sampleSize: numericOption(values.sample, DEFAULT_SAMPLE_SIZE, "--sample"),
    seed: numericOption(values.seed, DEFAULT_SAMPLE_SEED, "--seed"),
    thresholds: thresholdOption(values.thresholds),
  };
}

/**
 * Whether a skipped corpus was skipped because it stores no vectors at all.
 *
 * The two skips mean different things — "there is nothing to measure" versus "the
 * database declined to rank what it has" — and only the first is what the brief calls
 * an empty corpus, so the caller must be able to tell them apart on stderr.
 *
 * @param measurement - A corpus that was skipped.
 * @returns True when the stack holds no page or no chunk embeddings.
 */
function isEmptyCorpus(measurement: CorpusMeasurement): boolean {
  const counts = measurement.counts;
  if (counts === null) return true;
  return counts.pageEmbeddings === 0 || counts.chunkEmbeddings === 0;
}

/**
 * Announce a skipped corpus on stderr, without letting it fail the run.
 *
 * @param measurement - A corpus that was skipped.
 */
function reportSkip(measurement: CorpusMeasurement): void {
  const kind = isEmptyCorpus(measurement) ? "EMPTY CORPUS" : "SKIPPED CORPUS";
  console.error(redactSecrets(`${kind} ${measurement.spec.label}: ${measurement.skipReason ?? "no reason"}`));
}

/**
 * Measure every corpus the caller named, closing the session even on failure.
 *
 * @param request - The validated request.
 * @returns One measurement per corpus, in the order they were named.
 */
async function measureAll(request: CliRequest): Promise<CorpusMeasurement[]> {
  const session = await openReadOnlySession(resolveDatabaseUrl());
  try {
    const measurements: CorpusMeasurement[] = [];
    for (const spec of request.corpora) {
      measurements.push(await measureCorpus(session.db, spec, request.topK));
    }
    return measurements;
  } finally {
    await session.close();
  }
}

/**
 * Describe a corpus's row counts in one clause.
 *
 * @param counts - The counts read, or null when nothing could be read.
 * @returns The clause.
 */
function countsSummary(counts: CorpusReport["counts"]): string {
  if (counts === null) return "no row counts";
  return `${counts.pages} pages, ${counts.pageEmbeddings} page vectors, ${counts.chunkEmbeddings} chunks`;
}

/**
 * Describe whether every concept ranked the whole chunk set.
 *
 * @param corpus - One corpus's report.
 * @returns The clause.
 */
function coverageSummary(corpus: CorpusReport): string {
  return corpus.coverageComplete
    ? "coverage complete"
    : `coverage INCOMPLETE (${corpus.shortfallConcepts} concept(s) short)`;
}

/**
 * Describe one measured corpus on a single line.
 *
 * @param corpus - One corpus's report.
 * @returns The line.
 */
function corpusSummary(corpus: CorpusReport): string {
  const rowCounts = countsSummary(corpus.counts);
  return (
    `${corpus.label} (${corpus.stackId}): ${rowCounts}, ${corpus.rankingCalls} ranking calls, ` +
    `${coverageSummary(corpus)}, read-only identical ${corpus.readOnly?.identical === true}`
  );
}

/**
 * Describe one threshold's three counts on a single indented line.
 *
 * @param threshold - That threshold's report.
 * @returns The line.
 */
function thresholdSummary(threshold: ThresholdReport): string {
  return (
    `  threshold ${threshold.threshold.toFixed(THRESHOLD_DECIMALS)}: ` +
    `candidates ${threshold.candidateCount}, excluded by lexical ${threshold.excludedByLexicalCount}, ` +
    `incremental ${threshold.incrementalCount}`
  );
}

/**
 * Describe one corpus, whether it was measured or skipped.
 *
 * @param corpus - One corpus's report.
 * @returns The line.
 */
function corpusLine(corpus: CorpusReport): string {
  return corpus.skipped
    ? `SKIPPED ${corpus.label}: ${corpus.skipReason ?? "no reason"}`
    : corpusSummary(corpus);
}

/**
 * Print the per-corpus, per-threshold counts a reader wants before opening a file.
 *
 * @param report - The assembled report.
 */
function printSummary(report: LinkCandidateReport): void {
  for (const corpus of report.corpora) {
    console.log(corpusLine(corpus));
    for (const threshold of corpus.thresholds) console.log(thresholdSummary(threshold));
  }
}

/**
 * Write both artifacts and print where they went.
 *
 * @param report - The assembled report.
 * @param outputDirectory - Where the caller wants them.
 */
async function writeArtifacts(report: LinkCandidateReport, outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, JSON_FILE_NAME);
  const markdownPath = path.join(outputDirectory, MARKDOWN_FILE_NAME);
  await writeFile(jsonPath, renderReportJson(report), "utf8");
  await writeFile(markdownPath, renderReportMarkdown(report), "utf8");
  console.log(`report: ${jsonPath}`);
  console.log(`report: ${markdownPath}`);
}

/**
 * Run the command and decide its exit status.
 *
 * @param argv - Arguments after the script name.
 * @returns The exit status.
 */
async function main(argv: readonly string[]): Promise<number> {
  let request: CliRequest;
  try {
    request = parseRequest(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(redactSecrets(`usage error: ${error.message}`));
    console.error(USAGE);
    return EXIT_USAGE_ERROR;
  }
  const measurements = await measureAll(request);
  const skipped = measurements.filter((measurement) => measurement.skipped);
  for (const measurement of skipped) reportSkip(measurement);
  const report = buildReport(measurements, {
    thresholds: request.thresholds,
    sampleSize: request.sampleSize,
    seed: request.seed,
  });
  printSummary(report);
  await writeArtifacts(report, request.outputDirectory);
  return EXIT_SUCCESS;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(redactSecrets(`measurement failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = EXIT_RUNTIME_FAILURE;
  });
