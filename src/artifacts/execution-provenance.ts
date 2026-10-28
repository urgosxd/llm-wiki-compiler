/**
 * @file src/artifacts/execution-provenance.ts
 * @description Verify that a pinned artifact was vouched for by a PREPARATION RUN.
 *
 * ## Why this now refuses instead of verifying
 *
 * Execution provenance asked a different question from the artifact store: not "are these
 * bytes intact" but "did a run whose sealed plan named this action actually admit them".
 * Answering it meant scanning the preparation inventory, reading each candidate run's
 * frozen input, and matching the provider's declared output id.
 *
 * The preparation subsystem has been removed from this build. There is therefore no run
 * that could ever vouch for anything, and the honest answer to every provenance query is
 * that it cannot be established.
 *
 * ## Why it PARK rather than DENY
 *
 * The three-way verdict existed because "not found" and "could not see" are different
 * things, and collapsing them would let a degraded store silently approve bytes it never
 * checked. With the store gone the condition is permanent, not degraded -- but the profile
 * may still DECLARE an `executionProvenance` requirement, and a declaration the build
 * cannot satisfy is an unverifiable precondition, not a failed one. Parking keeps that
 * distinction visible to the caller, which is the same reason the file-backed enforcer
 * parked an unreadable candidate instead of denying it.
 *
 * A profile that declares no provenance requirement never reaches here, so an artifact
 * workflow that does not ask the question is unaffected.
 */

import type { ExecutionProvenanceReq } from "../profile/types.js";

/** The three-way outcome, matching the health check's deny/park vocabulary. */
export interface ExecutionProvenanceVerdictV1 {
  readonly verdict: "pass" | "deny" | "park";
  /** Human-readable reason, shown wherever the verdict is surfaced. */
  readonly detail: string;
}

/**
 * Report that execution provenance cannot be established in this build.
 *
 * @param req - The profile's provenance requirement; named in the detail so an operator
 *   can see WHICH declared action is unsatisfiable.
 * @returns A permanent `park` verdict.
 */
export async function verifyExecutionProvenance(
  req: ExecutionProvenanceReq,
): Promise<ExecutionProvenanceVerdictV1> {
  return {
    verdict: "park",
    detail: `action '${req.actionId}' declares execution provenance, but this build has no preparation run store to verify it against`,
  };
}
