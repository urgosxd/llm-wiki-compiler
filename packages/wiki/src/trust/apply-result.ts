/**
 * @file src/trust/apply-result.ts
 * @description The executor's kind-discriminated apply RESULT and the typed
 * batch-shape guard error. A `relation` apply yields the persisted RelationRef
 * back through the seam (so a public caller never bypasses the executor to read
 * it); `relation` ALSO carries the {@link TrustDecision}
 * the under-lock authority composed (e.g. `allow` vs `allow-with-warning`), so a
 * consumer records the REAL decision rather than a hardcoded literal; `page`
 * yields no value (its decision is already known plan-side).
 * CrossStoreBatchUnsupportedError is thrown when a batch shape cannot be applied
 * atomically under today's single-store durability (cross-store op-ID atomicity
 * is a Phase-5 task).
 */
import type { TrustDecision } from "./decision.js";

/**
 * One applied mutation's outcome.
 *
 * `relation` and `artifact` are RETAINED FOR COMPATIBILITY: the subsystems are
 * gone and nothing produces them, but a plan parsed from an earlier build must
 * still map to a result shape rather than failing as an unknown kind. Their
 * `ref`/`decision` payloads went with the stores that minted them.
 */
export type ApplyResult =
  | { kind: "page" }
  | { kind: "relation" }
  | { kind: "artifact" };

export class CrossStoreBatchUnsupportedError extends Error {
  constructor(reason: string) {
    super(`cross-store-batch-unsupported: ${reason}`);
    this.name = "CrossStoreBatchUnsupportedError";
  }
}
