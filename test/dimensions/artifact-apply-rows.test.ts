/**
 * @file test/dimensions/artifact-apply-rows.test.ts
 * @description An artifact write on a Stack must land as ROWS, with no journal.
 *
 * `applyArtifactLocked` and `applyMembersLocked` write files inside a journal batch
 * whose only job is to undo a partial write set: body first, then the manifest, then
 * every member leaf, then the unlink of obsolete leaves. A transaction gives all of
 * that for free, so a row-backed write needs no batch at all -- but only once the write
 * actually goes to rows.
 *
 * Two assertions prove the wiring, in the order that matters:
 *  1. the bundle is READABLE through the row store, and
 *  2. NOTHING was written to disk -- no `artifacts/` tree, no `.llmwiki/journal`.
 *
 * The second is the real one. A half-migrated write that lands both places would pass
 * (1) alone while reintroducing exactly the drift the row store exists to prevent.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { applyApprovedMutations } from "../../src/trust/executor.js";
import { readArtifact, saveArtifact } from "../../src/dimensions/wiki/artifact-store.js";
import { makeResearchLikeRoot, seedArtifact } from "../fixtures/artifact-root.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

const TYPE = "experiment-result";
const BODY = JSON.stringify({ title: "one", accuracy: 0.9 });

/** Run `body` with the Stack env bound, restoring whatever was there. */
async function withStackEnv(harness: KgPostgresHarness, body: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  try {
    process.env.AKS_STACK_ID = harness.stackId;
    process.env.AKS_DATABASE_URL = process.env.LLMWIKI_TEST_DATABASE_URL ?? "";
    await body();
  } finally {
    process.env = saved;
  }
}

/** A project root, a Stack and the Stack env, all torn down together. */
async function withProject(body: (root: string, harness: KgPostgresHarness) => Promise<void>): Promise<void> {
  const harness = await createKgPostgresHarness(`ap-${randomUUID().slice(0, 8)}`);
  let root = "";
  try {
    await withStackEnv(harness, async () => {
      root = await makeResearchLikeRoot("art-apply");
      await body(root, harness);
    });
  } finally {
    if (root !== "") await rm(root, { recursive: true, force: true });
    await harness.cleanup();
  }
}

describe("artifact write on a Stack lands as rows", () => {
  it("stores the bundle as a row and writes nothing to disk", () =>
    withProject(async (root, harness) => {
      const ref = await seedArtifact(root, TYPE, "f-one", BODY);

      // 1. Readable through the row store, with the identity the caller was handed.
      const stored = await readArtifact(harness.db, harness.stackId, TYPE, "f-one");
      expect(stored?.bundle.body).toBe(BODY);
      expect(stored?.bundle.sha256).toBe(ref.sha256);
      expect(stored?.manifest).toMatchObject({ artifactType: TYPE, slug: "f-one" });

      // 2. And NOTHING on disk: neither the artifact tree nor a journal batch.
      expect(existsSync(path.join(root, "artifacts"))).toBe(false);
      expect(existsSync(path.join(root, ".llmwiki", "journal"))).toBe(false);
    }));

  it("is applied-once: an unchanged rewrite does not move written_at", () =>
    withProject(async (root, harness) => {
      const first = await seedArtifact(root, TYPE, "f-two", BODY);
      const before = (await readArtifact(harness.db, harness.stackId, TYPE, "f-two"))?.bundle.writtenAt;

      const second = await seedArtifact(root, TYPE, "f-two", BODY);

      // The ref is the same either way -- an upsert is idempotent -- so that alone cannot
      // observe the short-circuit. `written_at` can: a rewrite that goes ahead stamps a
      // NEW time, so an unchanged one keeping its timestamp is the only visible difference.
      expect(second.sha256).toBe(first.sha256);
      expect((await readArtifact(harness.db, harness.stackId, TYPE, "f-two"))?.bundle.writtenAt).toBe(before);
    }));

  it("rewrites when the body changed, so a stale row is repaired", () =>
    withProject(async (root, harness) => {
      await seedArtifact(root, TYPE, "f-four", BODY);
      const changed = JSON.stringify({ title: "one", accuracy: 0.1 });

      const second = await seedArtifact(root, TYPE, "f-four", changed);

      // A digest that disagrees must NOT be treated as already applied, or a stale row
      // would never be repaired.
      const stored = await readArtifact(harness.db, harness.stackId, TYPE, "f-four");
      expect(stored?.bundle.body).toBe(changed);
      expect(stored?.bundle.sha256).toBe(second.sha256);
    }));

  it("repairs a stored row whose digest disagrees with the manifest", () =>
    withProject(async (root, harness) => {
      // Seed a CORRUPT bundle directly through the store, bypassing the planner: a row
      // whose body does not hash to its recorded sha. The short-circuit must not accept
      // it, or a corrupted artifact would stay broken forever.
      await saveArtifact(harness.db as never, harness.stackId, {
        artifactType: TYPE, slug: "f-five", body: "corrupt",
        sha256: "0".repeat(64), bytes: 7, contentKind: "json",
        fileName: "result.json", writtenAt: "2026-01-01T00:00:00.000Z",
      }, { artifactType: TYPE, slug: "f-five", sha256: "0".repeat(64), bytes: 7, contentKind: "json", writtenAt: "2026-01-01T00:00:00.000Z" });

      const ref = await seedArtifact(root, TYPE, "f-five", BODY);

      const stored = await readArtifact(harness.db, harness.stackId, TYPE, "f-five");
      expect(stored?.bundle.body).toBe(BODY);
      expect(stored?.bundle.sha256).toBe(ref.sha256);
    }));

  it("repairs a row whose digest column MATCHES but whose body does not", () =>
    withProject(async (root, harness) => {
      // The subtle corruption: the sha256 COLUMN carries the honest digest, so every
      // column comparison agrees, while the body bytes do not hash to it. Only
      // re-hashing the body catches this -- trusting the column is exactly what makes a
      // tamper check vacuous.
      const honest = createHash("sha256").update(BODY, "utf8").digest("hex");
      await saveArtifact(harness.db as never, harness.stackId, {
        artifactType: TYPE, slug: "f-six", body: "corrupt",
        sha256: honest, bytes: Buffer.byteLength(BODY, "utf8"), contentKind: "json",
        fileName: "result.json", writtenAt: "2026-01-01T00:00:00.000Z",
      }, { artifactType: TYPE, slug: "f-six", sha256: honest, bytes: Buffer.byteLength(BODY, "utf8"), contentKind: "json", writtenAt: "2026-01-01T00:00:00.000Z" });

      await seedArtifact(root, TYPE, "f-six", BODY);

      const stored = await readArtifact(harness.db, harness.stackId, TYPE, "f-six");
      expect(stored?.bundle.body).toBe(BODY);
    }));

  it("repairs a row whose BODY is honest but whose column digest is not", () =>
    withProject(async (root, harness) => {
      // The mirror of the previous case, and the reason the column comparison is not
      // redundant with re-hashing: the body hashes correctly, so a re-hash alone would
      // accept this row -- leaving a wrong digest column behind for every reader that
      // does NOT re-hash (the metadata-only paths).
      const honest = createHash("sha256").update(BODY, "utf8").digest("hex");
      const lie = { artifactType: TYPE, slug: "f-seven", sha256: "0".repeat(64),
        bytes: Buffer.byteLength(BODY, "utf8"), contentKind: "json", writtenAt: "2026-01-01T00:00:00.000Z" };
      await saveArtifact(harness.db as never, harness.stackId, { ...lie, body: BODY, fileName: "result.json" }, lie);

      await seedArtifact(root, TYPE, "f-seven", BODY);

      const stored = await readArtifact(harness.db, harness.stackId, TYPE, "f-seven");
      expect(stored?.bundle.sha256).toBe(honest);
    }));

  it("still writes files when no Stack is configured", async () => {
    const root = await makeResearchLikeRoot("art-file");
    const saved = { ...process.env };
    delete process.env.AKS_STACK_ID;
    delete process.env.AKS_DATABASE_URL;
    try {
      await seedArtifact(root, TYPE, "f-three", BODY);

      // The file backend must be untouched by this change.
      expect(existsSync(path.join(root, "artifacts", TYPE, "f-three"))).toBe(true);
    } finally {
      process.env = saved;
      await rm(root, { recursive: true, force: true });
    }
  });
});
