/**
 * @file test/dimensions/kg-request-capture.ts
 * @description Decode a captured provider POST — URL, credential, model — and
 * build the well-formed answers the vendored readers accept, so a suite asserts
 * the destination and the payload instead of trusting the layer that chose them.
 *
 * Shared by the suites that observe the same request path: two copies of this
 * decoding would let one of them quietly read a different field, which is
 * exactly the defect (a crossed host) these suites exist to catch.
 *
 * The captured credential is whatever the caller passed, which is always a fake
 * in these suites; this helper never prints or logs it.
 */

import type { MockInstance } from "vitest";

/**
 * The `fetch` spy type the host-observation suites install.
 *
 * Declared from what `vi.spyOn(globalThis, "fetch")` actually returns. The
 * generic `ReturnType<typeof vi.spyOn>` erases the signature to
 * `(this: unknown, ...args: unknown[]) => unknown`, which the real spy is NOT
 * assignable to, so a variable annotated that way cannot hold the spy at all.
 * One declaration, so the four suites that install the same spy cannot drift.
 */
export type FetchSpy = MockInstance<typeof globalThis.fetch>;

/** The tool `callTool` is asked to force, named so one payload fits every case. */
export const TOOL_NAME = "KGSchema";

/** The parts of a provider request under test. */
export interface CapturedRequest {
  readonly url: string;
  /** `Authorization` header, as an OpenAI-compatible endpoint receives it. */
  readonly authorization: string;
  /** `x-api-key` header, as an Anthropic endpoint receives it. */
  readonly apiKeyHeader: string;
  /** The `model` field of the JSON body. */
  readonly model: unknown;
}

/**
 * Decode one `fetch` spy call: `[url, init]`.
 *
 * @param call - One recorded call of the `fetch` spy.
 * @returns The destination, both credential headers and the requested model.
 */
export function capturedPost(call: unknown[]): CapturedRequest {
  const [url, init] = call as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  return {
    url,
    authorization: headers["authorization"] ?? "",
    apiKeyHeader: headers["x-api-key"] ?? "",
    model: body["model"],
  };
}

/**
 * A well-formed tool-call answer, in BOTH provider shapes.
 *
 * Carries an OpenAI `tool_calls` array and an Anthropic `tool_use` block,
 * because suites exercise both paths and the stub is about the destination, not
 * about which reader answers.
 *
 * @returns A 200 response the vendored tool readers accept.
 */
export function toolCallPayload(): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "tool_use", name: TOOL_NAME, input: {} }],
      choices: [
        { message: { tool_calls: [{ type: "function", function: { arguments: "{}" } }] } },
      ],
    }),
    { status: 200 },
  );
}

/**
 * A well-formed embeddings answer, so an embedding call reaches its return path.
 *
 * @returns A 200 response the vendored embeddings reader accepts.
 */
export function embeddingsPayload(): Response {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), {
    status: 200,
  });
}
