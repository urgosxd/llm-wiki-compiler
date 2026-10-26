/**
 * @file src/artifacts/resolve-rows.ts
 * @description The READ-side health verdict for a ROW-backed artifact bundle.
 *
 * ## Why this is a parallel resolver rather than a branch inside `resolve.ts`
 *
 * `resolve.ts` produces its verdict by OPENING FILES: `openConfinedLeaf`, capped
 * buffers, a directory sweep. The row backend has no leaf and no directory, so every
 * one of those reads is replaced — but the VERDICT VOCABULARY must not change, because
 * `artifact-dangling` is a lint rule, a write-time precondition, an MCP response and a
 * workflow gate. A branch inside the existing resolver would have had to re-derive that
 * vocabulary in the middle of filesystem code; a parallel module keeps both sides
 * readable and lets the shared validators do the work.
 *
 * ## What is SHARED, not reimplemented
 *
 * `manifestIntegrityLie`, `verifyOkBody` and `withManifest` are imported from
 * `resolve.ts`, and `parseManifest` / `parseMemberEntries` / `hashMemberBytes` from
 * `store.ts` and `members.ts`. Those ARE the contract: an identity lie must be refused
 * identically on both backends, and the body validators must run the same rules, or the
 * write and read sides drift. Only the OBSERVATION changes — rows instead of bytes.
 *
 * ## The property that changes shape
 *
 * The file store proved "the bundle is exactly this set of leaves" by LISTING a
 * directory twice (once for the shape, once for the bytes), because a directory is a
 * shared, mutable namespace. A row set is closed by its keys, so the sweep becomes a set
 * comparison between the manifest's rows and the stored member rows. The two health
 * codes survive unchanged:
 *
 *  - a manifest row with no stored member  -> `artifact-dangling`
 *  - a stored member the manifest omits    -> `artifact-bytes-tampered`
 *
 * The second keeps `bytes-tampered` rather than inventing a code, matching the file
 * path exactly: `sweepHealth` reports an unexpected entry as `artifact-bytes-tampered`.
 *
 * ## What is deliberately GONE
 *
 * `ArtifactMemberAliasCollisionError` and the `memberAliasKey` folding have no row
 * analogue and are not reproduced. That guard existed because a case-insensitive
 * filesystem makes `A.md` and `a.md` ONE physical file, so writing the new spelling and
 * unlinking the old would delete what was just written. `wiki.artifact_member` is keyed
 * by the literal `file_name` under the database collation, so two spellings are two
 * rows. The hazard is unrepresentable rather than guarded.
 */

import type { ProfilePack, ArtifactTypeDef } from "../profile/types.js";
import type { ArtifactRef } from "./ref.js";
import { readArtifact, type StoredArtifact } from "../dimensions/wiki/artifact-store.js";
import { parseManifest, type ArtifactManifest } from "./store.js";
import { hashMemberBytes, parseMemberEntries } from "./members.js";
import {
  manifestIntegrityLie, verifyOkBody,
  type ArtifactHealth, type VerifiedArtifactRead,
} from "./resolve.js";

/**
 * Verify one stored member row against ITS manifest row.
 *
 * The byte count is compared before the digest because it is the cheaper check and
 * because a length divergence is unambiguous — the same order the file path uses.
 *
 * @param entry - The manifest's recorded member: name, length and digest.
 * @param stored - The member row as persisted; its bytes are compared in full.
 * @returns The failing health, or null when this member verifies.
 */
function memberRowHealth(
  entry: { fileName: string; bytes: number; sha256: string },
  stored: { bytes: Uint8Array } | undefined,
): ArtifactHealth | null {
  if (stored === undefined) return "artifact-dangling";
  if (stored.bytes.byteLength !== entry.bytes) return "artifact-bytes-tampered";
  if (hashMemberBytes(stored.bytes) !== entry.sha256) return "artifact-bytes-tampered";
  return null;
}

/**
 * Compare the manifest's member rows against the stored member rows, BOTH WAYS.
 *
 * A missing row is `dangling` (the bundle lost a leaf it promises); an extra row is
 * `bytes-tampered` (the bundle holds something the manifest does not account for —
 * exactly what a file-store directory sweep reports for an unexpected entry). Without
 * the second direction a shrink would silently leave a stale member behind and still
 * verify `ok`, which is the property the whole "replace, do not merge" rule exists for.
 *
 * @param body - The verified manifest body carrying the member rows.
 * @param stored - The bundle as read, including ordered member rows.
 * @returns The first failing health, or null when the sets agree and every member matches.
 */
function memberRowsHealth(body: string, stored: StoredArtifact): ArtifactHealth | null {
  const entries = parseMemberEntries(body);
  if (entries === null) return "artifact-schema-invalid"; // unreachable behind the body contract; fail closed
  const byName = new Map(stored.members.map((member) => [member.fileName, member] as const));
  const promised = new Set(entries.map((entry) => entry.fileName));
  for (const member of stored.members) {
    if (!promised.has(member.fileName)) return "artifact-bytes-tampered";
  }
  for (const entry of entries) {
    const health = memberRowHealth(entry, byName.get(entry.fileName));
    if (health !== null) return health;
  }
  return null;
}

/**
 * Resolve a hash-pinned ref against a ROW-backed bundle, producing the same verdict
 * vocabulary as the file resolver.
 *
 * The order of checks mirrors `readVerifiedArtifact` exactly, because the order is
 * itself part of the contract: the integrity-lie check runs BEFORE any readability
 * check so an unreadable body can never launder an identity lie into a park.
 *
 * @param db - Database handle.
 * @param profile - The active profile, which declares the artifact type.
 * @param ref - The pinned ref to verify.
 * @returns The resolution plus the verified body ONLY when the verdict is `ok`.
 */
export async function readVerifiedArtifactFromRows(
  db: never,
  stackId: string,
  profile: Pick<ProfilePack, "artifacts">,
  ref: ArtifactRef,
): Promise<VerifiedArtifactRead> {
  const def = declaredArtifact(profile, ref.artifactType);
  if (!def) return { health: "artifact-dangling" };
  const stored = await readArtifact(db, stackId, ref.artifactType, ref.slug);
  if (stored === undefined) return { health: "artifact-dangling" };
  const manifest = parseManifest(stored.manifest) ?? undefined;
  const lie = manifest === undefined ? undefined : manifestIntegrityLie(def, ref, manifest);
  if (lie) return lie;
  if (manifest === undefined) return { health: "artifact-store-unavailable", storeFault: "genuine-fault" };
  return verdictForStored(def, ref, manifest, stored);
}

/**
 * The body-and-member verdict once a parsed manifest is in hand.
 *
 * Split from {@link readVerifiedArtifactFromRows} so the manifest handling stays
 * linear and this function owns only the byte comparison.
 *
 * @param def - The declared artifact type, carrying the size and member ceilings.
 * @param ref - The pinned ref.
 * @param manifest - The manifest parsed from the stored document.
 * @param stored - The bundle body and member rows.
 * @returns The verdict, carrying the body only when it verifies.
 */
function verdictForStored(
  def: ArtifactTypeDef, ref: ArtifactRef, manifest: ArtifactManifest, stored: StoredArtifact,
): VerifiedArtifactRead {
  const body = stored.bundle.body;
  const verdict = verifyOkBody(def, ref, manifest, body);
  if (verdict.health !== "ok") return { ...verdict, manifest };
  // An over-cap body cannot reach here honestly: the write path refuses it. A stored
  // body past the CURRENT (possibly lowered) ceiling is the row analogue of the file
  // path's `oversize`, and is reported the same way when it diverges from its manifest.
  if (stored.bundle.bytes !== manifest.bytes) {
    return { health: "artifact-store-unavailable", storeFault: "integrity-lie", manifest };
  }
  if (def.members !== undefined) {
    const health = memberRowsHealth(body, stored);
    if (health !== null) return { health, manifest };
  }
  return { ...verdict, manifest, body };
}

/** Prototype properties are not profile declarations, even for structurally valid ids. */
function declaredArtifact(profile: Pick<ProfilePack, "artifacts">, type: string): ArtifactTypeDef | undefined {
  const definitions = profile.artifacts ?? {};
  return Object.hasOwn(definitions, type) ? definitions[type] : undefined;
}

