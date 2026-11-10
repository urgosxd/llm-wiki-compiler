/**
 * Query publication owns the existing mutation lock and the direct-save profile
 * gate. Only a fresh strict citation check can authorize writing the canonical
 * document, and the write is always a `wiki/queries/` page: there is no staging
 * destination, so a saved answer is published or refused, never held as a review
 * candidate. Refusals are answer-preserving results; actual persistence failures
 * propagate.
 */
import { CitationPublicationError, validateCitationPublication } from "../citations/answer-publication.js";
import type { AnswerCitationReport } from "../citations/answer-types.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { acquireMutationLockBlocking } from "../utils/mutation-lock.js";
import { releaseLock } from "../utils/lock.js";
import type { QueryResult } from "../utils/types.js";
import * as output from "../utils/output.js";
import { buildQueryDocument } from "./query-document.js";
import { slugify } from "../utils/markdown.js";
import { saveQueryPageLocked } from "./query-save.js";

interface QueryPublicationOptions {
  root: string;
  question: string;
  answer: string;
  save: boolean;
  document?: string;
  /**
   * Environment naming the Stack this publication belongs to; `process.env` when
   * omitted, which keeps the CLI caller (whose Stack IS the process) unchanged.
   *
   * The save below regenerates Stack-scoped indices, so a caller publishing on
   * behalf of a NAMED Stack must pass its own environment. Left out, the index is
   * rebuilt from the DEPLOYMENT's corpus while the page was written for the tenant.
   */
  env?: NodeJS.ProcessEnv;
}

type PublicationResult = Pick<QueryResult, "saved" | "publicationRefusal">;
type PublicationRefusal = NonNullable<QueryResult["publicationRefusal"]>;
let afterSaveGateForTest: (() => Promise<void>) | undefined;

/** Test-only seam after the under-lock save gate, before fresh citation resolution. */
export function setQuerySaveTestHookForTest(hook: (() => Promise<void>) | undefined): void {
  afterSaveGateForTest = hook;
}

/**
 * Refuse the direct `query --save` write in a project with a non-default profile.
 *
 * That condition can no longer hold: there is one fixed profile, so
 * `loadNonDefaultProfile` returns `undefined` for every project and this refusal
 * is unreachable. The saved-query write path was ALREADY trusted for a plain
 * project — the guard existed because a profile-enabled project's write routing
 * had not caught up — so direct saves working everywhere is the correct outcome,
 * not a regression.
 *
 * Kept rather than deleted so the shape of the gate stays visible if a second
 * profile authority ever returns.
 */
function profileRefusal(): PublicationResult {
  const message = "query --save (direct write) is disabled in profile-enabled projects "
    + "(the saved-query write path is not yet trust-routed there). Run without --save.";
  output.status("!", output.warn(message));
  return { publicationRefusal: { code: "profile-disabled", targets: [], message } };
}

/** Recover only validation failure; page/index/embedding/log writes are outside. */
async function checkCitations(root: string, document: string, targetSlug: string): Promise<
  { report: AnswerCitationReport } | { publicationRefusal: PublicationRefusal }
> {
  try {
    return { report: await validateCitationPublication(root, document, "direct", targetSlug) };
  } catch (error) {
    if (error instanceof CitationPublicationError) {
      return { publicationRefusal: { code: error.code, targets: error.targets, message: error.message } };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { publicationRefusal: { code: "unavailable", targets: [], message: `Answer publication refused: citation validation unavailable (${detail})` } };
  }
}

/** Publish on request only after the gates and fresh citations pass under one lock. */
export async function maybeSaveQueryPage(options: QueryPublicationOptions): Promise<PublicationResult> {
  const { root, question, answer, save } = options;
  if (!save) return {};
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    // The profile gate is the only refusal left in front of the write. With one
    // fixed profile it never fires, but it stays in front of the write rather than
    // behind it: publication is the wrong place to discover a routing gap.
    if (await loadNonDefaultProfile(root)) return profileRefusal();
    await afterSaveGateForTest?.();
    const document = options.document ?? buildQueryDocument(question, answer, new Date().toISOString()).document;
    const validation = await checkCitations(root, document, slugify(question));
    if ("publicationRefusal" in validation) return validation;
    return { saved: await saveQueryPageLocked(root, question, document, options.env) };
  } finally {
    await releaseLock(root);
  }
}
