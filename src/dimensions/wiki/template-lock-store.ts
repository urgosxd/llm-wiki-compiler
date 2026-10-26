/**
 * @file src/dimensions/wiki/template-lock-store.ts
 * @description The advisory template provenance lock, one row per Stack.
 *
 * ## What this is, and what it is not
 *
 * `src/profile/templates/lock.ts` says it plainly: "Locks help status/update locate
 * releases but never authorize runtime behavior." Nothing gates on this document's
 * presence, and a forged value cannot grant anything -- the SIGNED package carries the
 * authority, and this records which release was chosen. Moving it to a row therefore
 * relocates a cache; it does not weaken an authorization boundary.
 *
 * ## Why the document is stored whole
 *
 * `parseTemplateLock` already owns the exact-key and per-schema-version rules (v1 vs v2,
 * the optional `remote` block). Storing the document it produced keeps ONE validator:
 * widening the table into columns would force this store to re-derive those rules, and
 * two implementations of one validation contract drift -- the defect this migration has
 * hit repeatedly.
 *
 * ## Why the digest is stored but not trusted
 *
 * `profile-store.ts` sets the same precedent: the digest makes it possible for a caller
 * to bind to the document it verified against, and recomputing on read would make a
 * tampered row a load error. Here the digest is informational only -- the lock is not
 * authoritative -- so a mismatch is left to the parser, which is stricter anyway.
 */

import type { Database } from "llmwiki-kg";
import { readDocumentRow, saveDocumentRow, type StoredDocumentRow } from "./document-store.js";

/** One Stack's stored advisory lock document. */
export type StoredTemplateLockRow = StoredDocumentRow;

/**
 * Store one Stack's advisory lock, replacing whatever was there.
 *
 * An upsert because a project has ONE installed template: installing or updating
 * replaces the answer rather than accumulating versions. Two locks for one Stack is not
 * a state the file backend could ever represent.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose lock this is.
 * @param document - The lock document `buildTemplateLock` produced.
 * @param digest - Its content address.
 */
export async function saveTemplateLock(
  db: Database,
  stackId: string,
  document: unknown,
  digest: string,
): Promise<void> {
  await saveDocumentRow(db, "template_lock", stackId, document, digest);
}

/**
 * Read one Stack's advisory lock, or undefined when it has none.
 *
 * Undefined means "no template installed", which is the same answer the file backend
 * gives for an absent file -- and the caller distinguishes it from `malformed` for the
 * same reason the file reader does: a fault must never masquerade as a missing lock.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose lock to read.
 * @returns The stored document and digest, or undefined when absent.
 */
export async function readTemplateLockRow(
  db: Database,
  stackId: string,
): Promise<StoredTemplateLockRow | undefined> {
  return readDocumentRow(db, "template_lock", stackId);
}
