/**
 * @file src/trust/promote.ts
 * @description The single under-lock promotion routine for a TYPED entity-page
 * candidate, shared by the SDK staging helper and `review approve`'s typed
 * branch (CLP Phase-3 hardening, DRY).
 *
 * Promoting a typed candidate must (a) re-validate the candidate's declared
 * `targetEntityType` against the CURRENTLY-loaded profile — the profile may have
 * changed since the candidate was staged — and (b) re-plan + apply the write
 * under the SAME held lock as the candidate re-read and delete, so a concurrent
 * reject between read and apply cannot race. This module owns that contract once:
 *
 *  - {@link applyTypedCandidate} is the LOCK-FREE core (caller already holds the
 *    project lock): load + validate the active profile, re-plan via the typed
 *    {@link planPageMutation}, apply via {@link applyApprovedMutationsLocked}, and
 *    return the wiki-relative `wiki/<entityType>/<slug>.md` path. It NEVER deletes
 *    the candidate — the caller owns that, since `review approve` deletes only
 *    after its source-state/index refresh tail.
 *  - {@link promoteCandidateUnderLock} is the SELF-LOCKING SDK entry point: it
 *    acquires the lock, RE-READS the candidate (aborting if a concurrent reject
 *    removed it), runs {@link applyTypedCandidate}, deletes the candidate, and
 *    releases the lock in `finally`.
 */

import { AKS_STACK_ID_ENV_VAR } from "../dimensions/activation.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { acquireMutationLock } from "../utils/mutation-lock.js";
import { releaseLock } from "../utils/lock.js";
import { planPageMutation } from "./planner.js";
import { applyApprovedMutationsLocked } from "./executor.js";
import { readCandidate, deleteCandidate } from "../compiler/candidates.js";
import { assertCandidateMutationAccess } from "../compiler/candidate-custody.js";
import { validateLiveTypedPage } from "./typed-page-validate.js";
import type { ReviewCandidate } from "../utils/types.js";

/**
 * Thrown when a typed candidate cannot be promoted because the active profile no
 * longer declares (or never declared) its `targetEntityType` — e.g. a default
 * project with no profile, or a profile edited since staging. Promotion fails
 * CLOSED so a typed page can never land outside the current profile schema, and
 * the candidate is RETAINED for the caller to surface. Distinct from a blocked
 * plan ({@link CandidatePromotionBlockedError}).
 */
export class CandidateProfileError extends Error {
  constructor(entityType: string, reason: "no-profile" | "undeclared") {
    const detail =
      reason === "no-profile"
        ? "the project has no non-default profile"
        : `the active profile does not declare entity type "${entityType}"`;
    super(`cannot promote typed candidate: ${detail}`);
    this.name = "CandidateProfileError";
  }
}

/**
 * Thrown when the typed re-plan blocks at promotion time (empty plan — e.g. the
 * mandatory floor refused an oversized body). The candidate is RETAINED; nothing
 * partial ever lands.
 */
export class CandidatePromotionBlockedError extends Error {
  constructor(entityType: string, slug: string) {
    super(`typed candidate ${entityType}/${slug} blocked by the write planner; retained`);
    this.name = "CandidatePromotionBlockedError";
  }
}

/** The wiki-relative page path a typed candidate promotes to. */
function typedPagePath(entityType: string, slug: string): string {
  return `wiki/${entityType}/${slug}.md`;
}

/**
 * Validate a typed candidate's `targetEntityType` against the active profile and
 * re-plan + apply its write — the LOCK-FREE promotion core. The caller MUST
 * already hold the project lock (so this never nests an acquire). Loads the
 * active non-default profile, refuses if it is absent or no longer declares the
 * type, re-plans via the typed planner (so the mandatory floor + path-confinement
 * re-run at promotion time), and applies under the held lock. Returns the
 * wiki-relative page path the body landed at.
 *
 * @param root - Absolute project root.
 * @param candidate - The typed candidate (must carry `targetEntityType`).
 * @returns The `wiki/<entityType>/<slug>.md` path the page was written to.
 * @throws {CandidateProfileError} When no profile declares the type.
 * @throws {EntityFieldContractError} When the body frontmatter violates the field contract.
 * @throws {LifecycleTransitionError} When the body performs an illegal lifecycle transition.
 * @throws {RelationPreconditionUnmetError} When a relation-count precondition for the entered state is unmet.
 * @throws {RelationPreconditionUnverifiableError} When the relation store is unreadable.
 * @throws {CandidatePromotionBlockedError} When the re-plan blocks (empty plan).
 */
export async function applyTypedCandidate(
  root: string,
  candidate: ReviewCandidate,
): Promise<string> {
  await assertCandidateMutationAccess(root, false);
  const entityType = candidate.targetEntityType!;
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new CandidateProfileError(entityType, "no-profile");
  if (!(entityType in loaded.profile.entities)) {
    throw new CandidateProfileError(entityType, "undeclared");
  }
  const def = loaded.profile.entities[entityType]!;
  await validateLiveTypedPage({
    root,
    profile: loaded.profile,
    entityType,
    slug: candidate.slug,
    body: candidate.body,
    def,
  });
  const { planned } = await planPageMutation({
    root,
    target: { kind: "entity", entityType, slug: candidate.slug },
    body: candidate.body,
    origin: "review",
    reviewRouted: false,
    allowOverwrite: true,
  });
  if (planned.length === 0) {
    throw new CandidatePromotionBlockedError(entityType, candidate.slug);
  }
  // TYPED PAGES HAVE NO ROW BACKEND, ON PURPOSE.
  //
  // `wiki.pages.page_directory` is constrained to `concepts` and `queries`, so an
  // entity namespace cannot be stored there — the write fails on
  // `pages_page_directory_check`. `entity_pages` is NOT the answer either: it is the
  // KG's on-demand page cache, keyed by `ontology_entities`, and an entity page must
  // not live in the wiki dimension at all.
  //
  // So there is nowhere to put this page on a Stack, and the write is refused rather
  // than falling through to a file that nothing on a Stack reads. Silently writing
  // `wiki/<entityType>/<slug>.md` is the defect this refusal replaces.
  if (rowBackedPageStoreIsActive(process.env)) {
    throw new TypedPageNotRowBackedError(entityType, candidate.slug);
  }
  await applyApprovedMutationsLocked(root, planned);
  return typedPagePath(entityType, candidate.slug);
}

/**
 * Thrown when a typed candidate is applied to a Stack.
 *
 * A Stack stores pages in rows, and `wiki.pages` cannot hold an entity namespace
 * (its `page_directory` CHECK admits only the reserved directories). There is no row
 * to write, so this fails closed instead of leaving the page in a file the Stack's
 * readers never open.
 */
export class TypedPageNotRowBackedError extends Error {
  constructor(entityType: string, slug: string) {
    super(
      `entity-pages-not-row-backed: ${entityType}/${slug} cannot be stored on a Stack — ` +
        `wiki.pages admits only concepts and queries, and entity pages do not belong ` +
        `to the wiki dimension`,
    );
    this.name = "TypedPageNotRowBackedError";
  }
}

/**
 * True when this project stores pages in rows rather than files.
 *
 * @param env - Environment to read the Stack from.
 * @returns True when a Stack is configured.
 */
function rowBackedPageStoreIsActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[AKS_STACK_ID_ENV_VAR] ?? "").trim() !== "";
}

/**
 * Promote a typed staged candidate into the live wiki under ONE held lock:
 * acquire → re-read (abort if a concurrent reject removed it) → validate profile
 * + re-plan + apply via {@link applyTypedCandidate} → delete → release. The
 * candidate read, the apply, and the delete all happen inside the same locked
 * region so no concurrent reject/approve can race the promotion.
 *
 * @param root - Absolute project root.
 * @param candidateId - The staged candidate's id.
 * @throws {Error} When the lock cannot be acquired or the candidate is missing/untyped.
 * @throws {CandidateProfileError} When the profile no longer declares the type.
 * @throws {CandidatePromotionBlockedError} When the re-plan blocks.
 */
export async function promoteCandidateUnderLock(root: string, candidateId: string): Promise<void> {
  const acquired = await acquireMutationLock(root, "ordinary");
  if (!acquired) throw new Error("could not acquire project lock for candidate promotion");
  try {
    const candidate = await readCandidate(root, candidateId);
    if (!candidate) throw new Error(`staged candidate not found: ${candidateId}`);
    if (!candidate.targetEntityType) {
      throw new Error(`candidate ${candidateId} is not a typed entity page`);
    }
    await applyTypedCandidate(root, candidate);
    await deleteCandidate(root, candidateId);
  } finally {
    await releaseLock(root);
  }
}
