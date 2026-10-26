/**
 * @file src/dimensions/wiki/candidate-source.ts
 * @description The review-candidate seam: rows for a Stack, files for a project.
 *
 * ## Why a seam rather than a rewrite of every caller
 *
 * Twenty-one modules read and write candidates through `candidate-read.ts` and
 * `candidates.ts`. Changing those signatures would have touched every one of them to
 * move a single storage decision, so the decision lives HERE instead: the read and
 * write modules resolve which backend answers, and callers keep their shape.
 *
 * ## Why the handle is opened per call, not threaded
 *
 * The candidate call sites are scattered across review commands, import paths, the
 * viewer and the trust layer. None of them owns a database handle, and threading one
 * through would change twenty signatures to move one lookup. Opening and closing per
 * call costs a connection and keeps every caller unchanged.
 *
 * ## Why absence is a distinct answer from failure
 *
 * A Stack that has never staged a candidate is not an error, and a Stack whose rows
 * cannot be read is not an empty queue. Collapsing the two would make a broken
 * connection look like "nothing pending", and a reviewer would see an empty queue
 * instead of a fault.
 */

import { createDimensionsDatabase, AKS_STACK_ID_ENV_VAR } from "../activation.js";
import type { Database } from "llmwiki-kg";
import {
  deleteStoredCandidate,
  getStoredCandidate,
  listStoredCandidates,
  saveStoredCandidate,
} from "./candidate-store.js";
import type { ReviewCandidate } from "../../utils/types.js";

/**
 * Read, list, write and delete one Stack's candidates.
 *
 * Every method is scoped to the Stack the handle was opened for, so a caller cannot
 * accidentally read another tenant's queue by passing the wrong root.
 */
export interface CandidateRowsSource {
  /** Every pending candidate, newest-first. */
  list(): Promise<ReviewCandidate[]>;
  /** One candidate by id, or undefined when this Stack has none. */
  get(candidateId: string): Promise<ReviewCandidate | undefined>;
  /** Store one candidate, replacing any candidate with the same id. */
  save(candidate: ReviewCandidate): Promise<void>;
  /** Remove one candidate, reporting whether a row was actually removed. */
  remove(candidateId: string): Promise<boolean>;
}

/** The Stack this run is bound to, or undefined when the environment names none. */
function candidateStackId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  return stackId === "" ? undefined : stackId;
}

/**
 * Build the row source for an open handle.
 *
 * @param db - Database handle, already scoped by the caller.
 * @param stackId - The Stack whose queue this source answers for.
 * @returns A source the read and write modules can use interchangeably.
 */
function candidateRowsSource(db: Database, stackId: string): CandidateRowsSource {
  return {
    list: () => listStoredCandidates(db, stackId),
    get: (candidateId) => getStoredCandidate(db, stackId, candidateId),
    save: (candidate) => saveStoredCandidate(db, stackId, candidate),
    remove: (candidateId) => deleteStoredCandidate(db, stackId, candidateId),
  };
}

/**
 * Run `fn` against the candidate rows source for this environment.
 *
 * Returns `undefined` to `fn` when no Stack is configured, which is what keeps every
 * existing file-backed caller byte-identical. The handle is closed before returning,
 * whatever `fn` does.
 *
 * @param env - Environment to read the Stack from.
 * @param fn - Receives the row source, or `undefined` to keep using `.llmwiki/candidates`.
 * @returns Whatever `fn` returns.
 */
export async function withCandidateSource<T>(
  env: NodeJS.ProcessEnv,
  fn: (source: CandidateRowsSource | undefined) => Promise<T>,
): Promise<T> {
  const stackId = candidateStackId(env);
  if (stackId === undefined) return fn(undefined);
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    return await fn(candidateRowsSource(dimensionsDb.db, stackId));
  } finally {
    await dimensionsDb.close();
  }
}
