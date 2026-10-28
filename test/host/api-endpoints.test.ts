/**
 * @file test/host/api-endpoints.test.ts
 * @description The official mutation endpoints must answer the status codes a
 * client can act on, not just "something went wrong".
 *
 * WHY THESE ASSERTIONS. `POST /api/ingest` and `POST /api/compile` are the HTTP
 * path to the same transaction the CLI uses. The status code is the contract: a
 * caller must be able to tell a RETRY signal (409, someone else holds the lock)
 * from a validation mistake (400), an oversized body (413), and a genuine failure
 * (500). Collapsing them into one code would make retry logic guesswork.
 *
 * The lock is contended through the real filesystem lock, because the contention
 * that matters is cross-process — the MCP server is a separate process over the
 * same project.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { startHost } from "../../src/host/server.js";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { useStackEnv } from "../fixtures/stack-env.js";

/** A scratch project with the sources/ directory the services expect. */
async function projectRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-api-")));
  await mkdir(path.join(root, "sources"), { recursive: true });
  return root;
}

/** Start a host bound to a free port and return a poster scoped to it. */
async function startFor(root: string) {
  const snapshot = await buildViewerSnapshot(root);
  const handle = await startHost({ viewerSnapshot: snapshot, port: 0, projectRoot: root });
  const post = (route: string, body?: unknown) =>
    fetch(`http://${handle.host}:${handle.port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { handle, post };
}

describe("the mutation endpoints", () => {
  // Every dimension is Postgres-backed: an ingest without a Stack has no tenant.
  useStackEnv("host-api-endpoints");
  it("answers 400 when ingest is missing its source", async () => {
    const root = await projectRoot();
    const { handle, post } = await startFor(root);
    try {
      expect((await post("/api/ingest", {})).status).toBe(400);
      expect((await post("/api/ingest", { source: "   " })).status).toBe(400);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("answers 400, not 500, for a body that is not JSON", async () => {
    const root = await projectRoot();
    const { handle } = await startFor(root);
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      // A malformed request is the caller's mistake, so it must not read as a
      // server fault a client would retry.
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("answers 409 while another holder owns the lock", async () => {
    const root = await projectRoot();
    // A REAL file: the lock is taken after fetching, so a nonexistent path would
    // fail on read and never reach the contention this test is about.
    const source = path.join(root, "contended.txt");
    await writeFile(source, "content long enough to clear the minimum source length");
    const { handle, post } = await startFor(root);
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    try {
      // Both mutation routes must be retryable conflicts, not failures.
      expect((await post("/api/ingest", { source })).status).toBe(409);
      expect((await post("/api/compile")).status).toBe(409);
    } finally {
      await releaseLock(root);
      await handle.close();
    }
  }, 30_000);

  it("does not treat an unrelated POST as an API route", async () => {
    const root = await projectRoot();
    const { handle, post } = await startFor(root);
    try {
      // Unknown paths fall through to the viewer, which registers GET only.
      expect((await post("/api/nope", {})).status).toBe(404);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("serves no mutation route when the host has no project root", async () => {
    const root = await projectRoot();
    const snapshot = await buildViewerSnapshot(root);
    // Without a root there is nothing to mutate, so the mount is absent rather
    // than present-but-broken.
    const handle = await startHost({ viewerSnapshot: snapshot, port: 0 });
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/api/compile`, { method: "POST" });
      expect(res.status).toBe(404);
      // The job READS must agree with the absent mutation mount. Answering an empty
      // list would claim the host looked; 503 says it has nothing to look with.
      const jobs = await fetch(`http://${handle.host}:${handle.port}/api/ingest/jobs`);
      expect(jobs.status).toBe(503);
    } finally {
      await handle.close();
    }
  }, 30_000);
});
