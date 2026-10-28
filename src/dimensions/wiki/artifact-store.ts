/**
 * @file src/dimensions/wiki/artifact-store.ts
 * @description Artifact bundles (body, sidecar manifest, member leaves) as rows.
 *
 * ## What this replaces
 *
 * `artifacts/<type>/<slug>/<fileName>` with a `<fileName>.manifest.json` sidecar, plus
 * every sibling member leaf for a member-bearing type.
 *
 * ## The property that changes shape
 *
 * The file store identifies a bundle by the EXACT SET OF FILES in its directory:
 * `resolveArtifactRef` reports `artifact-dangling` when the directory holds a leaf the
 * manifest does not name, and `apply-members` unlinks "obsolete" leaves left by a shrink
 * or rename. A row set states the same property through its primary keys instead of
 * proving it with a directory listing, and removal is a DELETE in the same transaction
 * as the insert rather than a best-effort unlink after it.
 *
 * ## Why one transaction for the whole bundle
 *
 * Body, manifest and members are written together by `applyArtifactLocked` and
 * `applyMembersLocked`, inside a journal batch whose only job is to undo a partial file
 * write set. A transaction gives that for free: either the whole bundle lands or none
 * of it does, so the journal has nothing to undo and the write path stops opening one.
 *
 * ## What is stored verbatim
 *
 * `hashArtifactBody` hashes the body bytes and the manifest records `sha256`/`bytes`
 * over them; a member-bearing artifact's ref is a Merkle root over member bytes and the
 * manifest core. Any re-encoding changes the public identity, so the body and the
 * manifest are stored exactly as produced, and the digest/size are stored alongside so a
 * reader can re-verify without trusting the column it just read.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";

/** One artifact bundle as the write path produces it. */
export interface ArtifactBundleRow extends Record<string, unknown> {
  artifactType: string;
  slug: string;
  /** The manifest body core, byte-exact. */
  body: string;
  sha256: string;
  bytes: number;
  contentKind: "json" | "text";
  fileName: string;
  writtenAt: string;
}

/** One member leaf, in declaration order. */
export interface ArtifactMemberRow {
  fileName: string;
  /** Folded into the Merkle root in this order; never re-sorted. */
  position: number;
  bytes: Uint8Array;
}

/** What a read of one bundle returns. */
export interface StoredArtifact {
  bundle: ArtifactBundleRow;
  /** The sidecar manifest document, as stored. */
  manifest: unknown;
  /** Member leaves ordered by `position`; absent for a non-member type. */
  members: ArtifactMemberRow[];
}

/**
 * Write a whole bundle atomically, replacing any prior version of it.
 *
 * The member set is REPLACED, not merged: a shrink or rename leaves no stale leaf
 * behind, which is the behaviour the file store had to implement by listing the
 * directory and unlinking what the new set no longer named. Here the DELETE and the
 * INSERT are one statement pair inside one transaction, so there is no window where the
 * old and new sets coexist and no unlink that can fail after the batch commits.
 *
 * @param db - Database handle.
 * @param stackId - The Stack this artifact belongs to.
 * @param bundle - The body, digest and manifest metadata.
 * @param manifest - The sidecar manifest document, stored whole.
 * @param members - Member leaves in declaration order; omit for a non-member type.
 */
export async function saveArtifact(
  db: Database,
  stackId: string,
  bundle: ArtifactBundleRow,
  manifest: unknown,
  members?: readonly ArtifactMemberRow[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    await tx.execute(sql`
      insert into wiki.artifact
        (stack_id, artifact_type, slug, body, sha256, bytes, content_kind, file_name, written_at)
      values (${stackId}, ${bundle.artifactType}, ${bundle.slug}, ${bundle.body},
              ${bundle.sha256}, ${bundle.bytes}, ${bundle.contentKind},
              ${bundle.fileName}, ${bundle.writtenAt})
      on conflict (stack_id, artifact_type, slug) do update set
        body = excluded.body, sha256 = excluded.sha256, bytes = excluded.bytes,
        content_kind = excluded.content_kind, file_name = excluded.file_name,
        written_at = excluded.written_at
    `);
    await tx.execute(sql`
      insert into wiki.artifact_manifest (stack_id, artifact_type, slug, manifest)
      values (${stackId}, ${bundle.artifactType}, ${bundle.slug}, ${JSON.stringify(manifest)}::jsonb)
      on conflict (stack_id, artifact_type, slug) do update set
        manifest = excluded.manifest
    `);
    if (members !== undefined) await replaceMembers(tx, stackId, bundle, members);
  });
}

/**
 * Replace one bundle's member rows with exactly `members`.
 *
 * A non-member type never reaches here, so an absent call means "this type has no
 * members" rather than "leave the old ones" — which is why the clear runs unconditionally
 * even for an empty set. A member-bearing artifact that now declares zero members must
 * end up with zero rows, not with the previous run's leaves.
 *
 * @param tx - The transaction handle from {@link saveArtifact}.
 * @param stackId - The Stack this artifact belongs to.
 * @param bundle - Supplies the artifact identity.
 * @param members - The complete new member set.
 */
async function replaceMembers(
  tx: Database,
  stackId: string,
  bundle: ArtifactBundleRow,
  members: readonly ArtifactMemberRow[],
): Promise<void> {
  await tx.execute(sql`
    delete from wiki.artifact_member
    where stack_id = ${stackId} and artifact_type = ${bundle.artifactType}
      and slug = ${bundle.slug}
  `);
  for (const member of members) {
    await tx.execute(sql`
      insert into wiki.artifact_member
        (stack_id, artifact_type, slug, file_name, position, bytes)
      values (${stackId}, ${bundle.artifactType}, ${bundle.slug},
              ${member.fileName}, ${member.position}, ${Buffer.from(member.bytes)})
    `);
  }
}

/**
 * Read one bundle, or undefined when it was never written.
 *
 * Undefined is distinct from empty: a Stack that has not produced this artifact has no
 * bundle, while a bundle legitimately produced from zero members has one with no member
 * rows.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose artifact to read.
 * @param artifactType - The profile-declared artifact type.
 * @param slug - The artifact slug.
 * @returns The stored bundle, manifest and ordered members, or undefined.
 */
export async function readArtifact(
  db: Database,
  stackId: string,
  artifactType: string,
  slug: string,
): Promise<StoredArtifact | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<ArtifactBundleRow>(sql`
      select artifact_type as "artifactType", slug, body, sha256,
             bytes::int as bytes, content_kind as "contentKind",
             file_name as "fileName", written_at as "writtenAt"
      from wiki.artifact
      where stack_id = ${stackId} and artifact_type = ${artifactType} and slug = ${slug}
    `);
    const bundle = rows[0];
    if (bundle === undefined) return undefined;
    return {
      bundle,
      manifest: await readManifestDocument(tx, stackId, artifactType, slug),
      members: await readMemberRows(tx, stackId, artifactType, slug),
    };
  });
}

/** Read the stored sidecar manifest document, or undefined when it is missing. */
async function readManifestDocument(
  tx: Database,
  stackId: string,
  artifactType: string,
  slug: string,
): Promise<unknown> {
  const rows = await tx.execute<{ manifest: unknown }>(sql`
    select manifest from wiki.artifact_manifest
    where stack_id = ${stackId} and artifact_type = ${artifactType} and slug = ${slug}
  `);
  return rows[0]?.manifest;
}

/** Read a bundle's member rows in DECLARATION order, never name order. */
async function readMemberRows(
  tx: Database,
  stackId: string,
  artifactType: string,
  slug: string,
): Promise<ArtifactMemberRow[]> {
  const rows = await tx.execute<{ fileName: string; position: number; bytes: Buffer }>(sql`
    select file_name as "fileName", position, bytes from wiki.artifact_member
    where stack_id = ${stackId} and artifact_type = ${artifactType} and slug = ${slug}
    order by position
  `);
  return rows.map((row) => ({
    fileName: row.fileName,
    position: row.position,
    bytes: new Uint8Array(row.bytes),
  }));
}

/**
 * Delete one bundle and everything hanging off it.
 *
 * The manifest and member rows go with it through `on delete cascade`, so a delete cannot
 * leave an orphan that a later read would treat as a partially-written artifact.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose artifact to delete.
 * @param artifactType - The profile-declared artifact type.
 * @param slug - The artifact slug.
 */
export async function deleteArtifact(
  db: Database,
  stackId: string,
  artifactType: string,
  slug: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    await tx.execute(sql`
      delete from wiki.artifact
      where stack_id = ${stackId} and artifact_type = ${artifactType} and slug = ${slug}
    `);
  });
}
