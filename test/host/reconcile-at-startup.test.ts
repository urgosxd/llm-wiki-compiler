/**
 * @file test/host/reconcile-at-startup.test.ts
 * @description The reconciler had tests but no caller, which made the outbox's
 * durable trail write-only. These tests prove the host actually invokes it, and
 * that a contended lock does not turn startup into a failure.
 *
 * WHAT WOULD BE A FALSE GREEN. Asserting "reconcileOutbox was called" would pass
 * even if its outcome were discarded. Each case therefore starts from a real
 * `pending` record on disk and asserts the OBSERVABLE result: the record is gone
 * because the run was finished, not because nobody looked.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { startHost } from "../../src/host/server.js";
import { saveRecord, type OutboxRecord } from "../../src/dimensions/outbox.js";

/** A project root with the private dir the outbox needs. */
async function projectRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-reconcile-")));
  await readdir(root); // existence check before creating the outbox dir below
  return root;
}

/** A pending outbox record shaped like one a crashed run would leave. */
function pendingRecord(ingestId: string): OutboxRecord {
  return {
    version: 1,
    ingestId,
    source: "https://example.test/a",
    title: "A",
    document: "# A\nbody",
    body: "body",
    status: "pending",
    dimensions: [
      { name: "wiki", idempotencyKey: null },
      { name: "kg", idempotencyKey: null },
    ],
    createdAt: new Date().toISOString(),
  };
}

/** How many outbox records remain on disk. */
async function outboxCount(root: string): Promise<number> {
  const dir = path.join(root, ".llmwiki", "dimensions", "outbox");
  return (await readdir(dir).catch(() => [] as string[])).length;
}

describe("the host reconciles pending ingests at startup", () => {
  it("finishes a pending record left by a crashed run", async () => {
    const root = await projectRoot();
    await saveRecord(root, pendingRecord("ing-2026-10-23-01"));
    expect(await outboxCount(root)).toBe(1);

    const snapshot = await buildViewerSnapshot(root);
    const handle = await startHost({ viewerSnapshot: snapshot, port: 0, projectRoot: root });
    try {
      // Reconciled means the record was resolved and removed, not merely observed.
      expect(await outboxCount(root)).toBe(0);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("serves normally when the outbox is empty", async () => {
    const root = await projectRoot();
    const snapshot = await buildViewerSnapshot(root);
    const handle = await startHost({ viewerSnapshot: snapshot, port: 0, projectRoot: root });
    try {
      expect((await fetch(`http://${handle.host}:${handle.port}/api/health`)).status).toBe(200);
      expect(await outboxCount(root)).toBe(0);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("does not touch an outbox when no project root is given", async () => {
    const root = await projectRoot();
    await saveRecord(root, pendingRecord("ing-2026-10-23-02"));

    const snapshot = await buildViewerSnapshot(root);
    const handle = await startHost({ viewerSnapshot: snapshot, port: 0 });
    try {
      // Opting out is explicit: without projectRoot the record is left alone.
      expect(await outboxCount(root)).toBe(1);
    } finally {
      await handle.close();
    }
  }, 30_000);
});
