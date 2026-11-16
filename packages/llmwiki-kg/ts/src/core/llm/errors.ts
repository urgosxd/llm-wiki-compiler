/**
 * @file packages/llmwiki-kg/ts/src/core/llm/errors.ts
 * @description The single failure type every provider path raises.
 *
 * Split out of `core/llm_clients.ts` as its own unit so the transport, endpoint
 * and response-parsing modules can all throw the same identifiable error without
 * importing each other.
 */

/**
 * Failure from an LLM provider.
 *
 * Python lets the SDK's own exception escape. A dedicated error type keeps the
 * provider, the endpoint and the status available to the caller while making
 * the failure identifiable, which the route layer needs in order to answer 500
 * rather than crashing the process with an unhandled rejection.
 */
export class LlmError extends Error {
  /** HTTP status the provider answered with, when it answered at all. */
  readonly status: number | undefined;
  /** Endpoint that was called, for the error log. */
  readonly endpoint: string;

  constructor(message: string, endpoint: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

/**
 * Status for a completion whose output budget ran out before any answer.
 *
 * `502 Bad Gateway` because the failure is upstream's unusable response, not the
 * caller's request: the provider answered 200 and billed the tokens, but what it
 * produced is an empty completion. It also keeps the budget failure out of the
 * opaque 5xx class, so a caller can tell it from an outage.
 */
export const BUDGET_EXHAUSTED_STATUS = 502;

/**
 * Caller-facing text for {@link BUDGET_EXHAUSTED_STATUS}.
 *
 * Deliberately free of the endpoint and of any provider payload: it names the
 * cause and the operator action, and nothing about where the request went or
 * what the deployment is configured with.
 */
export const BUDGET_EXHAUSTED_DETAIL =
  'LLM output budget exhausted before the model answered (finish_reason: "length"); the configured output budget is too small for this model.';

/**
 * The provider stopped on `max_tokens` before writing any answer.
 *
 * A reasoning model spends tokens BEFORE it answers, so a budget sized for the
 * answer alone comes back empty with `finish_reason: "length"` on a healthy HTTP
 * 200. Measured against OpenRouter with a realistic 8.3 kB extraction prompt: 0
 * of 8 usable at 1024, 8 of 8 at 4096 with at most 748 reasoning tokens.
 *
 * That is a configuration defect, not an outage, so it carries an explicit
 * status and a fixed detail instead of the status-less {@link LlmError} whose
 * default became an opaque 500. `content: null` WITHOUT the truncation finish
 * reason stays a plain {@link LlmError}: unknown is still unknown.
 */
export class LlmBudgetExhaustedError extends LlmError {
  constructor(endpoint: string, budget: number | undefined) {
    super(truncationMessage(endpoint, budget), endpoint, BUDGET_EXHAUSTED_STATUS);
    this.name = "LlmBudgetExhaustedError";
  }
}

/** Log line for a truncated completion, naming the budget that ran out. */
function truncationMessage(endpoint: string, budget: number | undefined): string {
  const limit = budget === undefined ? "max_tokens" : `max_tokens=${String(budget)}`;
  return `${endpoint} exhausted its output budget before answering (${limit}, finish_reason: "length")`;
}
