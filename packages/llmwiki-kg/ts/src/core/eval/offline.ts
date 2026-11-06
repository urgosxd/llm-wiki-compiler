/**
 * @file packages/llmwiki-kg/ts/src/core/eval/offline.ts
 * @description The default runner: the recorded double, the shipped set, no network.
 *
 * This is the evaluation the normal test suite and CI run. It needs no credential,
 * opens no socket, and is deterministic, which are the three properties that make it
 * worth running on every change. What it cannot do is tell you how today's model
 * behaves: for that, `core/eval/main.ts` has the explicit real runner, which refuses
 * to start without both a key and a flag.
 */

import type { TypeCatalog } from "../catalog/types.js";
import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import { parseJevConfig } from "../jev/config.js";
import type { JevConfig } from "../jev/config.js";
import { recordedDoubleFor, RECORDED_MODEL } from "./recorded.js";
import { runEvalSet } from "./runner.js";
import type { EvalRun } from "./runner.js";
import type { EvalSet } from "./types.js";

/** What the offline runner accepts: the set, and optional overrides for testing. */
export interface OfflineEvalInput {
  readonly set: EvalSet;
  /** The catalog to classify against; defaults to the documented default catalog. */
  readonly catalog?: TypeCatalog;
  /** The configuration to use; defaults to the parsed process-wide defaults. */
  readonly config?: JevConfig;
}

/**
 * Runs the offline evaluation over a labeled set.
 *
 * @param input - The set, and optionally the catalog and configuration.
 * @returns The report, the decisions behind it, and the double it consumed.
 */
export async function runOfflineEval(input: OfflineEvalInput): Promise<EvalRun> {
  return runEvalSet({
    set: input.set,
    catalog: input.catalog ?? defaultTypeCatalog(),
    client: recordedDoubleFor(input.set),
    config: input.config ?? parseJevConfig({}),
    run: { mode: "offline", model: RECORDED_MODEL, baseUrl: null },
  });
}
