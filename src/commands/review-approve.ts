/**
 * Commander action for `llmwiki review approve <id>`.
 *
 * Promotes a pending candidate into the live wiki: writes the page body to
 * wiki/concepts/<slug>.md, refreshes the index/MOC, updates embeddings, and
 * removes the candidate file. Approval never re-invokes the LLM — the body
 * stored in the candidate is written verbatim.
 *
 * All mutations are performed under `.llmwiki/lock` to prevent races with a
 * concurrent compile or sibling approve/reject. The candidate is re-read under
 * the lock (TOCTOU guard) — if it disappears between the fast-fail check and
 * lock acquisition (e.g. a concurrent reject ran first), the approval aborts
 * cleanly rather than writing a page from a stale in-memory snapshot.
 *
 * ATOMICITY (scope — do not over-promise). Only the PAGE BYTE-WRITE is journalled
 * and atomic (via the planner/executor batch). The post-write tail —
 * source-state persist, index/MOC/embeddings refresh, and `deleteCandidate` —
 * runs under the SAME lock but is NOT part of the journal batch: it is
 * best-effort and IDEMPOTENT / re-derivable. A crash anywhere in the tail leaves
 * the page written but the candidate possibly un-cleared; recovery is simply
 * re-running `approve` (idempotent) or a `refresh` (which re-derives the index,
 * MOC, embeddings, and source state). The whole operation is NOT a single atomic
 * transaction; only the page write is.
 */

import path from "path";
import { readFile } from "fs/promises";
import { validateWikiPage } from "../utils/markdown.js";
import { planPageMutation } from "../trust/planner.js";
import { applyApprovedMutationsLocked } from "../trust/executor.js";
import { pageStoreOptions } from "../trust/page-apply.js";
import { deleteCandidate } from "../compiler/candidates.js";
import {
  assertCandidateMutationAccess,
  CandidateCustodyUnavailableError,
} from "../compiler/candidate-custody.js";
import { UnsafeCandidateDirError } from "../compiler/candidate-store-paths.js";
import { sha256Text } from "../connectors/hash.js";
import { isConnectorCandidate } from "../connectors/origin.js";
import { resolveAndApplyLinks, linkGateOptions } from "../compiler/resolver.js";
import { repairAndApplyLinks } from "../compiler/link-repair.js";
import { qualifiedPageId, type PageId } from "../utils/page-id.js";
import { refreshEmbeddingsDrainingPending } from "../utils/embeddings-refresh.js";
import { readStateClassifiedFor, withPageSeams, writeStateFor } from "../dimensions/wiki/page-source-seam.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import * as output from "../utils/output.js";
import type { ReviewCandidate } from "../utils/types.js";
import { runReviewUnderLock, readCandidateUnderLock } from "./review-helpers.js";
import { checkCandidatePublication, checkAnswerPlan, isValidatedAnswer } from "./review-publication.js";
import { regenerateIndices } from "../dimensions/wiki/page-source-seam.js";

/** CLI/API options accepted by `review approve`. */
export interface ReviewApproveOptions {
  /** Required for connector candidates: sha256 printed by `review show`. */
  draftContentHash?: string;
}

/** Approve a pending candidate by promoting its body into wiki/concepts/. */
export default async function reviewApproveCommand(
  id: string,
  options: ReviewApproveOptions = {},
): Promise<void> {
  await runReviewUnderLock(id, (root, lockedId) => approveUnderLock(root, lockedId, options));
}

/**
 * Perform all wiki mutations for an approval while holding the lock.
 *
 * Re-reads the candidate under the lock so that a concurrent reject that ran
 * between the pre-lock fast-fail and lock acquisition is detected. Aborts with
 * exit code 1 if the candidate has disappeared. Page-body validation is routed
 * per target: DEFAULT candidates are gated by the title-requiring
 * {@link validateWikiPage} (in {@link routeDefaultPageWrite}); TYPED candidates
 * skip it and instead rely on {@link applyTypedCandidate}'s profile-aware
 * field-contract validation, since non-default entity types need not require a
 * `title`.
 */
async function approveUnderLock(
  root: string,
  id: string,
  options: ReviewApproveOptions,
): Promise<void> {
  const candidate = await readCandidateUnderLock(root, id);
  if (!candidate) return;
  if (!connectorPinMatches(candidate, options.draftContentHash)) {
    output.status(
      "!",
      output.error(
        "Candidate not approved: re-review required; body changed since you inspected it " +
          "or --draft-content-hash is missing.",
      ),
    );
    process.exitCode = 1;
    return;
  }
  if (!(await targetUnchangedSincePropose(root, candidate))) {
    output.status("!", output.error(staleTargetRefusal(candidate)));
    process.exitCode = 1;
    return;
  }
  if (!(await candidateNamespacesPermitApproval(root, id))) return;

  if (!await checkCandidatePublication(root, candidate)) return;
  const pagePath = await routeApprovedPageWrite(root, candidate, id);
  if (!pagePath) return;
  output.status("+", output.success(`Approved → ${output.source(pagePath)}`));

  // The source-state tail records the approved slug into the DEFAULT
  // `state.sources[file].concepts` list — a concepts-only structure with no
  // typed discrimination. A TYPED candidate must skip it (mirroring
  // routeApprovedPageWrite's typed/default branch) so a non-concept slug can
  // never pollute concepts state. Default candidates keep the existing path.
  if (!candidate.targetEntityType) {
    await persistCandidateSourceStates(root, candidate);
  }
  await refreshWikiAfterApproval(root, candidate);
  await deleteCandidate(root, id);
  output.status("✓", output.dim(`Candidate ${id} cleared.`));
}

/** Refuse an unavailable or ambiguous review store before the first live effect. */
async function candidateNamespacesPermitApproval(root: string, id: string): Promise<boolean> {
  try {
    await assertCandidateMutationAccess(root, false);
    return true;
  } catch (error) {
    if (!(error instanceof CandidateCustodyUnavailableError) &&
        !(error instanceof UnsafeCandidateDirError)) throw error;
    output.status("!", output.error(`Candidate ${id} not approved: candidate store unavailable.`));
    process.exitCode = 1;
    return false;
  }
}

/**
 * Explain a stale target precondition with the recovery that fits the candidate
 * class: a staged answer is regenerated and restaged, a lint fix is re-proposed.
 */
function staleTargetRefusal(candidate: ReviewCandidate): string {
  const changed = "Candidate not approved: the target page changed since this ";
  return isValidatedAnswer(candidate)
    ? `${changed}answer was staged. Regenerate and restage it with \`query --save --review\`, then reject this candidate.`
    : `${changed}fix was proposed. Re-run \`lint --fix-propose\` against the current page.`;
}

/**
 * Connector candidates require an external operator pin.
 *
 * The comparison re-hashes the under-lock candidate body and deliberately ignores
 * any stored `connectorProvenance.draftContentHash`, which is self-attested data.
 */
function connectorPinMatches(candidate: ReviewCandidate, supplied: string | undefined): boolean {
  if (!isConnectorCandidate(candidate)) return true;
  if (supplied === undefined) return false;
  return sha256Text(candidate.body) === supplied;
}

/**
 * The wiki path a candidate would land at — the SAME routing
 * {@link routeApprovedPageWrite} uses — so the stale-target guard inspects the
 * exact page the write will touch.
 */
function candidateTargetPath(root: string, candidate: ReviewCandidate): string {
  if (candidate.targetEntityType) {
    return path.join(root, "wiki", candidate.targetEntityType, `${candidate.slug}.md`);
  }
  const dir = candidate.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
  return path.join(root, dir, `${candidate.slug}.md`);
}

/**
 * A candidate that captured the target page's content at propose time (a
 * `lint --fix-propose` repair carries `expectedTargetHash`) is safe to write
 * only while the LIVE target still matches. If the page was edited — or removed —
 * since the proposal, a stale fix would clobber the newer content, so the write
 * is refused. Candidates with no expectation always pass; the caller's normal
 * create/overwrite path is unchanged for them.
 */
async function targetUnchangedSincePropose(root: string, candidate: ReviewCandidate): Promise<boolean> {
  // A CONTRADICTORY precondition — expecting the target both absent AND at a
  // specific digest — can never be honestly satisfied, so a candidate carrying
  // both (only a damaged or tampered one does) is refused outright rather than
  // letting the expect-absent branch recreate stale content over the digest.
  if (candidate.expectTargetAbsent && candidate.expectedTargetHash !== undefined) return false;
  if (candidate.expectTargetAbsent) {
    // The proposal expected NO page. Refuse if one now exists (created since the
    // proposal); allow only when it is still absent. Any read error other than
    // ENOENT is treated as "cannot confirm absent" and refused, fail-closed.
    try {
      await readFile(candidateTargetPath(root, candidate), "utf8");
      return false; // a page appeared since the proposal — do not overwrite it
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  if (candidate.expectedTargetHash === undefined) return true;
  let current: string;
  try {
    current = await readFile(candidateTargetPath(root, candidate), "utf8");
  } catch {
    return false; // the target the fix was built against is gone — refuse, do not recreate it
  }
  return sha256Text(current) === candidate.expectedTargetHash;
}

/**
 * Route the candidate's page write through the write planner/executor (CLP
 * Invariant 4) and return the ABSOLUTE page path it landed at, or `null` on a
 * refusal (exit code 1, candidate retained, nothing written).
 *
 * EVERY candidate routes through the default concepts/queries path now. The typed
 * leg (a `targetEntityType` candidate promoted through the profile-aware planner)
 * was removed with the profile system, so a candidate carrying that field can only
 * come from a pre-removal store and is refused rather than silently written as a
 * concept — see {@link refuseStaleTypedCandidate}.
 *
 * Runs under the ALREADY-HELD review lock (no nested-lock deadlock).
 */
async function routeApprovedPageWrite(
  root: string,
  candidate: ReviewCandidate,
  id: string,
): Promise<string | null> {
  if (candidate.targetEntityType) return refuseStaleTypedCandidate(candidate, id);
  return routeDefaultPageWrite(root, candidate, id);
}

/**
 * Refuse a candidate that still carries a `targetEntityType`.
 *
 * THE TYPED APPROVAL LEG WAS REMOVED WITH THE PROFILE SYSTEM. A candidate with
 * this field can only come from a store written by an earlier build, and there is
 * no longer a profile to validate it against, no entity namespace in `wiki.pages`
 * to hold it, and no typed planner to re-plan it. Writing it as a concept would
 * land the page under the wrong identity, so it is refused with the candidate
 * retained — the operator can reject it and regenerate.
 *
 * @param candidate - The stale typed candidate.
 * @param id - Its id, for the message.
 * @returns Always `null`, after reporting the refusal and setting exit code 1.
 */
function refuseStaleTypedCandidate(candidate: ReviewCandidate, id: string): null {
  output.status(
    "!",
    output.error(
      `Candidate ${id} not approved: it targets entity type "${candidate.targetEntityType}", ` +
        `and typed entity pages were removed. Reject it and regenerate against the default wiki.`,
    ),
  );
  process.exitCode = 1;
  return null;
}

/**
 * Route a DEFAULT candidate (no typed target) through the concepts/queries
 * planner exactly as before, preserving byte-for-byte parity. The
 * title-requiring {@link validateWikiPage} gate runs HERE — only for default
 * candidates — so a body that fails it is refused with the SAME message and exit
 * code 1 as before. `allowOverwrite` is true so re-approving upserts via
 * `update`. Returns the absolute `wiki/<dir>/<slug>.md` path on success, or
 * `null` on a failed validation / blocked plan.
 */
async function routeDefaultPageWrite(
  root: string,
  candidate: ReviewCandidate,
  id: string,
): Promise<string | null> {
  if (!validateWikiPage(candidate.body)) {
    output.status("!", output.error(`Candidate ${id} failed page validation; not approved.`));
    process.exitCode = 1;
    return null;
  }
  const directory = candidate.targetDirectory === "queries" ? "queries" : "concepts";
  const { planned } = await planPageMutation({
    root,
    target: { kind: "raw", directory, slug: candidate.slug },
    body: candidate.body,
    origin: "review",
    reviewRouted: false,
    allowOverwrite: true,
  });
  if (planned.length === 0) {
    output.status("!", output.error(`Candidate ${id} blocked by the write planner; not approved.`));
    process.exitCode = 1;
    return null;
  }
  if (!checkAnswerPlan(candidate, planned)) return null;
  // A Stack stores the page as a ROW. Without the seams the executor takes its file
  // branch and writes `wiki/concepts/<slug>.md` -- a file nothing reads, because the
  // corpus is `wiki.pages`. The seams are resolved here rather than threaded from the
  // caller so a CLI entry point stays free of the dimensions graph, exactly as
  // `sources/removal.ts` does for the delete path.
  return await withPageSeams(process.env, async (seams) => {
    await applyApprovedMutationsLocked(
      root, planned, pageStoreOptions(seams.sink, seams.remover, seams.transaction));
    return approvedPageLocation(root, candidate, seams.sink !== undefined);
  });
}

/**
 * Where the approved page actually landed, for the success line.
 *
 * ON A STACK THERE IS NO FILE, so returning `wiki/concepts/<slug>.md` would name a
 * path that was never written -- the CLI telling the operator something untrue. The
 * page's identity is the honest answer: `concepts/<slug>` is what `wiki.pages` keys
 * it by, and it is what a reader would use to find it.
 *
 * The file backend keeps its absolute path byte-for-byte, because that path is real
 * there and existing output may depend on it.
 *
 * @param root - Absolute project root.
 * @param candidate - The approved candidate.
 * @param storedAsRow - True when the page was stored as a row rather than a file.
 * @returns The file path for the file backend, or the row identity for a Stack.
 */
function approvedPageLocation(
  root: string,
  candidate: ReviewCandidate,
  storedAsRow: boolean,
): string {
  const namespace = candidate.targetDirectory === "queries" ? "queries" : "concepts";
  if (storedAsRow) return `${namespace}/${candidate.slug}`;
  const dir = namespace === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
  return path.join(root, dir, `${candidate.slug}.md`);
}

/**
 * Add the approved concept slug to each contributing source's live-concepts
 * list in state.json.
 *
 * State records only LIVE concepts: held/rejected concepts are never in state,
 * and approval adds exactly the approved slug. This prevents a rejected sibling
 * from leaking into state when its source's first held candidate is approved.
 *
 * Each approval immediately union-adds its own slug via addApprovedSlugToSourceState
 * (which reads current state, appends, and deduplicates). No deferral is needed:
 * the old "wait for last sibling" guard was a leftover from the snapshot-write model
 * and caused earlier-approved slugs to be silently dropped.
 */
async function persistCandidateSourceStates(
  root: string,
  candidate: ReviewCandidate,
): Promise<void> {
  const states = candidate.sourceStates;
  if (!states) return;
  for (const [sourceFile, candidateEntry] of Object.entries(states)) {
    await addApprovedSlugToSourceState(root, sourceFile, candidate.slug, candidateEntry.hash);
  }
}

/**
 * Merge the approved slug into a source's existing live-concepts list.
 * Reads the current state entry so any already-live concepts are preserved,
 * then appends the approved slug (deduplicating in case it is already present).
 */
async function addApprovedSlugToSourceState(
  root: string,
  sourceFile: string,
  approvedSlug: string,
  sourceHash: string,
): Promise<void> {
  // Read and write the SAME backend. Reading `state.json` while the compile
  // persists to rows would merge the approved slug into a file nothing loads, and
  // the next compile would re-derive the page as unapproved.
  const { status, state: currentState } = await readStateClassifiedFor(root);
  if (status === "too-new") return; // fail closed, as every sibling surface does
  const existing = currentState.sources[sourceFile];
  const concepts = existing?.concepts ?? [];
  const merged = Array.from(new Set([...concepts, approvedSlug]));
  await writeStateFor(root, {
    ...currentState,
    sources: {
      ...currentState.sources,
      [sourceFile]: { hash: sourceHash, concepts: merged, compiledAt: new Date().toISOString() },
    },
  });
}

/** Refresh interlinks, index, MOC, and embeddings after writing a candidate. */
async function refreshWikiAfterApproval(root: string, candidate: ReviewCandidate): Promise<void> {
  const { slug } = candidate;
  // approveUnderLock runs under the held project lock (runReviewUnderLock), so
  // this routes through the lock-free resolution seam.
  if (!isValidatedAnswer(candidate)) {
    // Seams, not bare root: on a Stack the pages live in rows, and a call without
    // them lists `wiki/<ns>` from disk (finding nothing) and writes repaired links
    // to files nothing reads. Both halves must address the SAME backend.
    await withPageSeams(process.env, async (seams) => {
      // The GATE OPTIONS are part of that same answer. Without them the link gate
      // judged this body against the pages the resolver had enumerated -- the
      // concept namespace -- so an approved link to a `queries` page was demoted on
      // this verb and kept when a compile wrote the identical body. The options are
      // built by the resolver's ONE construction, `linkGateOptions`, exactly as the
      // compile path asks for them; a second construction here would let the two
      // verbs drift apart again. No run totals exist on this path, so no sink.
      await resolveAndApplyLinks(
        root, [slug], [slug], seams.resolver, seams.sink, seams.remover, undefined,
        linkGateOptions(seams.content), seams.curatedLinks,
      );
      await repairAndApplyLinks(root, seams.content, seams.scan, seams.sink, seams.remover);
    });
  }
  await regenerateIndices(root, process.env);
  await safelyUpdateEmbeddings(root, candidatePageId(candidate));
}

/**
 * The qualified pageId of an approved candidate: a TYPED candidate lands under
 * its `targetEntityType` namespace; a DEFAULT candidate under `queries` (when
 * `targetDirectory` is queries) or `concepts`.
 */
function candidatePageId(candidate: ReviewCandidate): PageId {
  const namespace =
    candidate.targetEntityType ?? (candidate.targetDirectory === "queries" ? "queries" : "concepts");
  return qualifiedPageId(namespace, candidate.slug);
}

/**
 * Refresh the embeddings store without failing approval, DRAINING the durable
 * pending marker in the same pass.
 *
 * Routes through the SHARED {@link refreshEmbeddingsDrainingPending} so approving
 * a candidate also retries any page-ids a prior `compile --review` (or a
 * swallowed/crashed refresh) left pending — a review-only workflow would
 * otherwise accumulate pending ids that are never drained, leaving embeddings
 * stale indefinitely. The shared drain settles the marker per-id and is
 * non-fatal on a missing API key / transient provider error. Approval already
 * holds the review lock (runReviewUnderLock), so the lock-free Core is correct
 * (no nested-lock deadlock).
 */
async function safelyUpdateEmbeddings(root: string, pageId: PageId): Promise<void> {
  await refreshEmbeddingsDrainingPending(root, [pageId]);
}
