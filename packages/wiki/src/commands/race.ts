/**
 * @file `llmwiki race <from> <to>` — wiki-race navigation across the link graph.
 *
 * The compiled wiki is a graph, and a graph is only navigable if you can ask it
 * for a route. This command answers "can I get from A to B by following links,
 * and by which route?". It is the mechanic behind the wiki-race game, and it is
 * the reason the traversal has to be deterministic rather than merely correct.
 *
 * READ-ONLY and provider-free, like `links-here`: it reads the same graph the
 * viewer serves (`buildViewerSnapshot`), writes nothing, takes no lock and calls
 * no LLM, so the terminal answer and the interactive graph can never disagree.
 *
 * EXIT CODES (documented in the CLI help, because a caller branches on them):
 *   0 — a route was found (including the zero-hop A → A route)
 *   1 — the target is unreachable; the reason, including the depth bound when
 *       that is what stopped the search, is written to stderr
 *   2 — the request itself is invalid (unknown page, unusable `--max-depth`)
 *
 * The depth bound is never silent (S12): the effective bound, the requested
 * value, and whether the bound is what ended the search all travel in the reply.
 */

import { buildViewerSnapshot } from "../viewer/snapshot.js";
import {
  DEFAULT_RACE_MAX_DEPTH,
  RACE_MAX_DEPTH_CEILING,
  findRacePath,
  resolveRaceEndpoint,
  resolveRaceMaxDepth,
  type RaceFailureReason,
} from "../context/race-path.js";
import type { GraphNodeId } from "../viewer/types.js";

/** Versioned JSON envelope, incremented independently of other commands. */
const RACE_JSON_VERSION = 1;

/** Exit code when a route exists. */
const EXIT_ROUTE_FOUND = 0;
/** Exit code when the target cannot be reached. */
const EXIT_UNREACHABLE = 1;
/** Exit code when the request is unusable (unknown page, bad `--max-depth`). */
const EXIT_INVALID_REQUEST = 2;

/** CLI options for `llmwiki race`. */
export interface RaceCommandOptions {
  /** Hop budget; commander hands it over as a string. */
  maxDepth?: number | string;
  /** Emit the stable JSON envelope instead of the human route. */
  json?: boolean;
}

/** Reason reported in the envelope, including the pre-traversal rejection. */
type EnvelopeReason = RaceFailureReason | "unknown-page";

/**
 * Coerce the CLI-provided `--max-depth` into a number the traversal can
 * validate. A non-numeric string becomes `NaN` on purpose so the single
 * validator in `race-path.ts` is the only place that decides what is valid.
 */
function coerceMaxDepth(raw: number | string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return typeof raw === "number" ? raw : Number(raw);
}

/** Render the found route: one arrow-prefixed page id per line, plus the hops. */
function renderRoute(
  from: GraphNodeId,
  to: GraphNodeId,
  reply: RaceReply,
  notice: string | null,
): string {
  const header = `${reply.hops} hop(s) from ${from} to ${to} within --max-depth ${reply.maxDepth}`;
  const steps = reply.route.map((id) => `  → ${id}`);
  const clamped = notice === null ? [] : ["", notice];
  return [header, "", ...steps, ...clamped, ""].join("\n");
}

/**
 * State that a clamp actually happened. Without this line a caller who asked for
 * `--max-depth 50` would silently be given 20, which S12 forbids.
 */
function clampNotice(requestedMaxDepth: number | null, effective: number): string | null {
  if (requestedMaxDepth === null || requestedMaxDepth === effective) return null;
  return `(requested --max-depth ${requestedMaxDepth}, clamped to ${effective})`;
}

/**
 * The one sentence that explains an unsuccessful race, bound named explicitly.
 *
 * Resolved ids are used whenever they exist, so stderr names the same pages the
 * successful route would have named; only an unresolvable endpoint falls back to
 * the string the caller typed.
 */
function describeFailure(reply: RaceReply): string | null {
  if (reply.reason === null) return null;
  const from = reply.endpoints.from ?? reply.requested.from;
  const to = reply.endpoints.to ?? reply.requested.to;
  if (reply.reason === "unknown-page") {
    const missing = reply.endpoints.from === null ? from : to;
    return `No page named "${missing}" exists in this wiki.`;
  }
  if (reply.reason === "depth-bound") {
    return `No route from ${from} to ${to} within --max-depth ${reply.maxDepth}: ` +
      "the depth bound stopped the search before the target was reached " +
      `(raise --max-depth, maximum ${RACE_MAX_DEPTH_CEILING}, to keep looking).`;
  }
  return `No route from ${from} to ${to}: no link path connects them ` +
    `(the search completed within --max-depth ${reply.maxDepth}).`;
}

/** Everything both reply paths need; grouped so the renderers stay short. */
interface RaceReply {
  requested: { from: string; to: string };
  /** Resolved ids, or `null` when a name matched no page. */
  endpoints: { from: GraphNodeId | null; to: GraphNodeId | null };
  maxDepth: number;
  requestedMaxDepth: number | null;
  found: boolean;
  route: GraphNodeId[];
  hops: number;
  depthBoundReached: boolean;
  reason: EnvelopeReason | null;
  json: boolean;
}

/** Build the stable JSON envelope for agent consumption. */
function buildEnvelope(reply: RaceReply) {
  return {
    version: RACE_JSON_VERSION,
    requested: reply.requested,
    from: reply.endpoints.from,
    to: reply.endpoints.to,
    resolved: reply.endpoints.from !== null && reply.endpoints.to !== null,
    found: reply.found,
    route: reply.route,
    hops: reply.hops,
    maxDepth: reply.maxDepth,
    requestedMaxDepth: reply.requestedMaxDepth,
    depthBoundReached: reply.depthBoundReached,
    reason: reply.reason,
  };
}

/**
 * Present one reply. A found route goes to stdout as an arrow list (or the
 * envelope); a failed one goes to stderr, so no partial route can be mistaken
 * for an answer. The reason also goes to stderr in `--json` mode, where the
 * envelope carries it as a field.
 */
function present(reply: RaceReply): void {
  if (reply.json) {
    process.stdout.write(`${JSON.stringify(buildEnvelope(reply), null, 2)}\n`);
  } else if (reply.found && reply.endpoints.from !== null && reply.endpoints.to !== null) {
    const notice = clampNotice(reply.requestedMaxDepth, reply.maxDepth);
    process.stdout.write(renderRoute(reply.endpoints.from, reply.endpoints.to, reply, notice));
  }
  const failure = describeFailure(reply);
  if (failure !== null) process.stderr.write(`${failure}\n`);
}

/** Reject a request that never reached the graph: exit 2, reason on stderr. */
function reject(reply: RaceReply): number {
  present(reply);
  return EXIT_INVALID_REQUEST;
}

/**
 * Run `llmwiki race <from> <to>`.
 * @param from - Namespaced page id (`concepts/foo`) or a bare slug (`foo`).
 * @param to - Namespaced page id or bare slug of the destination.
 * @param options - `--max-depth` hop budget and `--json` envelope switch.
 * @returns Process exit code: 0 found, 1 unreachable, 2 invalid request.
 */
export default async function raceCommand(
  from: string,
  to: string,
  options: RaceCommandOptions = {},
): Promise<number> {
  const requestedMaxDepth = coerceMaxDepth(options.maxDepth) ?? null;
  const json = options.json === true;
  let maxDepth: number;
  try {
    maxDepth = resolveRaceMaxDepth(requestedMaxDepth ?? undefined);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_INVALID_REQUEST;
  }
  const snapshot = await buildViewerSnapshot(process.cwd());
  const fromId = resolveRaceEndpoint(snapshot.graph, from);
  const toId = resolveRaceEndpoint(snapshot.graph, to);
  const base: RaceReply = {
    requested: { from, to },
    endpoints: { from: fromId, to: toId },
    maxDepth,
    requestedMaxDepth,
    found: false,
    route: [],
    hops: 0,
    depthBoundReached: false,
    reason: null,
    json,
  };
  if (fromId === null || toId === null) {
    return reject({ ...base, reason: "unknown-page" });
  }
  const result = findRacePath(snapshot.graph, { from: fromId, to: toId, maxDepth });
  present({
    ...base,
    found: result.found,
    route: result.route,
    hops: result.hops,
    depthBoundReached: result.depthBoundReached,
    reason: result.reason,
  });
  return result.found ? EXIT_ROUTE_FOUND : EXIT_UNREACHABLE;
}

/** The named default, re-exported so the CLI help text cannot drift from it. */
export { DEFAULT_RACE_MAX_DEPTH, RACE_MAX_DEPTH_CEILING };
