/**
 * @file src/dimensions/wiki/profile-store.ts
 * @description The project profile, one row per Stack.
 *
 * ## What a profile is here
 *
 * Nested configuration (entities, tags, workflow actions, governance) that
 * `validateProfile` already checks and `profileDigest` already content-addresses. The
 * row holds the validated document rather than a column per field, so a profile
 * schema change is a validator change and not a migration, and the table can never
 * disagree with the validator about what is legal.
 *
 * ## Why the digest is stored AND rechecked
 *
 * `activeProfileDigest` exists so a projection can bind to the profile it verified
 * against. Storing the digest makes that check possible; recomputing it on read makes
 * a tampered row a load error rather than a silently different authority. Both, not
 * either: storing alone trusts the row, recomputing alone cannot tell a caller which
 * profile they had.
 */

import type { Database } from "llmwiki-kg";
import { readDocumentRow, saveDocumentRow, type StoredDocumentRow } from "./document-store.js";

/** One Stack's stored profile document. */
export type StoredProfileRow = StoredDocumentRow;

/**
 * Store one Stack's profile, replacing whatever was there.
 *
 * An upsert because a profile update is a REPLACEMENT of project configuration, not
 * an accumulation: two profiles for one Stack is not a state the file ever had.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose profile this is.
 * @param document - The validated profile document.
 * @param digest - Its content address.
 */
export async function saveProfile(
  db: Database,
  stackId: string,
  document: unknown,
  digest: string,
): Promise<void> {
  await saveDocumentRow(db, "profile", stackId, document, digest);
}

/**
 * Read one Stack's profile, or undefined when it has none.
 *
 * Undefined means "no profile installed", which is the same answer the file backend
 * gives for an absent file: the caller then yields the built-in default. It is NOT an
 * error, and must stay distinguishable from one.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose profile to read.
 * @returns The stored document and digest, or undefined when absent.
 */
export async function readProfile(
  db: Database,
  stackId: string,
): Promise<StoredProfileRow | undefined> {
  return readDocumentRow(db, "profile", stackId);
}
