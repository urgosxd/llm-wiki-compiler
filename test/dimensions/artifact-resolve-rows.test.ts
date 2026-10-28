/**
 * @file test/dimensions/artifact-resolve-rows.test.ts
 * @description The row resolver must reach the SAME verdict as the file resolver.
 *
 * `artifact-dangling` is not a string: it is a lint rule, a write-time precondition, an
 * MCP response field and a workflow gate. If the row backend returned a different code
 * for the same broken bundle, every one of those consumers would silently change
 * behaviour. So the contract under test here is parity of the VERDICT, not the presence
 * of a row read.
 *
 * The two directions that matter most are the ones a naive set comparison gets wrong:
 * a manifest row with no stored member is `dangling`, while a stored member the manifest
 * does not name is `bytes-tampered` — the same split the file path makes between a
 * missing leaf and an unexpected one.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { saveArtifact, deleteArtifact, type ArtifactBundleRow } from "../../src/dimensions/wiki/artifact-store.js";
import { readVerifiedArtifactFromRows } from "../../src/artifacts/resolve-rows.js";
import { hashMemberBytes } from "../../src/artifacts/members.js";
import type { ProfilePack } from "../../src/profile/types.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { stackHarnessRunner } from "../fixtures/stack-harness.js";

/** This suite's Stack label, so a leaked Stack names the file that leaked it. */
const withHarness = stackHarnessRunner("res");

const BODY = "# report\n\nhello\n";

/** A profile declaring one `text` artifact type, with members when asked. */
function profileWith(members?: { maxCount: number; maxMemberBytes: number; maxTotalBytes: number }): ProfilePack {
  return {
    artifacts: {
      report: {
        fileName: "report.md",
        contentKind: "text",
        maxBytes: 10_000,
        ...(members === undefined ? {} : { members }),
      },
    },
  } as unknown as ProfilePack;
}

/**
 * A bundle row for `body`, with its byte length DERIVED from that body.
 *
 * Deriving it matters: a hand-set length that disagrees with the body is an
 * integrity-lie, which the resolver reports as `artifact-store-unavailable` BEFORE it
 * ever compares digests. A test whose fixture accidentally lies about its own length
 * exercises that branch instead of the one it names.
 *
 * @param sha - The digest to record; pass a wrong one to simulate a tamper.
 * @param body - The stored body text.
 */
function bundleRow(sha: string, body: string = BODY): ArtifactBundleRow {
  return {
    artifactType: "report",
    slug: "r1",
    body,
    sha256: sha,
    bytes: Buffer.byteLength(body, "utf8"),
    contentKind: "text",
    fileName: "report.md",
    writtenAt: "2026-01-01T00:00:00.000Z",
  };
}

/** The manifest document the write path stores beside the body, length-derived the same way. */
function manifestFor(sha: string, body: string = BODY) {
  return {
    artifactType: "report", slug: "r1", sha256: sha,
    bytes: Buffer.byteLength(body, "utf8"), contentKind: "text",
    writtenAt: "2026-01-01T00:00:00.000Z",
  };
}

/** The sha the write path records, derived the same way. */
function bodySha(): string {
  return createHashRef(BODY);
}

/** Kept local so the test does not depend on the resolver's own hash helper. */
function createHashRef(body: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Resolve the `report` artifact of the harness's Stack.
 *
 * Extracted because every case below makes the identical five-argument call and only
 * the digest differs; five copies of it were flagged as a clone group. `members` is
 * threaded through because the member cases need a profile that declares them.
 *
 * @param harness - Stack to read from.
 * @param sha - Digest the REF points at.
 * @param members - Member limits to declare, when the case is about members.
 * @returns The resolver's verdict.
 */
async function readReport(
  harness: KgPostgresHarness,
  sha: string,
  members?: { maxCount: number; maxMemberBytes: number; maxTotalBytes: number },
): Promise<Awaited<ReturnType<typeof readVerifiedArtifactFromRows>>> {
  return readVerifiedArtifactFromRows(
    harness.db as never, harness.stackId, profileWith(members),
    { artifactType: "report", slug: "r1", sha256: sha });
}

/** Member limits a case declares when it is about member verification. */
const MEMBER_LIMITS = { maxCount: 4, maxMemberBytes: 1024, maxTotalBytes: 4096 } as const;

/**
 * Save a single-member bundle whose bytes the caller chooses.
 *
 * Every member case needs the same three steps -- declare limits, build a body with one
 * member, save it with a chosen member byte-set -- and the copies were flagged as a
 * clone group. Passing the member BYTES rather than a flag is what keeps the tamper
 * cases explicit: "alpha" versus "ALPHA" is the whole point of one of them.
 *
 * @param harness - Stack to save into.
 * @param memberBytes - Bytes to store for `a.md`.
 * @returns The saved bundle's digest and the limits to pass to {@link readReport}.
 */
async function saveMemberBundle(
  harness: KgPostgresHarness,
  memberBytes: Uint8Array[],
): Promise<{ sha: string; members: typeof MEMBER_LIMITS }> {
  const body = memberBody([{ fileName: "a.md", content: "alpha" }]);
  const bundle = bundleRow(createHashRef(body), body);
  await saveArtifact(
    harness.db, harness.stackId, bundle, manifestFor(bundle.sha256, body),
    memberBytes.map((bytes, position) => ({ fileName: "a.md", position, bytes })),
  );
  return { sha: bundle.sha256, members: MEMBER_LIMITS };
}

/**
 * Save an honest single-body bundle and return its digest.
 *
 * Two cases need exactly this and differ only in which digest they then point the REF
 * at -- which is the distinction one of them exists to prove (row honest, ref wrong).
 * Sharing the SETUP keeps that difference visible instead of buried in repetition.
 *
 * @param harness - Stack to save into.
 * @returns The digest the bundle was saved and manifested under.
 */
async function saveHonestBundle(harness: KgPostgresHarness): Promise<string> {
  const sha = bodySha();
  await saveArtifact(harness.db, harness.stackId, bundleRow(sha), manifestFor(sha));
  return sha;
}

describe("row-backed artifact resolution", () => {
  it("verifies a bundle that was written honestly", () =>
    withHarness(async (harness) => {
      const sha = await saveHonestBundle(harness);

      const read = await readReport(harness, sha);

      expect(read.health).toBe("ok");
      expect(read.body).toBe(BODY);
    }));

  it("reports dangling for a bundle that was never written", () =>
    withHarness(async (harness) => {
      const read = await readVerifiedArtifactFromRows(
        harness.db as never, harness.stackId, profileWith(), { artifactType: "report", slug: "nope", sha256: "0".repeat(64) });

      expect(read.health).toBe("artifact-dangling");
    }));

  it("reports dangling for an artifact type the profile does not declare", () =>
    withHarness(async (harness) => {
      const read = await readVerifiedArtifactFromRows(
        harness.db as never, harness.stackId, profileWith(),
        { artifactType: "undeclared", slug: "r1", sha256: "0".repeat(64) });

      expect(read.health).toBe("artifact-dangling");
    }));

  it("refuses a manifest that lies about its own identity", () =>
    withHarness(async (harness) => {
      const sha = bodySha();
      await saveArtifact(harness.db, harness.stackId, bundleRow(sha), { ...manifestFor(sha), slug: "someone-else" });

      const read = await readReport(harness, sha);

      // An identity lie must be refused identically on both backends, and BEFORE any
      // readability consideration.
      expect(read.health).toBe("artifact-store-unavailable");
      expect(read.storeFault).toBe("integrity-lie");
    }));

  it("reports bytes-tampered when the stored body diverges from its digest", () =>
    withHarness(async (harness) => {
      const sha = bodySha();
      // The manifest is stored honestly for BODY; the row carries different bytes of the
      // SAME length, so the length check passes and only the digest diverges.
      const tampered = "# tamper\n\nhello\n"; // SAME byte length as BODY, different bytes
      await saveArtifact(harness.db, harness.stackId, bundleRow(sha, tampered), manifestFor(sha));

      const read = await readReport(harness, sha);

      expect(read.health).toBe("artifact-bytes-tampered");
    }));

  it("reports hash-mismatch when the ROW is honest but the REF points elsewhere", () =>
    withHarness(async (harness) => {
      await saveHonestBundle(harness);

      const read = await readReport(harness, "a".repeat(64));

      // The bundle is internally consistent, so this is a ref mismatch, not a tamper.
      expect(read.health).toBe("artifact-hash-mismatch");
    }));

  it("reports dangling when a manifest member row has no stored member", () =>
    withHarness(async (harness) => {
      const { sha, members } = await saveMemberBundle(harness, []);

      const read = await readReport(harness, sha, members);

      expect(read.health).toBe("artifact-dangling");
    }));

  it("reports bytes-tampered for a stored member the manifest does not name", () =>
    withHarness(async (harness) => {
      const members = { maxCount: 4, maxMemberBytes: 1024, maxTotalBytes: 4096 };
      const body = memberBody([]);
      const bundle = bundleRow(createHashRef(body), body);
      // An extra row is the row analogue of an unexpected leaf in the directory sweep.
      await saveArtifact(harness.db, harness.stackId, bundle, manifestFor(bundle.sha256, body), [
        { fileName: "stowaway.md", position: 0, bytes: new Uint8Array(Buffer.from("x")) },
      ]);

      const read = await readReport(harness, bundle.sha256, members);

      expect(read.health).toBe("artifact-bytes-tampered");
    }));

  it("verifies a bundle whose member rows all match", () =>
    withHarness(async (harness) => {
      const members = { maxCount: 4, maxMemberBytes: 1024, maxTotalBytes: 4096 };
      const files = [{ fileName: "a.md", content: "alpha" }, { fileName: "b.md", content: "beta" }];
      const body = memberBody(files);
      const bundle = bundleRow(createHashRef(body), body);
      await saveArtifact(harness.db, harness.stackId, bundle, manifestFor(bundle.sha256, body),
        files.map((file, position) => ({
          fileName: file.fileName, position, bytes: new Uint8Array(Buffer.from(file.content)),
        })));

      const read = await readReport(harness, bundle.sha256, members);

      expect(read.health).toBe("ok");
      expect(read.body).toBe(body);
    }));

  it("reports bytes-tampered when a member row has the right LENGTH but wrong bytes", () =>
    withHarness(async (harness) => {
      // "alpha" and "ALPHA" are both 5 bytes, so the length check passes and only the
      // digest comparison can notice. Without this the set check would carry the test.
      const { sha, members } = await saveMemberBundle(harness, [new Uint8Array(Buffer.from("ALPHA"))]);

      const read = await readReport(harness, sha, members);

      expect(read.health).toBe("artifact-bytes-tampered");
    }));

  it("reports dangling after the bundle is deleted", () =>
    withHarness(async (harness) => {
      const sha = bodySha();
      await saveArtifact(harness.db, harness.stackId, bundleRow(sha), manifestFor(sha));
      await deleteArtifact(harness.db, harness.stackId, "report", "r1");

      const read = await readReport(harness, sha);

      expect(read.health).toBe("artifact-dangling");
    }));
});

/**
 * A manifest body carrying member rows, in the shape `parseMemberEntries` expects.
 *
 * @param files - Member name and content pairs.
 * @returns The JSON body text.
 */
function memberBody(files: { fileName: string; content: string }[]): string {
  return JSON.stringify({
    members: files.map((file) => ({
      fileName: file.fileName,
      bytes: Buffer.byteLength(file.content, "utf8"),
      sha256: hashMemberBytes(new Uint8Array(Buffer.from(file.content))),
    })),
  });
}
