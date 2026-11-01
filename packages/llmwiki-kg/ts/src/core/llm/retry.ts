/**
 * @file packages/llmwiki-kg/ts/src/core/llm/retry.ts
 * @description The provider retry policy: which failures are worth a second
 * attempt, and what a run that exhausts its budget reports.
 *
 * ## Why this exists
 *
 * Before this module, one provider failure meant one lost chunk, silently.
 * Measured on the `kg` dimension: with embeddings working and chat answering
 * 500, the ingest reported `kg:1 chunks, 0 entities` and committed a document
 * row with an empty graph. That is indistinguishable from "the document
 * contained nothing", so an operator could not tell an outage from a thin
 * corpus.
 *
 * Retrying is the first half of the fix; making the exhausted run loud is the
 * second. Neither is sufficient alone: retries without a terminal failure still
 * end in a silent empty graph, and a failure without retries throws a document
 * away over one transient response.
 *
 * ## Why the policy lives in the vendored core
 *
 * Both consumers need the same decision and disagree only about the outcome. The
 * dimension treats an exhausted run as fatal, because `prepare` throwing is what
 * makes the coordinator commit nothing. The vendored HTTP route keeps the
 * oracle's per-chunk tolerance, so it logs and continues. One policy, two
 * outcomes -- if each path carried its own copy, the two would drift and the
 * drift would be invisible.
 *
 * ## Why a non-LlmError is never retried
 *
 * A `TypeError` while parsing a provider response is a bug in this code, not a
 * bad day at the provider. Retrying it would spend the budget to reproduce the
 * bug and then report it as "provider unavailable", which points the operator at
 * the wrong system.
 */

import { LlmError } from "./errors.js";

/**
 * Total attempts for a transient failure: the first try plus two retries.
 *
 * A constant rather than an env var so the compiler and the vendored core cannot
 * disagree, and so a test can pin the number.
 */
export const TRANSIENT_ATTEMPTS = 3;

/** First backoff delay; doubles per attempt. */
export const TRANSIENT_BACKOFF_BASE_MS = 200;

/**
 * A run that exhausted its retry budget on a transient failure.
 *
 * Distinct from {@link LlmError} because the caller's response differs: an
 * `LlmError` is one failed request, while this is a decision that the provider
 * is unavailable. It keeps EVERY failure, because "3 attempts failed" without
 * the reasons is a number an operator cannot act on.
 */
export class ProviderUnavailableError extends Error {
  /** Every failure the run saw, oldest first. */
  readonly failures: readonly unknown[];

  /**
   * @param message - What the run failed to do, named in the caller's terms.
   * @param failures - Every failure the run saw, oldest first.
   */
  constructor(message: string, failures: readonly unknown[]) {
    // The FIRST failure is appended, not the last: it is the one that describes
    // the condition the provider was in when the run started, before retries had
    // a chance to change it. A caller that wants all of them reads `failures`.
    const cause = failures[0];
    const reason = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
    super(reason === "" ? message : `${message}: ${reason}`);
    this.name = "ProviderUnavailableError";
    this.failures = failures;
  }
}

/**
 * Whether a failure is worth retrying.
 *
 * Transient: no HTTP status at all (the request never completed -- DNS, TLS,
 * connection refused, abort), a rate limit, or a server-side error.
 *
 * Permanent: every other status (the provider understood and refused: a bad
 * credential, a malformed request, a missing model), and anything that is not an
 * {@link LlmError} (a bug here, not a provider condition).
 *
 * @param error - Whatever a provider call threw.
 * @returns True when a second attempt could plausibly succeed.
 */
export function isTransientProviderFailure(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false;
  // No status means the request never got an answer, which is the most
  // recoverable case there is.
  if (error.status === undefined) return true;
  if (error.status === 429) return true;
  return error.status >= 500;
}

/**
 * Delay before attempt `attempt`, with equal jitter.
 *
 * The jitter matters when many chunks are extracted at once: a deterministic
 * delay would make every chunk retry in lockstep after a shared rate limit,
 * which reproduces the burst that tripped the limiter.
 *
 * @param attempt - Zero-based retry index (0 for the wait before the 2nd try).
 * @returns Milliseconds to wait, in `[base/2, base]` of the exponential step.
 */
function backoffMs(attempt: number): number {
  const step = TRANSIENT_BACKOFF_BASE_MS * Math.pow(2, attempt);
  return Math.round(step / 2 + Math.random() * (step / 2));
}

/** Real waiting; injectable so a test never spends wall time. */
async function realSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Options for {@link withProviderRetry}. */
export interface ProviderRetryOptions {
  /** Replaces the real timer; tests pass a recording stub. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `work`, retrying transient failures up to {@link TRANSIENT_ATTEMPTS}.
 *
 * @param work - One provider call.
 * @param options - Optional sleep override.
 * @returns Whatever `work` resolved with.
 * @throws {ProviderUnavailableError} When every attempt failed transiently.
 * @throws The original error, unwrapped, when the failure is permanent.
 */
export async function withProviderRetry<T>(
  work: () => Promise<T>,
  options: ProviderRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? realSleep;
  const failures: unknown[] = [];

  for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      failures.push(error);
      // A permanent failure is rethrown as-is: wrapping it would hide that the
      // answer will never change, which is the one thing the caller must know.
      if (!isTransientProviderFailure(error)) throw error;
      const isLastAttempt = attempt === TRANSIENT_ATTEMPTS - 1;
      if (isLastAttempt) break;
      await sleep(backoffMs(attempt));
    }
  }

  const last = failures.at(-1);
  const reason = last instanceof Error ? last.message : String(last);
  throw new ProviderUnavailableError(
    `provider unavailable after ${TRANSIENT_ATTEMPTS} attempts: ${reason}`,
    failures,
  );
}
