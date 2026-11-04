/**
 * @file test/dimensions/kg-embedding-capture.ts
 * @description Decode the request an embeddings call actually made, so a suite
 * can assert the destination, the credential and the model instead of trusting
 * the layer that chose them.
 *
 * Shared by the suites that observe the vendored request path: two copies of
 * this decoding would let one of them quietly read a different field.
 *
 * The captured credential is whatever the caller passed, which is always a fake
 * in these suites; this helper never prints or logs it.
 */

/**
 * The parts of an embeddings request under test.
 *
 * @param call - One `fetch` spy call: `[url, init]`.
 * @returns The URL, the `authorization` header and the requested model.
 */
export function capturedEmbeddingRequest(call: unknown[]): {
  url: string;
  authorization: string;
  model: unknown;
} {
  const [url, init] = call as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  return { url, authorization: headers["authorization"] ?? "", model: body["model"] };
}
