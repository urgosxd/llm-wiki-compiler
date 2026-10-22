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
