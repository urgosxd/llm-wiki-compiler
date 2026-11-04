/**
 * @file test/dimensions/kg-embedding-capture.ts
 * @description Decode the request an embeddings call actually made, so a suite
 * can assert the destination, the credential and the model instead of trusting
 * the layer that chose them.
 *
 * Shared by the suites that observe the vendored embeddings path: two copies of
 * this decoding would let one of them quietly read a different field. The
 * decoding itself lives in {@link capturedPost}, which the chat-side suites use
 * too — one decoder, so both sides are read the same way.
 *
 * The captured credential is whatever the caller passed, which is always a fake
 * in these suites; this helper never prints or logs it.
 */

import { capturedPost } from "./kg-request-capture.js";

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
  const { url, authorization, model } = capturedPost(call);
  return { url, authorization, model };
}
