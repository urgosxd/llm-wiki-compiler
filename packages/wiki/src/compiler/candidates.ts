/**
 * Candidate store: deletion, archive and the shared path/read re-exports.
 *
 * ## What this module no longer does
 *
 * It used to own the WRITE half of the store as well: `writeCandidate` persisted a new
 * record, canonicalised duplicates, allocated an id exclusively and captured custody.
 * Nothing ever promoted a candidate into the wiki, so the stagers were dead ends and are
 * retired; a new candidate record has no producer any more.
 *
 * ## What survives, and why
 *
 * Records already on disk stay READABLE. `.llmwiki/candidates/*.json` is inert data, not
 * deleted data: the viewer lists it, the read path renders it, and the deletion and archive
 * paths below still consume it under exact custody receipts. The read/list/sanitize/validate
 * half lives in {@link file://./candidate-read.ts} and the shared path resolvers in
 * {@link file://./candidate-paths.ts}; both are RE-EXPORTED below so existing importers of
 * `candidates.ts` are unchanged.
 */

import { unlink } from "fs/promises";
import { withCandidateSource } from "../dimensions/wiki/candidate-source.js";
import { NO_DATABASE_CONFIGURED, type StackAuthority } from "../dimensions/stack-authority.js";
import { assertCandidateSlug, candidatePath } from "./candidate-paths.js";
import {
  candidateTargetKey,
  selectReadableCandidateEntriesForMutation,
} from "./candidate-selection.js";
import {
  assertCandidateNamespacesHealthy,
  captureCandidateCustody,
  CandidateCustodyUnavailableError,
  moveCandidateWithCustody,
  observeCandidateCustody,
  type CandidateCustodyReceipt,
} from "./candidate-custody.js";
import { captureCandidateCustodyReceipt } from "./candidate-custody-snapshot.js";

// Re-export the read/list/sanitize half and shared path symbols so every
// existing importer of `candidates.ts` keeps working without churn.
export {
  readCandidate,
  readCandidateBySlug,
  listCandidates,
  listCandidatePage,
  countCandidates,
  listLinkResolvablePendingSlugs,
  loadCandidateOrFail,
  loadCandidateUnderLockOrFail,
} from "./candidate-read.js";
export type { CandidatePage } from "./candidate-read.js";
export { UnsafeCandidateIdError } from "./candidate-paths.js";
export {
  CandidateIdentityMismatchError,
} from "./candidate-selection.js";

/** Deterministic seams for custody replacement tests; normal callers omit them. */
export interface CandidateDeletionHooks {
  afterCustodyForTest?: (fileId: string) => Promise<void>;
  afterCandidateDeleteForTest?: (fileId: string, index: number) => Promise<void>;
}

/**
 * The custody branch for a caller that resolved no Stack authority.
 *
 * THE COMPILER NEVER REACHES THIS VALUE. `runCompilePipeline` resolves the authority
 * once and hands it down through `generateMergedPage`, so every call the pipeline makes
 * carries the run's answer, and a row-backed run cannot be told it is file-backed.
 *
 * It exists for the entry points whose callers held only an `env` before this chain was
 * threaded, and it answers the FILE branch — which is the branch those calls already
 * took: the row source is chosen by `withCandidateSource(env)`, so a caller that names
 * no Stack there is file-backed. Custody agreeing with that keeps ONE answer per call
 * instead of two. A caller that has a resolved authority passes it and is never here.
 */
const UNRESOLVED_AUTHORITY: StackAuthority = { kind: "file", reason: NO_DATABASE_CONFIGURED };

/** Remove only the exact pending object authorized by one custody receipt. */
async function deleteCandidateWithCustody(
  root: string,
  receipt: CandidateCustodyReceipt,
  authority: StackAuthority,
): Promise<boolean> {
  const captured = captureCandidateCustodyReceipt(receipt, "public");
  await assertCandidateNamespacesHealthy(root, authority);
  if (await observeCandidateCustody(root, captured, "public") !== "restored") {
    throw new CandidateCustodyUnavailableError();
  }
  await assertCandidateNamespacesHealthy(root, authority);
  const filePath = await candidatePath(root, captured.fileId);
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    throw new CandidateCustodyUnavailableError();
  }
}

/**
 * Remove a pending candidate after capturing its exact current custody.
 * @param root - Project root directory.
 * @param env - The run's environment, used to pick the candidate source.
 * @param id - Candidate id to remove.
 * @param hooks - Deterministic test seams; normal callers omit them.
 * @param authority - The Stack this run resolved, when it resolved one; see
 *   {@link UNRESOLVED_AUTHORITY} for the callers that never did.
 * @returns True when the candidate was found and removed.
 */
export async function deleteCandidate(
  root: string,
  env: NodeJS.ProcessEnv,
  id: string,
  hooks: CandidateDeletionHooks = {},
  authority: StackAuthority = UNRESOLVED_AUTHORITY,
): Promise<boolean> {
  // A row has no inode to capture and no parent directory to validate, so the
  // custody preconditions below are vacuous; the delete is the whole operation.
  const viaRows = await withCandidateSource(env, async (source) =>
    source === undefined ? undefined : await source.remove(id),
  );
  if (viaRows !== undefined) return viaRows;

  await assertCandidateNamespacesHealthy(root, authority);
  const custody = await captureCandidateCustody(root, id, undefined, "public");
  if (custody === null) return false;
  await hooks.afterCustodyForTest?.(id);
  return deleteCandidateWithCustody(root, custody.receipt, authority);
}

/**
 * Delete ALL pending candidate files for a DEFAULT concepts slug.
 *
 * When duplicates exist (e.g. legacy or hand-dropped files) the direct-write
 * reconcile path must remove every file matching the slug, not just the first
 * canonical one, so no stale duplicates remain after a concepts page is written
 * directly. Matches on the FULL `concepts/<slug>` identity (via
 * {@link candidateTargetKey}) so a typed `papers/<slug>` candidate that merely
 * shares the slug is NOT collaterally deleted when a default concepts page is
 * reconciled — the default caller only writes concepts, so its behavior is
 * unchanged.
 * @param root - Project root directory.
 * @param env - The run's environment, used to pick the candidate source.
 * @param slug - Default concepts slug whose candidates are deleted.
 * @param hooks - Deterministic test seams; normal callers omit them.
 * @param authority - The Stack this run resolved, when it resolved one; see
 *   {@link UNRESOLVED_AUTHORITY} for the callers that never did.
 * @returns True when at least one candidate was removed.
 */
export async function deleteCandidateBySlug(
  root: string,
  env: NodeJS.ProcessEnv,
  slug: string,
  hooks: CandidateDeletionHooks = {},
  authority: StackAuthority = UNRESOLVED_AUTHORITY,
): Promise<boolean> {
  assertCandidateSlug(slug);

  // Rows answer the whole match in one query: the slug is an indexed comparison, not
  // a directory walk filtered by a parsed target key. Every match is removed, which is
  // what the file path reached by collecting entries first.
  const viaRows = await withCandidateSource(env, async (source) => {
    if (source === undefined) return undefined;
    const target = `concepts/${slug}`;
    const matching = (await source.list()).filter(
      (candidate) => candidateTargetKey(candidate) === target,
    );
    for (const candidate of matching) await source.remove(candidate.id);
    return matching.length > 0;
  });
  if (viaRows !== undefined) return viaRows;

  const matching = await selectReadableCandidateEntriesForMutation(
    root,
    (candidate) => candidateTargetKey(candidate) === `concepts/${slug}`,
  );
  if (matching.length === 0) return false;
  for (const [index, entry] of matching.entries()) {
    await deleteCandidateWithCustody(root, entry.custodyReceipt, authority);
    await hooks.afterCandidateDeleteForTest?.(entry.fileId, index);
  }
  return true;
}

/**
 * Move a candidate from the pending area into the archive subdirectory so
 * rejected proposals stay auditable without touching `wiki/`.
 * @param root - Project root directory.
 * @param id - Candidate id to archive.
 * @returns True when the candidate was found and archived.
 */
export async function archiveCandidate(root: string, id: string): Promise<boolean> {
  const custody = await captureCandidateCustody(root, id, undefined, "public");
  if (custody === null) return false;
  return moveCandidateWithCustody({
    root,
    fileId: id,
    direction: "archive",
    receipt: custody.receipt,
  }, "public");
}
