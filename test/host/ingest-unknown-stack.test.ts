/**
 * @file test/host/ingest-unknown-stack.test.ts
 * @description An ingest naming a Stack that does not exist is refused, not queued.
 *
 * ## The defect
 *
 * `POST /api/ingest?stackId=<absent>` answered **202 with a job id**. The work was
 * accepted, the HTTP caller was told it had started, and the durable mirror then failed
 * on a foreign key inside a `catch` that only writes to stderr. From the caller's side a
 * job existed; from the database's side nothing was ever recorded.
 *
 * Shape validation was already there (`stackIdProblem`), and a well-formed id passes it.
 * The missing question is whether the Stack EXISTS -- the same one the MCP tools answer,
 * and the same one that answered `0 pages` for an absent Stack until b2e2497.
 *
 * ## Why 404 rather than 400
 *
 * The request is well formed; the resource it names is not there. That is what 404
 * means, and a client can tell it apart from "you sent garbage" (400) or "I cannot check
 * right now" (503).
 *
 * ## What the fixture must contain
 *
 * A REAL Stack, not an invented id: the refusal only fires when a lookup actually runs,
 * and a fake that answers "absent" for everything would pass even if the check were
 * deleted. `withStackEnv` provisions one, and the absent case is a well-formed UUID.
 */
import { describe, it, expect } from "vitest";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { startHost } from "../../src/host/server.js";
import { createJobRegistry } from "../../src/services/ingest/jobs/registry.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";
import { withStackEnv } from "../fixtures/stack-env.js";

/** A well-formed UUID that names no Stack. */
const ABSENT_STACK = "00000000-0000-4000-8000-000000000000";

/** Fire one async ingest at a fresh host and decode whatever comes back. */
async function postIngest(stackId: string): Promise<{
  status: number;
  body: { jobId?: string; error?: { code?: string; message?: string } };
}> {
  const root = await scratchProjectRoot("ingest-unknown-stack-");
  const handle = await startHost({
    viewerSnapshot: await buildViewerSnapshot(root),
    port: 0,
    projectRoot: root,
    ingestJobs: createJobRegistry(),
  });
  try {
    const response = await fetch(`http://${handle.host}:${handle.port}/api/ingest?stackId=${stackId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "/tmp/none.md", compile: false, async: true }),
    });
    return { status: response.status, body: (await response.json()) as never };
  } finally {
    await handle.close();
  }
}

describe("POST /api/ingest with a Stack that does not exist", () => {
  it("answers 404 with a code a client can branch on", async () => {
    await withStackEnv("ingest-unknown-stack", async () => {
      const response = await postIngest(ABSENT_STACK);

      expect(response.status).toBe(404);
      // A bare 404 would not distinguish "this Stack is gone" from "no such route".
      expect(response.body.error?.code).toBe("unknown_stack");
      expect(response.body.error?.message).toContain(ABSENT_STACK);
    });
  }, 60_000);

  it("does not mint a job id", async () => {
    await withStackEnv("ingest-unknown-stack-id", async () => {
      const response = await postIngest(ABSENT_STACK);

      // Load-bearing: a 202 was the whole bug. Any jobId in the body means work was
      // accepted for a Stack that cannot hold it.
      expect(response.body.jobId).toBeUndefined();
    });
  }, 60_000);
});
