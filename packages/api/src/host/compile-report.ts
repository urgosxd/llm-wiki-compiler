/**
 * @file src/host/compile-report.ts
 * @description The per-dimension report `POST /api/compile` answers with: what happened to
 * each dimension, `kg` included, when this route composed nothing but the wiki compile.
 *
 * ## Why this lives beside the route and not beside the dimensions port
 *
 * The report exists only because `handleCompile` exists. `src/dimensions/` is the seam where
 * this package IMPLEMENTS the port `@repo/foundation` declares -- a different purpose, and a
 * route's report parked there would make the seam look like the place to add route
 * behaviour. So the producer stays in `./api.ts`'s neighbourhood, and `api.ts` keeps only the
 * call, which is also what keeps that file inside the house size limit.
 *
 * ## Why `enabled` is restated instead of read from the switch
 *
 * This route does not consult `LLMWIKI_DIMENSIONS` at all: `compileAndReport` reaches the
 * dimensions port only for graph retirement, which needs a Stack, so a compile writes the
 * wiki whatever the switch says. A report that read `enabled` from the environment would
 * therefore contradict its own body -- a run that plainly compiled pages would call the
 * dimension it just wrote `disabled` -- and on a file-backed Stack the same read throws
 * `DimensionActivationError`, which would turn this route's 200 into a 500. Composing
 * nothing but `wiki` IS this route's enabled set.
 *
 * ## Why the producer is reached by PATH
 *
 * `packages/wiki` exports no subpath for `dimensions/report.ts`: `@repo/wiki/dimensions` does
 * not resolve, and widening that manifest is not this package's change to make. The
 * cross-package walk is the spelling this package already writes for an internal surface it
 * may not import by name -- `stacks-declaration.ts` reaches `@repo/kg`'s DTO the same way --
 * and `api` is the ONE zone permitted to import wiki at all. This file imports the report
 * producer and its two types, nothing else.
 */

import { describeDimensionOutcomes } from "../../../wiki/src/dimensions/report.js";
import type { DimensionOutcome, DimensionRunReport } from "../../../wiki/src/dimensions/report.js";
import type { CompileResult } from "@repo/wiki/utils-types";

/**
 * The dimensions `POST /api/compile` composes: the wiki compile, and nothing else (S5).
 *
 * `kg` is absent on purpose and the report says so in words. Composing it is the separate
 * feature `odd/tasks/kg-compile-composition.md`; until that lands, this route's own set is
 * the truthful answer to "what did this run enable", not the process environment.
 */
const COMPILE_ROUTE: readonly DimensionRunReport["name"][] = ["wiki"];

/**
 * What the wiki dimension did on one compile run, derived from the counts that run reported.
 *
 * The operator's complaint was a summary that said the same thing whatever happened, so this
 * one is BUILT from {@link CompileResult} rather than chosen: `compiled`, `skipped` and
 * `deleted` are the counts the pipeline counted, and `concepts`, `pages` and `errors` are the
 * lengths of the lists it returned. `committed` and not `failed` even with errors present,
 * because `failed` means the dimension THREW and this route only reaches here after
 * `compileAndReport` returned; the error count belongs in the summary, not in a state that
 * would claim the run died.
 *
 * @param result - The compile result the route is about to answer with.
 * @returns The `wiki` entry of the report.
 */
function wikiRunOf(result: CompileResult): DimensionRunReport {
  const changes = `compiled=${result.compiled} skipped=${result.skipped} deleted=${result.deleted}`;
  const totals =
    `concepts=${result.concepts.length} pages=${result.pages.length} ` +
    `errors=${result.errors.length}`;
  return { name: "wiki", state: "committed", summary: `wiki: ${changes} ${totals}` };
}

/**
 * The per-dimension report one compile run answers with.
 *
 * Built by the SAME producer every other surface uses (S3), from the route this mount
 * composes and the state the run actually reached -- never from the ingest/compile halves
 * `runSyncIngest` spreads, which are not dimensions at all (S7).
 *
 * @param result - The compile result the route is about to answer with.
 * @returns One outcome per known dimension, `kg` included as `not-in-route`.
 */
export function compileReportOf(result: CompileResult): readonly DimensionOutcome[] {
  return describeDimensionOutcomes({
    route: COMPILE_ROUTE,
    enabled: COMPILE_ROUTE,
    runs: [wikiRunOf(result)],
  });
}
