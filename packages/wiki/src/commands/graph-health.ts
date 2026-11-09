/**
 * @file `llmwiki graph-health` — is the compiled link graph navigable?
 *
 * Stages 4 and 5 connect concepts, and nothing measured whether the result can be WALKED.
 * This verb reports the shortest-path depth distribution over ordered pairs of articles
 * and the number of pairs with no route at all, which is the pair of numbers that can be
 * gamed only by making the graph genuinely more connected — a single "average hops" figure
 * can be moved by over-linking one hub.
 *
 * READ-ONLY and provider-free, like `links-here` and `race`: it reads the same graph the
 * viewer serves (`buildViewerSnapshot`), writes nothing, takes no lock and calls no model.
 *
 * EXIT CODES (documented in the CLI help, because a caller branches on them):
 *   0 — measured (including a wiki with no pages: an empty wiki is an answer, not a failure)
 *   2 — the request itself is unusable (`--pairs` is not a non-negative integer)
 *
 * The measurement is bounded and says so: the sampled-pair cap, the total pair count, the
 * number of pairs actually walked and the hop bound each route search used all travel in
 * the output, so a sampled answer is never mistaken for a complete one (S12).
 */

import { buildViewerSnapshot } from "../viewer/snapshot.js";
import {
  analyzeGraphHealth,
  describeGraphHealth,
  resolveGraphHealthPairCap,
  type GraphHealthReport,
} from "../context/graph-health.js";

/** Versioned JSON envelope, incremented independently of other commands. */
const GRAPH_HEALTH_JSON_VERSION = 1;

/** Exit code when a measurement was produced. */
const EXIT_MEASURED = 0;

/** Exit code when the request is unusable (`--pairs` not a non-negative integer). */
const EXIT_INVALID_REQUEST = 2;

/** CLI options for `llmwiki graph-health`. */
export interface GraphHealthOptions {
  /** Emit the stable JSON envelope instead of the human report. */
  json?: boolean;
  /** Sampled-pair cap; commander hands it over as a string. */
  pairs?: number | string;
}

/**
 * Build the stable `--json` envelope.
 *
 * Every field of the report is present in BOTH the complete and the truncated case: a
 * consumer that has to test for a missing key instead of reading the value is a consumer
 * that will get it wrong.
 *
 * @param report - The measurement.
 * @returns The envelope object to serialise.
 */
function buildJsonPayload(report: GraphHealthReport): Record<string, unknown> {
  return {
    version: GRAPH_HEALTH_JSON_VERSION,
    pages: report.pages,
    pairCap: report.pairCap,
    totalPairs: report.totalPairs,
    consideredPairs: report.consideredPairs,
    truncated: report.truncated,
    maxDepth: report.maxDepth,
    reachablePairs: report.reachablePairs,
    unreachablePairs: report.unreachablePairs,
    deepestReachable: report.deepestReachable,
    meanDepth: report.meanDepth,
    depthHistogram: report.depthHistogram,
    observation: report.observation,
  };
}

/**
 * Measure the project in the current working directory.
 *
 * @param root - Project root.
 * @param pairCap - The sampled-pair cap to use.
 * @returns The measurement.
 */
async function measure(root: string, pairCap: number): Promise<GraphHealthReport> {
  const snapshot = await buildViewerSnapshot(root);
  return analyzeGraphHealth(snapshot.graph, { pairCap });
}

/**
 * Run `llmwiki graph-health`.
 * @param options - `--json` switches to the stable envelope; `--pairs` sets the sample cap.
 * @returns Process exit code: 0 when measured, 2 when `--pairs` is unusable.
 */
export default async function graphHealthCommand(
  options: GraphHealthOptions = {},
): Promise<number> {
  let pairCap: number;
  try {
    // Resolved BEFORE the graph is read: an unusable request should cost nothing.
    pairCap = resolveGraphHealthPairCap(options.pairs);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return EXIT_INVALID_REQUEST;
  }
  const report = await measure(process.cwd(), pairCap);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(buildJsonPayload(report), null, 2)}\n`);
  } else {
    process.stdout.write(`${describeGraphHealth(report)}\n`);
  }
  return EXIT_MEASURED;
}
