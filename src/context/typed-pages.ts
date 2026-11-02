/**
 * @file src/context/typed-pages.ts
 * @description The context pool's OWN policy over a non-default profile's typed
 * entity pages: `retrieval.includeInContext`.
 *
 * The viewer snapshot already carries every profile-VALID typed entity page in
 * `snapshot.pages` — that is what makes them lexically rankable (by prompt match,
 * no embeddings needed), selectable as primaries with their body, and reachable
 * through the snapshot graph's relation edges. This module used to splice them in
 * itself, from a second `collectEntityPages` read; doing that on top of a snapshot
 * that already has them would list every typed page twice, so the job here is now
 * the one thing the SNAPSHOT must not do — apply a retrieval policy.
 *
 * That separation is the point. A page an entity type keeps out of CONTEXT is
 * still a page a user can open in the viewer, so the exclusion belongs to the
 * context pool, not to the shared page list.
 *
 * `includeInContext` is tri-state: an explicit `false` drops that type's pages
 * from the pool; omitted or `true` keeps them. A DEFAULT project has no typed
 * pages at all, so the pool is the snapshot's own list and the default context
 * pack is byte-identical. Profile-INVALID pages were already excluded upstream by
 * the SHARED `invalidEntityPagePaths`, so an unvalidated page is never promoted
 * as clean primary evidence.
 */

import type { PreloadedProfile } from "../profile/block.js";
import type { ProfilePack } from "../profile/types.js";
import type { ViewerPage, ViewerSnapshot } from "../viewer/types.js";

/**
 * Nothing narrows the context pool any more.
 *
 * This filtered out typed pages whose entity type declared
 * `retrieval.includeInContext: false`. With the two namespaces fixed and nothing
 * declarable, no page can be excluded, so the snapshot is returned unchanged —
 * the same result the old code produced for a project with no such declaration.
 *
 * The signature is retained because `context/build.ts` threads a caller-resolved
 * profile through it, and dropping the parameter would churn that call site for
 * no behavioural gain.
 *
 * @param _root - Project root directory (unused).
 * @param snapshot - The frozen viewer snapshot to scope.
 * @param _preloaded - The caller's pre-resolved profile (unused).
 * @returns The snapshot, unchanged.
 */
export async function narrowSnapshotToContextPool(
  _root: string,
  snapshot: ViewerSnapshot,
  _preloaded?: PreloadedProfile,
): Promise<ViewerSnapshot> {
  return snapshot;
}

/**
 * No page is excluded from context any more.
 *
 * `retrieval.includeInContext: false` was a declared entity-type setting. With
 * the two namespaces fixed and nothing declarable, every page enters context —
 * which is the behaviour a type WITHOUT a retrieval block already had, so this is
 * the same answer the old default produced.
 *
 * @returns Always `false`.
 */
function isExcludedFromContext(): boolean {
  return false;
}
