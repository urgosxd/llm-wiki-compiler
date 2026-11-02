/**
 * Shared non-default-profile summary block (profileId, digest, per-type entity
 * counts, problems).
 *
 * This is the single source of truth for the additive `profile` block that the
 * `status` collector and the viewer snapshot both surface. Centralizing it
 * keeps the two surfaces byte-identical to each other and prevents the gate
 * logic (built-in-default detection, count seeding, problem mapping) from
 * drifting between them.
 *
 * For the built-in default profile this returns `undefined` so each caller
 * omits the `profile` key entirely and its default envelope is unchanged. The
 * built-in is identified by `loadedFrom === null` (never by `profileId`), with
 * a digest cross-check as defense-in-depth against a future loader change.
 */

import { loadProfile } from "./load.js";
import { DEFAULT_PROFILE } from "./default.js";
import { profileDigest } from "./digest.js";
import { toEntityProblemView } from "./types.js";
import type { EntityProblem, EntityPage, EntityProblemView, EntityTypeDef, LoadedProfile } from "./types.js";
import { scanEntityDir } from "../wiki/collect.js";
import { safeRealpath } from "../utils/path-confine.js";
import { GraphDirConfinementError } from "../utils/jsonl-store.js";
import { PrivateDirConfinementError } from "../utils/private-dir.js";
import { readEvents } from "../events/store-read.js";
import { EventStoreCorruptError, EventStoreTooNewError, EventStoreSymlinkError, EventStoreFullError } from "../events/types.js";

/**
 * There is no longer such a thing as a non-default profile.
 *
 * This returned the installed profile, or `undefined` for the built-in default,
 * so that a dozen read surfaces could skip profile-only work on a plain project.
 * With one fixed profile every project IS the default, so the answer is always
 * `undefined` — and the signature stays, rather than being deleted, because the
 * callers' early-return branches are now the CORRECT and only behaviour: no typed
 * pages to list, no entity docs to export, no pipeline panel to draw.
 *
 * @param _root - Absolute project root directory (unused).
 * @returns Always `undefined`.
 */
export async function loadNonDefaultProfile(
  _root: string,
): Promise<LoadedProfile | undefined> {
  return undefined;
}

/** A profile pre-resolved by a caller: a {@link LoadedProfile}, or `null` for the built-in default. */
export type PreloadedProfile = LoadedProfile | null;


/**
 * The maximum number of structured `problems` the count-only status/viewer
 * summary surfaces inline. A profile with thousands of invalid pages is never
 * dumped wholesale into a status/viewer envelope; `problemTotal` always reports
 * the full count so the cap is visible. Export keeps the COMPLETE list (it is a
 * full snapshot), and `listPages` paginates instead of capping — only this
 * count-only summary applies the cap.
 */
const PROFILE_PROBLEM_CAP = 100;

/** The additive profile summary shared by the status and viewer surfaces. */
export interface ProfileSummaryBlock {
  profileId: string;
  digest: string;
  entityCounts: Record<string, number>;
  /**
   * Structured collector problems, CAPPED at {@link PROFILE_PROBLEM_CAP}.
   * Present ONLY when non-empty, so a non-default project with a bad directory
   * or page is never reported as silently healthy. Each problem's `path` is
   * project-relative (never absolute) and absent for directory-level problems.
   */
  problems?: EntityProblemView[];
  /**
   * Full count of collector problems (may exceed `problems.length` when capped).
   * Present ONLY when there is at least one problem.
   */
  problemTotal?: number;
  /**
   * Live relation counts per relation type, present ONLY for a non-default
   * profile whose `wiki/graph` store holds at least one relation. OMITTED for
   * the built-in default and for any relation-LESS profile, so the default and
   * relation-less status/viewer envelopes stay byte-identical. A corrupt /
   * too-new / symlinked-leaf store does NOT populate this — it surfaces through
   * `problems` instead (fail-closed, never a silent zero).
   */
  relationCounts?: Record<string, number>;
  /** Total live relation count; present alongside (and equal to the sum of) `relationCounts`. */
  relationTotal?: number;
  /**
   * Total events in the append-only hash-chained audit log, present ONLY for a
   * non-default profile whose `wiki/graph` store holds at least one event.
   * OMITTED for the built-in default and for any event-LESS profile, so the
   * default and event-less status/viewer envelopes stay byte-identical. A
   * corrupt / too-new / symlinked-leaf store OR a broken/truncated chain does
   * NOT populate this — it surfaces through `problems` instead (fail-closed,
   * never a silent count reported as healthy).
   */
  eventCount?: number;
  /**
   * Per-entity-type tally of the CURRENT lifecycle-field value across that
   * type's enrolled pages — e.g. `{ ideas: { proposed: 1, testing: 2 } }`.
   * Computed ONLY for entity types that declare a `lifecycle`, from the bounded
   * frontmatter-only scan (no page bodies are read). This is the at-a-glance
   * surface that makes a lifecycle TRANSITION visible to `status`/`wiki_status`:
   * a field-flip changes the per-state counts here, not just `eventCount`.
   *
   * OMITTED entirely when no entity type declares a lifecycle OR no lifecycle
   * page carries a value, so the built-in default and any lifecycle-less profile
   * produce byte-identical status/viewer envelopes. A type with a lifecycle but
   * no enrolled pages contributes no key.
   */
  lifecycleStates?: Record<string, Record<string, number>>;
}


/**
 * Map structured collector problems to public, path-safe problem views,
 * relativizing each `filePath` against the CANONICAL root. The collector
 * resolves every `filePath` through `safeRealpath`, so a non-canonical input
 * `root` (e.g. a `/var` path whose real form is `/private/var`) would otherwise
 * yield a misleading `../…` traversal instead of a clean project-relative path.
 */
async function toProblemViews(
  problems: EntityProblem[],
  root: string,
): Promise<EntityProblemView[]> {
  const canonicalRoot = (await safeRealpath(root)) ?? root;
  return problems.map((problem) => toEntityProblemView(problem, canonicalRoot));
}

/**
 * The event-store contribution to the summary block: the total event count
 * (present only for an intact, non-empty log) and at most one fail-closed read
 * or broken-chain problem. The two are mutually exclusive — a tamper signal
 * suppresses the count so a broken store is never reported as silently healthy.
 */
interface EventSummary {
  eventCount?: number;
  problem?: EntityProblemView;
}

/** Map a fail-closed event-store read error to an `event-store` problem view. */
function eventReadProblem(error: unknown): EntityProblemView {
  if (
    error instanceof EventStoreTooNewError ||
    error instanceof EventStoreCorruptError ||
    error instanceof EventStoreSymlinkError ||
    // DEFENSIVE: read maps an oversize store to EventStoreCorruptError, so read
    // never throws Full (Full is write-side only); kept for the defensive mapping.
    error instanceof EventStoreFullError ||
    error instanceof GraphDirConfinementError || // a symlinked/escaping wiki/graph DIR (FIX F5)
    error instanceof PrivateDirConfinementError // a symlinked/escaping .llmwiki dir (B5)
  ) {
    return { kind: "event-store", message: error.message };
  }
  throw error; // a non-store error (e.g. a confinement escape) is not ours to swallow
}

/** The torn-trailing-line prefix {@link readEvents} tags; any OTHER problem is a chain/anchor tamper signal. */
const TORN_EVENT_PREFIX = "tolerated torn trailing line";

/**
 * Reduce a successful (non-throwing) {@link readEvents} result to the summary
 * contribution. A chain-link break or head-anchor (truncation) mismatch is a
 * tamper signal: surface it as an `event-store` problem and SUPPRESS the count
 * (never report a broken chain as a healthy total). A torn trailing line is
 * tolerated — the valid events before it are still counted.
 */
function summarizeReadEvents(read: { events: { length: number }; problems: string[] }): EventSummary {
  const tamper = read.problems.find((p) => !p.startsWith(TORN_EVENT_PREFIX));
  if (tamper !== undefined) return { problem: { kind: "event-store", message: tamper } };
  if (read.events.length === 0) return {};
  return { eventCount: read.events.length };
}

/**
 * Read the hash-chained event store for a non-default profile and reduce it to
 * the additive summary contribution: the total event count (OMITTED for an
 * event-LESS store, so an event-less project's envelope stays byte-identical),
 * and a single `event-store` problem on a fail-closed read (corrupt / too-new /
 * symlink) OR a broken/truncated chain — in which case the count is suppressed
 * rather than reported as a healthy total.
 *
 * @param root - Absolute project root directory.
 * @returns The event count and/or a problem.
 */
async function summarizeEvents(root: string): Promise<EventSummary> {
  let read;
  try {
    read = await readEvents(root);
  } catch (error) {
    return { problem: eventReadProblem(error) };
  }
  return summarizeReadEvents(read);
}

/**
 * Tally one lifecycle-declaring entity type's CURRENT lifecycle-field value
 * across its pages via the bounded frontmatter-only scan
 * (`scanEntityDir(..., { includeBody: false })`) — page bodies are never read.
 * Only string values are counted (a declared lifecycle state is always a
 * string); a page that omits the field or carries a non-string is skipped.
 *
 * @returns The `{ state: count }` map, or `undefined` when no page carries a
 *   string value (so the caller omits this type's key).
 */
async function tallyLifecycleStates(
  root: string,
  def: EntityTypeDef,
  field: string,
): Promise<Record<string, number> | undefined> {
  const { scans } = await scanEntityDir(root, def.directory, { includeBody: false });
  const counts: Record<string, number> = {};
  for (const scan of scans) {
    const value = scan.frontmatter[field];
    if (typeof value === "string") counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}


/**
 * Resolve the active profile and, for a NON-DEFAULT profile only, build the
 * shared summary block (profileId, digest, per-type entity counts, problems).
 *
 * Uses the COUNT-ONLY {@link collectEntitySummary} so the status/viewer surfaces
 * never build or retain content `EntityPage`s (with bodies) just to tally — the
 * counts and structured problems are identical to the content path, which shares
 * the same per-scan validation. Problems are CAPPED at {@link PROFILE_PROBLEM_CAP}
 * (with `problemTotal` reporting the full count) so a hugely invalid profile is
 * never dumped wholesale into a status/viewer envelope.
 *
 * @param root - Absolute project root directory.
 * @returns The summary block for a non-default profile, or `undefined` for the
 *   built-in default so the caller omits the `profile` key entirely.
 */
/**
 * Combine the three problem classes into ONE list, HIGH-SEVERITY FIRST: store-
 * integrity, then standing lifecycle-precondition drift, then the (unbounded, low-
 * severity) per-entity field problems. Ordering is load-bearing because the list
 * is CAPPED ({@link PROFILE_PROBLEM_CAP}) before it reaches the status/viewer/
 * context surfaces (and the context pack derives its standing warnings from the
 * capped array): a project with ≥cap routine entity problems must NOT starve the
 * rare store/standing signals out of the cap and read as silently healthy. Leading
 * with the high-severity classes guarantees they survive the cap.
 */
function orderProblemViews(
  entity: EntityProblemView[],
  store: EntityProblemView[],
): EntityProblemView[] {
  // The `standing` group was removed with the relation system: it held the
  // lifecycle/relation-precondition drift problems, which no longer exist.
  return [...store, ...entity];
}

/** Shape the combined problem views into the capped `problems`/`problemTotal` pair (omitted when empty). */
function problemEnvelope(views: EntityProblemView[]): Pick<ProfileSummaryBlock, "problems" | "problemTotal"> {
  if (views.length === 0) return {};
  return { problems: views.slice(0, PROFILE_PROBLEM_CAP), problemTotal: views.length };
}

