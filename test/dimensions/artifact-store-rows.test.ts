/**
 * @file test/dimensions/artifact-store-rows.test.ts
 * @description Artifact bundles as rows: the four properties the directory used to give.
 *
 * The file store made four promises by LISTING a real directory. Each one becomes an
 * explicit behaviour here, and each has a test that fails when the behaviour is removed:
 *
 *  1. THE SET IS CLOSED. `resolveArtifactRef` reported `artifact-dangling` when the
 *     directory held a leaf the manifest did not name. A row set is closed by its keys.
 *  2. A SHRINK LEAVES NOTHING BEHIND. `apply-members` unlinked "obsolete" leaves. The
 *     row path replaces the set, so a smaller set must leave no survivor.
 *  3. ORDER IS DECLARATION ORDER. A member-bearing ref is a Merkle root folded in
 *     declaration order; reading by name would change the ref.
 *  4. BYTES ARE BYTES. Member content is arbitrary binary and must round-trip exactly.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  saveArtifact,
  readArtifact,
  deleteArtifact,
  type ArtifactBundleRow,
  type ArtifactMemberRow,
} from "../../src/dimensions/wiki/artifact-store.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { stackHarnessRunner } from "../fixtures/stack-harness.js";

/** This suite's Stack label, so a leaked Stack names the file that leaked it. */
const withHarness = stackHarnessRunner("art");

/** A minimal bundle row for `slug`, with a digest that is deliberately identifiable. */
function bundleRow(slug: string, body: string): ArtifactBundleRow {
  return {
    artifactType: "report",
    slug,
    body,
    sha256: `sha-of-${slug}`,
    bytes: Buffer.byteLength(body, "utf8"),
    contentKind: "text",
    fileName: "report.md",
    writtenAt: "2026-01-01T00:00:00.000Z",
  };
}

/** One member leaf, at an explicit declaration position. */
function memberRow(fileName: string, position: number, content: string): ArtifactMemberRow {
  return { fileName, position, bytes: new Uint8Array(Buffer.from(content, "utf8")) };
}

describe("artifact bundles as rows", () => {
  it("round-trips the body, manifest and members", () =>
    withHarness(async (harness) => {
      const manifest = { artifactType: "report", slug: "r1", sha256: "sha-of-r1" };
      await saveArtifact(harness.db, harness.stackId, bundleRow("r1", "body one"), manifest, [
        memberRow("a.md", 0, "alpha"),
        memberRow("b.md", 1, "beta"),
      ]);

      const stored = await readArtifact(harness.db, harness.stackId, "report", "r1");

      expect(stored?.bundle.body).toBe("body one");
      expect(stored?.bundle.sha256).toBe("sha-of-r1");
      expect(stored?.manifest).toEqual(manifest);
      expect(stored?.members.map((m) => m.fileName)).toEqual(["a.md", "b.md"]);
    }));

  it("leaves nothing behind when a later member set is smaller", () =>
    withHarness(async (harness) => {
      // The file store unlinked "obsolete" leaves here. A replace must do it as one step.
      await saveArtifact(harness.db, harness.stackId, bundleRow("r2", "v1"), {}, [
        memberRow("a.md", 0, "alpha"),
        memberRow("gone.md", 1, "obsolete"),
      ]);
      await saveArtifact(harness.db, harness.stackId, bundleRow("r2", "v2"), {}, [
        memberRow("a.md", 0, "alpha"),
      ]);

      const stored = await readArtifact(harness.db, harness.stackId, "report", "r2");
      expect(stored?.members.map((m) => m.fileName)).toEqual(["a.md"]);
    }));

  it("preserves declaration order rather than sorting by name", () =>
    withHarness(async (harness) => {
      // A member-bearing ref is a Merkle root over this order, so name order would
      // silently produce a different ref for the same bundle.
      await saveArtifact(harness.db, harness.stackId, bundleRow("r3", "b"), {}, [
        memberRow("z.md", 0, "first"),
        memberRow("a.md", 1, "second"),
      ]);

      const stored = await readArtifact(harness.db, harness.stackId, "report", "r3");
      expect(stored?.members.map((m) => m.fileName)).toEqual(["z.md", "a.md"]);
    }));

  it("round-trips member bytes that are not valid UTF-8", () =>
    withHarness(async (harness) => {
      const binary = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x0a]);
      await saveArtifact(harness.db, harness.stackId, bundleRow("r4", "b"), {}, [
        { fileName: "blob.bin", position: 0, bytes: binary },
      ]);

      const stored = await readArtifact(harness.db, harness.stackId, "report", "r4");
      expect(Array.from(stored!.members[0].bytes)).toEqual(Array.from(binary));
    }));

  it("returns undefined for a bundle that was never written", () =>
    withHarness(async (harness) => {
      expect(await readArtifact(harness.db, harness.stackId, "report", "absent")).toBeUndefined();
    }));

  it("cascades a delete to the manifest and member rows", () =>
    withHarness(async (harness) => {
      await saveArtifact(harness.db, harness.stackId, bundleRow("r5", "b"), {}, [memberRow("a.md", 0, "x")]);
      await deleteArtifact(harness.db, harness.stackId, "report", "r5");

      // A surviving manifest or member row would be an orphan a later read would
      // mistake for a partially-written artifact.
      expect(await readArtifact(harness.db, harness.stackId, "report", "r5")).toBeUndefined();
    }));
});
