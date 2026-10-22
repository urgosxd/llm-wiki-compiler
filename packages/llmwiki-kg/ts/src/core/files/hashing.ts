/**
 * @file packages/llmwiki-kg/ts/src/core/files/hashing.ts
 * @description Content hashing for upload idempotency.
 *
 * Split out of `core/files.ts` as its own unit because the digest is what makes
 * `unique_hash_per_stack` work: it is computed over raw bytes before any storage
 * path exists, so it has no dependency on the path or form concerns.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Hex SHA-256 digest of `data`.
 *
 * Python: `hashlib.sha256(data).hexdigest()`. The digest is over the raw bytes,
 * so it is what makes uploads idempotent (`unique_hash_per_stack`).
 */
export function computeSha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
