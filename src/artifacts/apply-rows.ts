/**
 * @file src/artifacts/apply-rows.ts
 * @description The UNDER-LOCK row-backed artifact write: body, manifest and members
 * land in one transaction instead of one journal batch.
 *
 * ## What this replaces, and what it makes unnecessary
 *
 * The file write path journals the pre-state of every target so a crash mid-batch
 * replays back: body, manifest, then each member leaf, then the unlink of each obsolete
 * leaf. Each of those steps exists because a set of file writes is not atomic and an
 * unlink can fail after the batch has already committed.
 *
 * A transaction gives the whole set or none of it, so this module opens NO batch and
 * records NO pre-state. The obsolete leaves disappear because the member set is
 * REPLACED inside the same transaction (`saveArtifact`), not unlinked afterwards.
 *
 * ## What is deliberately reused rather than re-derived
 *
 * The admission decisions that are NOT about storage -- the profile reload, the composed
 * trust decision, the trusted-write grant, the derived audit event and its preflight --
 * stay in `apply.ts` and run BEFORE this module is reached. Only the observation of
 * "what is already stored" and the write itself differ, which is the same split the read
 * side uses.
 *
 * ## Applied-once
 *
 * The file path short-circuits when the manifest parses AND the on-disk bytes hash to the
 * manifest digest. The row analogue is the same predicate over columns: the stored
 * `sha256` and `bytes` must match the manifest AND the stored body must hash to it. The
 * body is read back rather than trusted, because a digest column that a reader believes
 * without checking is not a tamper check -- it is a claim.
 */

import type { ArtifactTypeDef } from "../profile/types.js";
import type { ArtifactPlannedMutation } from "../trust/planner.js";
import type { TrustDecision } from "../trust/decision.js";
import {
  readArtifact, saveArtifact,
  type ArtifactBundleRow, type ArtifactMemberRow,
} from "../dimensions/wiki/artifact-store.js";
import type { ArtifactRef } from "./ref.js";
import { hashArtifactBody, type ArtifactManifest } from "./store.js";
import type { ArtifactMemberFileInput } from "./members.js";

/**
 * The only capability this module needs from the database handle.
 *
 * `unknown`, not the real client type, for the same reason `page-scan-source.ts` and
 * `page-registry-source.ts` declare it that way: naming `llmwiki-kg` here would pull it
 * into `tsup`'s declaration build, which cannot resolve it, and a failed DTS build
 * clears the build stamp and wedges every later test run. The real check happens at each
 * `artifact-store` call -- which is why the two store calls below narrow with `as never`,
 * the same convention `page-source-seam.ts` uses when it builds a real sink.
 */
type SurfaceHandle = unknown;

/** Everything a row-backed artifact write needs, resolved by `apply.ts` under the lock. */
export interface RowsWriteV1 {
  /** Database handle for the Stack. */
  db: SurfaceHandle;
  /** The Stack this artifact belongs to. */
  stackId: string;
  /** The declared artifact type, carrying the file name and content kind. */
  def: ArtifactTypeDef;
  /** The planned mutation (intent only; already admitted by `apply.ts`). */
  mutation: ArtifactPlannedMutation;
  /** The canonical manifest body core the plan derived. */
  body: string;
  /** The composed trust decision, echoed into the write result. */
  decision: TrustDecision;
  /** The manifest built by `refAndManifest`, so ref and manifest share one body. */
  manifest: ArtifactManifest;
}

/**
 * True when the stored bundle already IS this manifest, byte for byte.
 *
 * Identity fields are compared first because a row whose sha matches but whose identity
 * moved is a different artifact, not a duplicate. The body is then re-read and re-hashed
 * rather than trusted from the `sha256` column: that column is what a tamper would
 * rewrite, so believing it would make this check vacuous.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose artifact is checked.
 * @param write - The write being considered.
 * @returns True when the stored bundle verifies against the manifest.
 */
async function alreadyStored(db: SurfaceHandle, stackId: string, write: RowsWriteV1): Promise<boolean> {
  const { mutation, manifest } = write;
  const stored = await readArtifact(db as never, stackId, mutation.artifactType, mutation.slug);
  if (stored === undefined) return false;
  const { bundle } = stored;
  if (bundle.sha256 !== manifest.sha256 || bundle.bytes !== manifest.bytes) return false;
  if (bundle.contentKind !== manifest.contentKind) return false;
  return hashArtifactBody(bundle.body) === manifest.sha256
    && Buffer.byteLength(bundle.body, "utf8") === manifest.bytes;
}

/**
 * The bundle row for one write, with the digest and length DERIVED from the body.
 *
 * Derived rather than copied from the manifest so a manifest that lies about its own
 * length cannot be persisted as though it were true.
 *
 * @param write - The write being stored.
 * @returns The row to insert.
 */
function bundleRowFor(write: RowsWriteV1): ArtifactBundleRow {
  const { mutation, manifest, body } = write;
  return {
    artifactType: mutation.artifactType,
    slug: mutation.slug,
    body,
    sha256: hashArtifactBody(body),
    bytes: Buffer.byteLength(body, "utf8"),
    contentKind: manifest.contentKind,
    fileName: write.def.fileName,
    writtenAt: manifest.writtenAt,
  };
}

/**
 * Member rows in DECLARATION order.
 *
 * The position is the array index, not a sort of the names: a member-bearing artifact's
 * ref is a Merkle root folded in declaration order, so re-ordering would change the
 * artifact's public identity.
 *
 * @param files - The member files the mutation carries.
 * @returns Rows ready to store.
 */
function memberRowsFor(files: readonly ArtifactMemberFileInput[]): ArtifactMemberRow[] {
  return files.map((file, position) => ({ fileName: file.fileName, position, bytes: file.bytes }));
}

/**
 * Write one artifact bundle as rows, replacing any prior version.
 *
 * No journal is opened and no pre-state is recorded: the transaction is the durability,
 * and `saveArtifact` replaces the member set rather than merging it, so a shrink or a
 * rename leaves no stale leaf behind. That removes the need for the obsolete-leaf sweep
 * the file path performs after its batch commits.
 *
 * @param write - The admitted write, with its manifest already built.
 * @returns The persisted ref and the composed decision.
 */
export async function applyArtifactToRows(write: RowsWriteV1): Promise<{ ref: ArtifactRef; decision: TrustDecision }> {
  const { db, stackId, mutation, manifest, decision } = write;
  const ref: ArtifactRef = { artifactType: mutation.artifactType, slug: mutation.slug, sha256: manifest.sha256 };
  if (await alreadyStored(db, stackId, write)) return { ref, decision };
  const members = mutation.memberFiles === undefined ? undefined : memberRowsFor(mutation.memberFiles);
  await saveArtifact(db as never, stackId, bundleRowFor(write), manifest, members);
  return { ref, decision };
}
