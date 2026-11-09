/**
 * Read-only project-status collector shared by the MCP `wiki_status` tool and the in-process SDK.
 *
 * Derives stale/orphaned page classification from the freshness module so
 * agents get source-level accuracy rather than frontmatter-only orphans.
 * Uses `readStateClassified` throughout — never `readState` — so corrupt
 * state.json never produces a `.bak` side-effect.
 *
 * `pendingChanges` is derived directly from the freshness snapshot (which
 * already has per-source currentHash/recordedHash/exists) plus a cheap
 * selected-file listing — no second hash pass. `detectChanges` is NOT called.
 */

import path from "path";
import { listSelectedSourceFiles } from "../sources/scan.js";
import { collectPageSummaries, scanWikiPages } from "../compiler/indexgen.js";
import {
  summarizeScanned,
  type PageScanSource,
} from "../dimensions/wiki/page-scan-source.js";
import { countCandidates } from "../compiler/candidates.js";
import { isPlainObject } from "../utils/state.js";
import { readStateClassifiedFor } from "../dimensions/wiki/page-source-seam.js";
import type { StateStatus } from "../utils/state.js";
import { buildProjectFreshnessSnapshot, computeFreshness } from "../freshness/index.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { journalHealthWarning } from "../trust/journal-health-warning.js";
import type { ReadSurfaceWarning } from "../trust/journal-health-warning.js";
import { pendingEmbeddingsWarning } from "../trust/pending-embeddings-warning.js";
import { quarantinedEmbeddingsWarning } from "../trust/quarantined-embeddings-warning.js";
import type { FreshnessSnapshot } from "../freshness/types.js";
import type { EntityProblemView } from "../profile/types.js";

/**
 * Maximum number of items returned in each agent-facing list (stalePages,
 * orphanedPages, pendingChanges). Bounds the MCP response size and agent
 * context consumption on large wikis. True totals are in the matching *Count fields.
 */
export const MAX_STATUS_LIST = 100;

/** Shape returned by `collectStatus` and surfaced by the `wiki_status` tool. */
export interface WikiStatus {
  pages: { concepts: number; queries: number; total: number };
  sources: number;
  lastCompiledAt: string | null;
  /**
   * Concept slugs whose source changed or partially disappeared since compile.
   * Capped at MAX_STATUS_LIST (sorted ascending); see staleCount for the true total.
   */
  stalePages: string[];
  /** True total of stale pages (may exceed stalePages.length when capped). */
  staleCount: number;
  /**
   * Concept slugs whose every owning source was deleted, or frontmatter-flagged orphaned.
   * Capped at MAX_STATUS_LIST (sorted ascending); see orphanedCount for the true total.
   */
  orphanedPages: string[];
  /** True total of orphaned pages (may exceed orphanedPages.length when capped). */
  orphanedCount: number;
  /**
   * Readability of .llmwiki/state.json — surfaced so corrupt OR too-new state
   * (written by a newer llmwiki) is never silently reported as healthy.
   */
  stateStatus: StateStatus;
  /** Number of compile candidates awaiting human review. */
  pendingCandidates: number;
  /**
   * Source files with changes since last compile (new/changed/deleted).
   * Capped at MAX_STATUS_LIST (sorted by file); see pendingChangesCount for the true total.
   */
  pendingChanges: Array<{ file: string; status: string }>;
  /** True total of pending changes (may exceed pendingChanges.length when capped). */
  pendingChangesCount: number;
  /**
   * Read-surface health warnings carried alongside the status payload. ABSENT
   * (key omitted) for a healthy project, so a clean status envelope is
   * byte-identical (parity-safe); present ONLY when the journal is `pending`
   * (`incomplete-compile`) or `unavailable` (`journal-unavailable`), or when an
   * embeddings refresh is pending, quarantined, or its retry marker is unreadable, so partial
   * post-crash / tampered state OR a skipped embeddings update is never reported as
   * silently healthy. Mirrors the journal-warning surfacing on viewer/export/context.
   */
  warnings?: ReadSurfaceWarning[];
}

/** Classify scanned concept pages into stale/orphaned arrays using the freshness snapshot. */
function classifyConceptPages(
  scanned: { slug: string; meta: Record<string, unknown> }[],
  snapshot: FreshnessSnapshot,
): { stalePages: string[]; orphanedPages: string[] } {
  const stalePages: string[] = [];
  const orphanedPages: string[] = [];
  for (const { slug, meta } of scanned) {
    const { freshnessStatus } = computeFreshness(
      { slug, pageDirectory: "concepts", frontmatter: meta },
      snapshot,
    );
    if (freshnessStatus === "stale") stalePages.push(slug);
    else if (freshnessStatus === "orphaned") orphanedPages.push(slug);
  }
  return { stalePages, orphanedPages };
}

/**
 * Derive the last compile time from state sources, or null if no sources.
 * Belt-and-suspenders: a non-plain-object `sources` (e.g. a too-new state with
 * no v1-shaped map) is coerced to `{}` so no caller can crash this read.
 */
function lastCompileTime(sources: Record<string, { compiledAt: string }>): string | null {
  const safe = isPlainObject(sources) ? sources : {};
  const times = Object.values(safe).map((s) => s.compiledAt);
  return times.length > 0 ? times.sort().slice(-1)[0] : null;
}

/**
 * Derive pending source changes (new/changed/deleted) from the freshness snapshot — no extra hashing.
 * The snapshot already contains recordedHash, currentHash, and exists for each tracked source,
 * The selected-file listing also detects retirement after a selection change,
 * even when the original source remains on disk with an unchanged hash.
 */
function pendingChangesFromSnapshot(
  snapshot: FreshnessSnapshot,
  sourceFilesOnDisk: string[],
): Array<{ file: string; status: string }> {
  const out: Array<{ file: string; status: string }> = [];
  const selected = new Set(sourceFilesOnDisk);
  for (const [file, s] of Object.entries(snapshot.sources)) {
    if (!s.exists || !selected.has(file)) out.push({ file, status: "deleted" });
    else if (s.currentHash !== s.recordedHash) out.push({ file, status: "changed" });
  }
  const recorded = new Set(Object.keys(snapshot.sources));
  for (const file of sourceFilesOnDisk) {
    if (!recorded.has(file)) out.push({ file, status: "new" });
  }
  return out;
}

/**
 * Sort a slug list ascending and cap it at MAX_STATUS_LIST.
 * Deterministic truncation ensures agents see the same subset on repeated calls.
 */
function capSlugs(slugs: string[]): string[] {
  return slugs.slice().sort().slice(0, MAX_STATUS_LIST);
}

/**
 * Sort a pending-change list by file name ascending and cap at MAX_STATUS_LIST.
 * Deterministic truncation matches capSlugs behaviour for consistency.
 */
function capPendingChanges(
  changes: Array<{ file: string; status: string }>,
): Array<{ file: string; status: string }> {
  return changes.slice().sort((a, b) => a.file.localeCompare(b.file)).slice(0, MAX_STATUS_LIST);
}

/**
 * Options for {@link collectStatus}.
 *
 * `pageScan` is optional so every existing caller keeps the on-disk scan. Supplied,
 * the page counts and the stale/orphaned classification read rows instead, which is
 * what lets a Stack-backed project report status with no `wiki/` on disk.
 */
export interface CollectStatusOptions {
  /** Row-backed scan source; omit to read `wiki/` from disk. */
  pageScan?: PageScanSource;
  /**
   * Row-backed source corpus; omit to read `sources/` from disk.
   *
   * Separate from `pageScan` because sources and pages are different tables, and
   * omitting this is what made `wiki_status` report a Stack's pages from rows while
   * counting its PENDING CHANGES against the repository's own `sources/` directory.
   * The two numbers came from different worlds in one object: a stack with one page
   * reported `pages: 1, sources: 1` beside `pendingChanges: 23`, every one of those 23
   * being an unrelated file in the checkout. Adding the seam here is the same fix
   * `detectChanges` already had.
   */
  sourceDocuments?: SourceDocumentListing;
  /**
   * Environment naming the Stack this status is about; `process.env` when omitted.
   *
   * The compile state is Stack-scoped: `readStateClassifiedFor` reads
   * `wiki.source_compile_state` for whichever Stack the environment names, and with
   * no environment it names whichever Stack the PROCESS is bound to. Omitting it here
   * was the leak that put one object together from two deployments — a named Stack's
   * page and source corpora beside ANOTHER Stack's `sources`, `lastCompiledAt` and
   * `pendingChanges`. Measured on a call naming a Stack with 0 pages while the ambient
   * deployment had compiled 2 sources: `pages: { total: 0 }` and `sources: 2` in the
   * same payload.
   *
   * Optional so every on-disk caller (the CLI among them) keeps resolving exactly as
   * it does today; the MCP tool path passes the per-request environment explicitly.
   */
  env?: NodeJS.ProcessEnv;
}

/** The Stack's own documents, as the status needs them. */
export interface SourceDocumentListing {
  /**
   * Source identities, their stored hashes, and their text.
   *
   * `content` is present because the row already carries it: `listSourceDocuments`
   * selects it for every document. Freshness compares hashes and ignores the text;
   * the citation rules need the text itself to count lines for claim-level spans,
   * and re-reading it per rule would be a second query for data already in hand.
   */
  list(): Promise<Array<{ sourceIdentity: string; contentHash: string; content?: string }>>;
}

/** Build a read-only status snapshot used by the `wiki_status` MCP tool. */
export async function collectStatus(
  root: string,
  options: CollectStatusOptions = {},
): Promise<WikiStatus> {
  const classified = await readStateClassifiedFor(root, options.env);
  // The corpus comes from the Stack when one is configured, for the snapshot as well as
  // for the pending list: a snapshot that judges `exists` against `sources/` reported
  // every Stack source as deleted, because its keys are capability URLs and no such
  // file is ever on disk.
  const stackDocuments = options.sourceDocuments === undefined
    ? undefined
    : await options.sourceDocuments.list();
  // Hand the listing over explicitly. Letting the helper resolve its own corpus would
  // make the snapshot and the pending list read two different sources: an injected
  // listing (how the status tests, and the MCP tool, drive this) reached the pending
  // list while the snapshot ignored it and judged a live owner `orphaned`.
  const snapshot = await buildProjectFreshnessSnapshot(
    root,
    classified,
    stackDocuments,
    options.env,
  );

  const scan = options.pageScan;
  // Rows are authoritative when a Stack is configured, exactly as in `detectChanges`.
  // The directory is consulted only when it is not, so a project that never opted into
  // the backend keeps reporting the same numbers it always did.
  const sourceFilesOnDisk = stackDocuments?.map((doc) => doc.sourceIdentity);
  const [conceptSummaries, queries, scannedConcepts, pendingCandidates, filesFromDisk] = await Promise.all([
    // Summaries are DERIVED from the same scan the classification uses, so a row
    // listing cannot report a page count that disagrees with its own stale list.
    scan === undefined
      ? collectPageSummaries(path.join(root, CONCEPTS_DIR))
      : scan.scan("concepts").then(summarizeScanned),
    scan === undefined
      ? collectPageSummaries(path.join(root, QUERIES_DIR))
      : scan.scan("queries").then(summarizeScanned),
    scan === undefined
      ? scanWikiPages(path.join(root, CONCEPTS_DIR))
      : scan.scan("concepts"),
    countCandidates(root, options.env),
    sourceFilesOnDisk === undefined
      ? listSelectedSourceFiles(root)
      : Promise.resolve(sourceFilesOnDisk),
  ]);

  const { stalePages, orphanedPages } = classifyConceptPages(scannedConcepts, snapshot);
  // Surface read-surface health signals so an agent never reads a degraded status
  // as silently healthy: a pending/unavailable journal (unfinished or tampered
  // compile) AND a pending embeddings refresh (a compile that skipped/failed the
  // embeddings update). Each mapper returns null when healthy, so the combined
  // array is empty for a clean project and the field stays absent (parity-safe).
  const [journalWarning, pendingWarning, quarantineWarning] = await Promise.all([
    journalHealthWarning(root),
    pendingEmbeddingsWarning(root),
    quarantinedEmbeddingsWarning(root),
  ]);
  const warnings = [journalWarning, pendingWarning, quarantineWarning].filter(
    (w): w is ReadSurfaceWarning => w !== null,
  ).map(({ code, message }) => ({ code, message }));

  // Suppress pendingChanges when state is corrupt OR too-new: comparing against an
  // empty snapshot would classify every source file as "new", which is false precision
  // (and would make a too-new project look like an ordinary fresh checkout).
  // On missing state the snapshot is legitimately empty, so every on-disk source is "new" — correct.
  const stateUnusable = classified.status === "corrupt" || classified.status === "too-new";
  const pendingChanges = stateUnusable
    ? []
    : pendingChangesFromSnapshot(snapshot, filesFromDisk);

  // A too-new state carries the RAW parsed object, which need not be v1-shaped:
  // its `sources` may be absent. Fail closed by reading an empty map for any
  // unusable state, so the source count and last-compile reads cannot crash.
  const usableSources = stateUnusable ? {} : classified.state.sources;

  return {
    pages: { concepts: conceptSummaries.length, queries: queries.length, total: conceptSummaries.length + queries.length },
    sources: Object.keys(usableSources).length,
    lastCompiledAt: lastCompileTime(usableSources),
    stalePages: capSlugs(stalePages),
    staleCount: stalePages.length,
    orphanedPages: capSlugs(orphanedPages),
    orphanedCount: orphanedPages.length,
    stateStatus: classified.status,
    pendingCandidates,
    pendingChanges: capPendingChanges(pendingChanges),
    pendingChangesCount: pendingChanges.length,
    ...(warnings.length ? { warnings } : {}),
  };
}
