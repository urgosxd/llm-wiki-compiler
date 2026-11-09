/**
 * @file src/dimensions/wiki/idempotency.ts
 * @description The wiki's idempotency key, defined once for both backends.
 *
 * ## Why this is shared rather than written twice
 *
 * Both wiki implementations — the filesystem one in `index.ts` and the database one
 * in `store-dimension.ts` — report a `CommittedWrite.idempotencyKey`, and the
 * coordinator uses that key to decide whether an outbox replay is a no-op. Two
 * copies that drifted by a single character would mean a replay against the other
 * backend looked like NEW work, producing a duplicate write in exactly the
 * circumstance the key exists to prevent.
 *
 * The key is derived from the source AND a digest of the document, because either
 * half alone is wrong: keying on the source alone would treat changed content as
 * already-written, and keying on the document alone would let one source's new
 * body look like a different source's write.
 */

import { createHash } from "node:crypto";

import type { DimensionInput } from "../types.js";

/** Length of the hex digest kept from the SHA-256. */
const KEY_DIGEST_CHARS = 32;

/**
 * Deterministic identity of a wiki write.
 *
 * Re-ingesting identical content yields the same key, which is what makes an
 * outbox replay a no-op instead of a second write.
 *
 * @param input - The write being performed.
 * @returns The idempotency key.
 */
export function wikiIdempotencyKey(input: DimensionInput): string {
  const digest = createHash("sha256")
    .update(input.source)
    .update("\u0000")
    .update(input.document)
    .digest("hex")
    .slice(0, KEY_DIGEST_CHARS);
  return `wiki:${digest}`;
}
