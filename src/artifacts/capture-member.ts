/**
 * @file src/artifacts/capture-member.ts
 * @description Generic one-member artifact capture through the existing locked,
 * journaled write authority, followed by the existing full health resolver.
 */
import { loadNonDefaultProfile } from "../profile/block.js";
import { applyApprovedMutations } from "../trust/executor.js";
import type { ArtifactOrigin } from "../trust/planner.js";
import type { ArtifactMemberFileInput } from "./members.js";
import type { ArtifactRef } from "./ref.js";
import { resolveArtifactRef } from "./resolve.js";

export interface CaptureMemberArtifactV1 {
  readonly artifactType: string;
  readonly slug: string;
  readonly member: ArtifactMemberFileInput;
  readonly origin: ArtifactOrigin;
}

/** Persist one member atomically and return only after the complete ref verifies. */
export async function captureVerifiedMemberArtifact(
  root: string, input: CaptureMemberArtifactV1,
): Promise<ArtifactRef> {
  const ref = await persistMember(root, input);
  await requireHealthy(root, ref);
  return ref;
}

/**
 * Persist the member through the locked write authority and return its ref.
 *
 * The `kind` re-check is not defensive noise: `applyApprovedMutations` accepts a union
 * of mutation kinds, so a caller that mis-classified the request would otherwise be
 * handed a ref belonging to some other artifact.
 *
 * @param root - Project root.
 * @param input - Artifact identity, member bytes, and provenance.
 * @returns The ref the write authority produced.
 * @throws When the authority reported a non-artifact result.
 */
async function persistMember(root: string, input: CaptureMemberArtifactV1): Promise<ArtifactRef> {
  const [applied] = await applyApprovedMutations(root, [{
    kind: "artifact", artifactType: input.artifactType, slug: input.slug,
    body: "", memberFiles: [input.member], origin: input.origin,
  }]);
  if (applied?.kind !== "artifact") throw new Error("member capture returned a non-artifact result");
  return applied.ref;
}

/**
 * Re-resolve the ref through the full health resolver and refuse anything unhealthy.
 *
 * The member was just written, so an unhealthy verdict means the write did not land as
 * requested; returning the ref anyway would hand the caller a citation that resolves
 * to nothing.
 *
 * @param root - Project root.
 * @param ref - The ref to verify.
 * @throws When there is no active non-default profile, or the artifact is unhealthy.
 */
async function requireHealthy(root: string, ref: ArtifactRef): Promise<void> {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new Error("member capture requires an active non-default profile");
  const resolved = await resolveArtifactRef(root, loaded.profile, ref);
  if (resolved.health !== "ok") throw new Error(`captured member artifact is not healthy: ${resolved.health}`);
}
