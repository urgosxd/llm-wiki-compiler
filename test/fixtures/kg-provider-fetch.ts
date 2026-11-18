/**
 * @file test/fixtures/kg-provider-fetch.ts
 * @description The provider edge for the wiki-side suites that drive the kg dimension: one
 * `fetch` stub that RECORDS every request it is asked for and SERVES the crafted extraction
 * this branch's S2 anchor was measured with.
 *
 * ## Why the request counts live at the wire instead of in a KG counter
 *
 * `@repo/kg/core/extraction-harness` was the obvious counter, and a wiki-side suite may not
 * hold it: `no-restricted-imports` forbids `wiki → kg` for `test/**` exactly as it does for
 * `packages/wiki/**`, and `scripts/lint-ratchet.ts` accepts no new allowance for a file
 * whose rules have not moved — so the import had to STOP, not be allowed.
 *
 * Nothing is lost by counting at `fetch`: it is the cut the vendored clients actually make,
 * so these numbers are what the provider was asked for, and the URL says WHICH service was
 * asked — a fact no counter offered. The two predicates are the ones the vendored harness
 * used, so "one chat completion per chunk" and "one embedding batch per document" keep
 * meaning exactly what they meant.
 *
 * ## Why the stub also ANSWERS, and with this exact payload
 *
 * A stub that only counted would fail every run it measures, so it serves the same JSON the
 * vendored harness served: one `KGSchema` tool call carrying one triplet between two
 * entities plus one standalone entity. {@link KG_EXTRACTION_PAYLOAD} is that payload, and
 * it lives here rather than in each suite because the S2 anchor (`graphHash`
 * `99cbdad5…f46d30c`) was measured with it: one copy is what keeps three suites from
 * drifting into three different graphs.
 *
 * ## Why nothing here is a `vi.mock`
 *
 * `vi.stubGlobal` replaces the network and nothing else. The real chunker, prompt, tool
 * schema, parser, consolidation SQL and foreign keys all still run, which is the one cut
 * that leaves the behaviour under test intact.
 */

import { vi } from "vitest";

/** One request the stubbed provider edge saw, in call order. */
export interface CapturedKgRequest {
  /** Absolute URL the client posted to. */
  readonly url: string;
  /** The JSON body it posted, already parsed. */
  readonly body: Record<string, unknown>;
}

/** The path a chat completion is posted to, as the vendored client spells it. */
const CHAT_COMPLETIONS_PATH = "/chat/completions";

/** The path an embedding batch is posted to. */
const EMBEDDINGS_PATH = "/embeddings";

/** Width of the vectors served here: the kg column stores 768-wide embeddings. */
const EMBEDDING_DIM = 768;

/**
 * The extraction every chat request is answered with: the fixture the S2 anchor pins.
 *
 * A triplet between two `TECHNOLOGY` entities plus one standalone `CONCEPT`. Consolidation
 * collapses the repeated responses into the same entities and the same edge, so the graph
 * hash depends on this payload and the chunk count, never on how many chunks were asked.
 */
export const KG_EXTRACTION_PAYLOAD = {
  triplets: [
    {
      subject: { name: "Gateway", type: "TECHNOLOGY" },
      relation: { type: "USES" },
      object: { name: "Nomic Embed", type: "TECHNOLOGY" },
    },
  ],
  entities: [{ name: "Rate Limiting", type: "CONCEPT" }],
};

/** Every request the stub has seen since the last {@link clearCapturedRequests}. */
const captured: CapturedKgRequest[] = [];

/**
 * The live capture, in call order.
 *
 * Returned rather than copied so a caller can take a length before a run and read the
 * entries a run appended — the same shape the mutation-lock spans are handed to the
 * measurement instrument in.
 *
 * @returns The array the stub appends to; the caller must not mutate it.
 */
export function capturedRequests(): readonly CapturedKgRequest[] {
  return captured;
}

/**
 * Empty the capture, leaving the stub installed.
 *
 * So a suite can assert an ABSOLUTE zero — `expect(chatRequestCount()).toBe(0)` — instead
 * of a delta that arithmetic could turn green around a real request.
 */
export function clearCapturedRequests(): void {
  captured.length = 0;
}

/**
 * Whether one captured request is a chat completion.
 *
 * @param entry - One recorded request.
 * @returns True when the URL ends in the chat-completions path.
 */
export function isChatCompletionRequest(entry: CapturedKgRequest): boolean {
  return entry.url.endsWith(CHAT_COMPLETIONS_PATH);
}

/**
 * Whether one captured request is an embedding batch.
 *
 * @param entry - One recorded request.
 * @returns True when the URL ends in the embeddings path.
 */
export function isEmbeddingRequest(entry: CapturedKgRequest): boolean {
  return entry.url.endsWith(EMBEDDINGS_PATH);
}

/**
 * How many chat completions the provider was asked for since the capture was cleared.
 *
 * @returns The count extraction spent: one per chunk, sequentially.
 */
export function chatRequestCount(): number {
  return captured.filter(isChatCompletionRequest).length;
}

/**
 * How many embedding batches the provider was asked for since the capture was cleared.
 *
 * @returns The count chunking spent: the whole chunk list in one round trip.
 */
export function embeddingRequestCount(): number {
  return captured.filter(isEmbeddingRequest).length;
}

/**
 * Install the recording, answering provider edge as this file's `fetch`.
 *
 * The whole surface of a run that must cost nothing is that no entry appears in the
 * capture, so the stub never fails a request it does not expect: it answers 404, which the
 * clients surface as an error instead of a graph built from nothing.
 */
export function installKgProviderStub(): void {
  vi.stubGlobal("fetch", kgProviderFetch);
}

/** Put the process's own `fetch` back, so a suite leaves the global as it found it. */
export function uninstallKgProviderStub(): void {
  vi.unstubAllGlobals();
}

/**
 * The stubbed `fetch`: record the request, then answer it.
 *
 * @param input - URL or `Request` the client posted to.
 * @param init - Request options, carrying the JSON body.
 * @returns The provider's answer, shaped as the vendored readers expect.
 */
async function kgProviderFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const rawBody = typeof init?.body === "string" ? init.body : "{}";
  const body = JSON.parse(rawBody) as Record<string, unknown>;
  captured.push({ url, body });
  if (url.endsWith(EMBEDDINGS_PATH)) return jsonResponse({ data: embeddingsFor(body) });
  if (url.endsWith(CHAT_COMPLETIONS_PATH)) return jsonResponse(extractionResponse());
  return jsonResponse({ error: { message: `unexpected url ${url}` } }, 404);
}

/**
 * One vector per input text, so the batch answers exactly what was asked.
 *
 * @param body - The embedding request body.
 * @returns The `data` array the client reads vectors out of.
 */
function embeddingsFor(body: Record<string, unknown>): unknown[] {
  const inputs = (body["input"] as unknown[] | undefined) ?? [];
  return inputs.map((_, index) => ({ index, embedding: fakeVector() }));
}

/**
 * A deterministic 768-wide vector.
 *
 * @returns The embedding the client stores; the values are irrelevant, the width is not.
 */
function fakeVector(): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, index) => (index % 7) / 7);
}

/**
 * The answer to a chat completion: the extraction payload as a single tool call.
 *
 * @returns The OpenAI-compatible completion body the KG client parses.
 */
function extractionResponse(): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              type: "function",
              function: {
                name: "KGSchema",
                arguments: JSON.stringify(KG_EXTRACTION_PAYLOAD),
              },
            },
          ],
        },
      },
    ],
  };
}

/**
 * A JSON response, shaped the way the vendored readers expect.
 *
 * @param body - Payload to serialise.
 * @param status - HTTP status; 200 unless a case is being refused.
 * @returns The `Response` the client sees.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
