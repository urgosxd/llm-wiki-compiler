/**
 * @file src/context/pack-warnings.ts
 * @description The top-level PACK-WARNING appenders `buildContextPack()` runs
 * over the assembled draft — extracted VERBATIM from `./build.ts` so the
 * orchestrator stays under the repository's 400 non-comment-line file budget.
 *
 * Each appender lifts one already-computed project-health signal into the
 * pack's top-level `warnings[]` so an agent SEES a degraded project rather
 * than receiving a silently-thinner pack:
 *   - {@link appendProjectWarnings} — pending review candidates, lint errors,
 *     and `--include-sources` line-range citations that produced no window;
 *   - {@link appendRelationStoreWarning} — a fail-closed relation-store read
 *     (corrupt / too-new / symlink / confinement) from the snapshot's profile
 *     problems;
 *   - {@link appendStandingRelationWarnings} — standing relation-precondition
 *     drift (a page still in a gated lifecycle state whose precondition no
 *     longer holds) and the distinct "cannot verify" store-read failure;
 *   - {@link appendArtifactWarning} — one or more hash-pinned artifactRef
 *     values that resolved to a non-`ok` health (dangling / bytes-tampered /
 *     hash-mismatch / schema-invalid / unreadable / store-unavailable);
 *   - {@link appendJournalWarning} — a pending/unavailable compile journal.
 *
 * All five are additive and byte-preserving for a healthy/default project:
 * when the signal is absent the input pack is returned with an identical
 * warnings list, so the default context pack stays byte-identical (the parity
 * suite pins this). Every appender is read-only — nothing here mutates disk.
 * Ordering is owned by the orchestrator in `./build.ts`, which calls them in a
 * fixed sequence between source-window materialization and budget trimming.
 */

import { journalHealthWarning } from "../trust/journal-health-warning.js";
import type { ProjectState } from "../project/state.js";
import type { ViewerSnapshot } from "../viewer/types.js";
import type { NormalizedOptions } from "./build.js";
import type { ContextPack, ContextWarning } from "./types.js";

/**
 * Append `pending-candidates`, `lint-errors`, and
 * `source-window-unavailable` to the top-level warnings list.
 *
 * Runs AFTER source-window materialization so we can detect the gap
 * where `--include-sources` was on but a line-range citation
 * produced no window (path-confined rejection, missing source file,
 * 20-window cap reached, …). Runs BEFORE budget trimming so a
 * budget-induced window drop does NOT spuriously add the warning;
 * the trimmer mutates sourceWindows only after this pass.
 */
export function appendProjectWarnings(
  pack: ContextPack,
  state: ProjectState,
  options: NormalizedOptions,
): ContextPack {
  const warnings = [...pack.warnings];
  if (state.pendingCandidates > 0) {
    warnings.push({
      code: "pending-candidates",
      message:
        `${state.pendingCandidates} review candidate${state.pendingCandidates === 1 ? "" : "s"} ` +
        "pending approval. Run `llmwiki review list` to inspect.",
    });
  }
  const lintErrors = state.lint.entry?.errors ?? 0;
  if (lintErrors > 0) {
    warnings.push({
      code: "lint-errors",
      message: `Last lint run reported ${lintErrors} error${lintErrors === 1 ? "" : "s"}.`,
    });
  }
  if (options.includeSources && hasUnmaterializedSpans(pack)) {
    warnings.push({
      code: "source-window-unavailable",
      message:
        "One or more line-range citations did not produce a source window " +
        "(path-confined, missing source file, or per-pack window cap reached).",
    });
  }
  return { ...pack, warnings };
}

/**
 * Append an `incomplete-compile` / `journal-unavailable` warning when the
 * project's compile journal is pending / unavailable, via the SHARED read-only
 * {@link journalHealthWarning} mapper (the same signal status/lint/viewer/export
 * surface). A cleanly-compiled project's journal is `ok`, so the mapper returns
 * null and the pack is byte-identical. Read-only — the mapper never mutates disk.
 */
export async function appendJournalWarning(pack: ContextPack, root: string): Promise<ContextPack> {
  const warning = await journalHealthWarning(root);
  if (warning === null) return pack;
  return { ...pack, warnings: [...pack.warnings, warning] };
}

/** True when any primary page has line-range citations missing matching sourceWindows. */
function hasUnmaterializedSpans(pack: ContextPack): boolean {
  for (const entry of pack.primary) {
    const lineRangeCount = entry.citations.filter(
      (c) => c.start !== undefined && c.end !== undefined,
    ).length;
    if (lineRangeCount > entry.sourceWindows.length) return true;
  }
  return false;
}
