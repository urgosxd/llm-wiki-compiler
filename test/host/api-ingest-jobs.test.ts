/**
 * @file test/host/api-ingest-jobs.test.ts
 * @description The async contract: 202 with a job id, and real reads afterwards.
 *
 * WHY THESE ASSERTIONS. `{"async": true}` changes WHEN the work happens, so the
 * thing worth pinning is not "did it return" but "did the answer describe work that
 * actually got tracked". Three properties:
 *
 *   1. The 202 arrives without waiting for the ingest, and names the job.
 *   2. Without the flag the endpoint behaves exactly as before -- the MCP server,
 *      the SDK and every existing test rely on that.
 *   3. The job reads are reachable and inherit the viewer's origin policy, which is
 *      the reason they are registered there and not beside the mutation route.
 */
import { describe, expect, it } from "vitest";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { startHost } from "../../src/host/server.js";
import { createJobRegistry } from "../../src/services/ingest/jobs/registry.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";
import { useStackEnv } from "../fixtures/stack-env.js";

/** A scratch project with the sources/ directory the services expect. */
const projectRoot = () => scratchProjectRoot("host-jobs-");

/** Start a host with an explicit registry, plus fetchers bound to its port. */
async function startFor(root: string) {
  const snapshot = await buildViewerSnapshot(root);
  const ingestJobs = createJobRegistry();
  const handle = await startHost({
    viewerSnapshot: snapshot, port: 0, projectRoot: root, ingestJobs,
  });
  const base = `http://${handle.host}:${handle.port}`;
  const request = (route: string, init?: RequestInit) => fetch(`${base}${route}`, init);
  const post = (route: string, body: unknown) =>
    request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { handle, request, post, ingestJobs };
}

describe("the async ingest contract", () => {
  useStackEnv("host-api-ingest-jobs");

  it("answers 202 with a job id without waiting for the work", async () => {
    const root = await projectRoot();
    const { handle, post } = await startFor(root);
    try {
      const res = await post("/api/ingest", { source: "not-a-real-source", async: true });
      // 202 is the whole point: the contract is "accepted", not "done".
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(typeof body.jobId).toBe("string");
      expect(body.jobId.startsWith("ing_")).toBe(true);
      expect(body.stage).toBe("queued");
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("keeps the synchronous answer when the flag is absent", async () => {
    const root = await projectRoot();
    const { handle, post, ingestJobs } = await startFor(root);
    try {
      // A blank source is refused before any work, so this measures the routing
      // (no async path taken) without needing a real ingest.
      const res = await post("/api/ingest", { source: "   " });
      expect(res.status).toBe(400);
      // Nothing was tracked, which is what "the old path" means.
      expect(ingestJobs.list()).toHaveLength(0);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("serves the job by id after it was created", async () => {
    const root = await projectRoot();
    const { handle, request, post, ingestJobs } = await startFor(root);
    try {
      const accepted = await (await post("/api/ingest", { source: "x", async: true })).json();
      const res = await request(`/api/ingest/jobs/${accepted.jobId}`);
      expect(res.status).toBe(200);
      const job = await res.json();
      expect(job.id).toBe(accepted.jobId);
      expect(job.source).toBe("x");
      expect(ingestJobs.get(accepted.jobId)).toBeDefined();
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("lists jobs newest first and 404s an unknown id", async () => {
    const root = await projectRoot();
    const { handle, request, post } = await startFor(root);
    try {
      await post("/api/ingest", { source: "first", async: true });
      await post("/api/ingest", { source: "second", async: true });
      const list = await (await request("/api/ingest/jobs")).json();
      expect(list.jobs.length).toBeGreaterThanOrEqual(2);
      // Newest first, so a polling UI paints recent work at the top.
      expect(list.jobs[0].createdAt >= list.jobs[1].createdAt).toBe(true);
      // An unknown id is distinct from "this host tracks nothing".
      expect((await request("/api/ingest/jobs/ing_missing")).status).toBe(404);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("rejects a cross-site read through the viewer origin policy", async () => {
    const root = await projectRoot();
    const { handle, request, post } = await startFor(root);
    try {
      const accepted = await (await post("/api/ingest", { source: "x", async: true })).json();
      const res = await request(`/api/ingest/jobs/${accepted.jobId}`, {
        headers: { "sec-fetch-site": "cross-site" },
      });
      // These routes live on the viewer precisely so this header is enforced; a
      // mount beside the mutation endpoints would have answered 200 here.
      expect(res.status).toBe(403);
    } finally {
      await handle.close();
    }
  }, 30_000);
});
