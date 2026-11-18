/**
 * @file src/dimensions/outcome.ts
 * @description The WIRE shape of a per-dimension report: what one dimension did on one
 * run, as a consumer of the job record reads it.
 *
 * ## Why these declarations live apart from the code that produces them
 *
 * `report.ts` derives the report, and to do that it needs {@link KNOWN_DIMENSIONS},
 * which it imports from `activation.ts`. That import is not free: `activation.ts`
 * reaches the `kg` dimension factories, and through them `@repo/kg` and the query
 * builder. Deriving the report is a SERVER-side operation that runs once per ingest,
 * so paying that cost there is correct.
 *
 * Declaring the result in the same module would charge the same cost to every consumer
 * of the TYPE -- and the type is imported by the job record (`jobs/types.ts`), which the
 * viewer and the MCP tools import to render a status answer. A type that drags a database
 * driver into a read-only renderer is a cost nobody asked for, and TypeScript erases
 * types, so the pull would happen through the module's VALUE imports on the way in.
 *
 * So this file holds the declarations and NOTHING else. It imports one thing, a type
 * from `./types.js`, which declares the dimension port and imports no implementation.
 * `report.ts` imports these declarations and re-exports them, so every existing importer
 * of `report.js` keeps working and `KNOWN_DIMENSIONS` stays the one source of truth for
 * the dimension order inside the module that uses it.
 *
 * ## The facts the shape must keep apart
 *
 * A report exists because a bare summary could not tell an operator these apart:
 *
 *   1. this route does not compose the dimension -- `skipped` / `not-in-route`;
 *   2. the route composes it but `LLMWIKI_DIMENSIONS` excludes it -- `skipped` /
 *      `disabled`;
 *   3. it ran and had nothing to commit -- `skipped` / `declined`;
 *   4. the run failed BEFORE reaching any dimension -- `skipped` / `not-attempted`.
 *
 * A fifth case, `failed`, is its own arm because it carries the error text. Collapsing
 * any two of them is how the reported defect happened: an operator saw a compile line
 * that named nothing, and had no way to ask whether `kg` had been excluded by the route,
 * by configuration, by a failure, or never reached at all.
 */

import type { DimensionName } from "./types.js";

/**
 * Why a dimension produced nothing, in the operator's terms.
 *
 * One value per action an operator would take: `not-in-route` means the route never
 * composes this dimension, `disabled` means an environment variable excludes it,
 * `declined` means it ran and found nothing to write, and `not-attempted` means the run
 * died before the dimension was ever reached -- so the failure is UPSTREAM of it, and
 * nothing about the dimension's own health can be concluded. Reporting the wrong one sends
 * someone to change a setting that would not have helped, or to investigate a dimension
 * that never ran.
 */
export type DimensionSkipReason = "not-in-route" | "disabled" | "declined" | "not-attempted";

/**
 * What one dimension did on one run.
 *
 * Closed by `status`, so a reader that handles `succeeded` cannot accidentally read a
 * summary off a skipped dimension, and one that handles `failed` must carry the error
 * rather than inventing an empty success.
 *
 * Every known dimension appears on every settling path. A missing entry is a bug, not a
 * statement: silence is exactly what made the reported defect invisible.
 */
export type DimensionOutcome =
  | { readonly name: DimensionName; readonly status: "succeeded"; readonly summary: string }
  | { readonly name: DimensionName; readonly status: "failed"; readonly error: string }
  | {
      readonly name: DimensionName;
      readonly status: "skipped";
      readonly reason: DimensionSkipReason;
    };

/**
 * What the coordinator records for one dimension on one run.
 *
 * This is the FACT the report is derived from, kept deliberately smaller than
 * {@link DimensionOutcome}: it says what happened, not why the route or the switch chose
 * it, because the coordinator never sees either of those.
 *
 * A dimension that never threw reports `declined` when it has no committed write -- on a
 * failed run that is the rolled-back case, where no write landed and nothing went wrong
 * with that dimension specifically.
 */
export interface DimensionRunReport {
  /** Which dimension this record is about. */
  readonly name: DimensionName;
  /** What happened: a committed write, no write, or an error. */
  readonly state: "committed" | "declined" | "failed";
  /** The string the dimension reported, on `committed` only. */
  readonly summary?: string;
  /** The message it threw, on `failed` only. */
  readonly error?: string;
}

/** The report inputs: what the route composed, what the switch enabled, what ran. */
export interface DimensionOutcomeInput {
  /** Dimensions this route composes, in any order. */
  readonly route: readonly DimensionName[];
  /** Dimensions `LLMWIKI_DIMENSIONS` enabled. */
  readonly enabled: readonly DimensionName[];
  /** Per-run state the coordinator recorded. */
  readonly runs: readonly DimensionRunReport[];
  /**
   * Whether the run reached the point where dimensions are resolved at all.
   *
   * Absent means `true`, which is every run the coordinator was part of. `false` is the
   * pre-dispatch failure -- an unreadable source, lock contention -- where the job died
   * upstream of the dimension work: each composed and enabled dimension is then reported
   * `not-attempted`, because nothing can honestly be said about a dimension nobody
   * reached. `runs` is empty in that case, so `false` never rescues a recorded run.
   */
  readonly attempted?: boolean;
}
