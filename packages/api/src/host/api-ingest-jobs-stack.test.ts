/**
 * @file packages/api/src/host/api-ingest-jobs-stack.test.ts
 * @description `?stackId=` on the job reads: the two ways it could LIE.
 *
 * ## Why these cases exist
 *
 * The argument is easy to add and easy to get subtly wrong, and every wrong version
 * answers 200 with a plausible body rather than failing. Two traps:
 *
 *   1. **The live registry is stack-agnostic.** `registry.list()` returns every job
 *      this process holds with no attribution, so merging it into an answer about a
 *      DIFFERENT Stack would attach this host's jobs to that Stack. That is a wrong
 *      answer that looks right — worse than the empty list a caller was avoiding.
 *      A foreign Stack must therefore serve DURABLE ONLY.
 *   2. **An unknown id must not read as "no jobs".** Empty is an answer; unknown is
 *      a refusal. A host that cannot reach a database must still say 503 rather
 *      than invent a 404 for a Stack it never checked.
 *
 * ## Why the foreign Stack is a REAL row
 *
 * The route validates a named id against the database before reading anything (the same
 * tri-state lookup `/api/reviews` and `POST /api/ingest` use), so a fabricated id is refused
 * as `unknown_stack` and the durable-only rule is never reached. The foreign Stack is
 * therefore provisioned for real, and the injected store below is what keeps ITS reads empty.
 */
import { describe, expect, it } from "vitest";
import { buildViewerSnapshot } from "@repo/wiki/viewer-snapshot";
import { startHost } from "./server.js";
import { createJobRegistry } from "@repo/wiki/job-registry";
import { scratchProjectRoot } from "../../../../test/fixtures/host-scratch.js";
import { useStackEnv } from "../../../../test/fixtures/stack-env.js";
import { createProbeStack } from "../../../../test/dimensions/harness-lifecycle.js";

/** A well-formed id no row carries: absent, which is a different answer from retired. */
const UNKNOWN = "22222222-2222-4222-8222-222222222222";

/**
 * A durable store whose per-Stack reads are observable.
 *
 * `list`/`get` are the bound Stack's view and return a sentinel job, which is what
 * makes trap 1 detectable: if a foreign request ever falls back to them, the sentinel
 * shows up in an answer that must not contain it.
 */
function fakeDurable(foreignStackId: string) {
  const boundJob = { id: "ing_bound", updatedAt: "2026-01-01T00:00:00.000Z" };
  const foreignJob = { id: "ing_foreign", updatedAt: "2026-01-02T00:00:00.000Z" };
  return {
    list: async () => [boundJob],
    get: async (id: string) => (id === boundJob.id ? boundJob : undefined),
    forStack: (stackId: string) => ({
      list: async () => (stackId === foreignStackId ? [] : [foreignJob]),
      get: async (id: string) => (stackId === foreignStackId ? undefined : id === foreignJob.id ? foreignJob : undefined),
      exists: async () => stackId !== UNKNOWN,
    }),
  };
}

/**
 * Start a host with a live registry holding one job, plus the fake durable store.
 *
 * The registry is NON-EMPTY on purpose: a foreign-Stack request that wrongly consults
 * it can only be caught if the registry knows something it must not serve. With an
 * empty registry the `:id` case passed even after the guard was deleted.
 */
async function startFor(root: string, foreignStackId: string) {
  const snapshot = await buildViewerSnapshot(root);
  const registry = createJobRegistry();
  const live = registry.create("live.md", new Date("2026-01-03T00:00:00.000Z"));
  const handle = await startHost({
    viewerSnapshot: snapshot,
    port: 0,
    projectRoot: root,
    ingestJobs: registry,
    viewerDeps: { durableIngestJobs: fakeDurable(foreignStackId) },
  });
  const base = `http://${handle.host}:${handle.port}`;
  return {
    handle,
    liveJobId: (live as { id: string }).id,
    get: (route: string) => fetch(`${base}${route}`),
  };
}

describe("?stackId= on the ingest job reads", () => {
  useStackEnv("api-ingest-jobs-stack");

  it("answers 400 for a malformed id instead of letting the cast fail", async () => {
    const { handle, get } = await startFor(await scratchProjectRoot("stack-400-"), UNKNOWN);
    try {
      const res = await get("/api/ingest/jobs?stackId=nope");
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_stack_id" } });
    } finally {
      await handle.close();
    }
  });

  it("answers 404 for an unknown Stack rather than an empty list", async () => {
    const { handle, get } = await startFor(await scratchProjectRoot("stack-404-"), UNKNOWN);
    try {
      const res = await get(`/api/ingest/jobs?stackId=${UNKNOWN}`);
      expect(res.status).toBe(404);
      // The SAME code the other two surfaces use for "named but absent" (S10): a second spelling
      // for one fact is what a client branches on wrongly.
      expect(await res.json()).toMatchObject({ error: { code: "unknown_stack" } });
    } finally {
      await handle.close();
    }
  });

  it("serves durable only for a foreign Stack, never the bound jobs", async () => {
    const foreign = await createProbeStack("jobs-foreign-empty");
    const { handle, get } = await startFor(await scratchProjectRoot("stack-foreign-"), foreign.harness.stackId);
    try {
      const res = await get(`/api/ingest/jobs?stackId=${foreign.harness.stackId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { jobs: { id: string }[] };
      // Neither the bound Stack's durable sentinel nor any live job may appear: the
      // registry knows no attribution, so a foreign answer is durable-only.
      expect(body.jobs.map((job) => job.id)).not.toContain("ing_bound");
      expect(body.jobs).toHaveLength(0);
    } finally {
      await handle.close();
      await foreign.harness.cleanup();
    }
  });

  it("does not serve a LIVE job by id when a foreign Stack is named", async () => {
    const foreign = await createProbeStack("jobs-foreign-byid");
    const { handle, get, liveJobId } = await startFor(
      await scratchProjectRoot("stack-id-foreign-"),
      foreign.harness.stackId,
    );
    try {
      // The registry really holds this job, and it belongs to the BOUND Stack. A
      // named foreign Stack must not reach it, because the registry cannot say which
      // Stack a job came from.
      const res = await get(`/api/ingest/jobs/${liveJobId}?stackId=${foreign.harness.stackId}`);
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
      await foreign.harness.cleanup();
    }
  });

  it("keeps today's behaviour when no stackId is given", async () => {
    const { handle, get, liveJobId } = await startFor(await scratchProjectRoot("stack-absent-"), UNKNOWN);
    try {
      const res = await get("/api/ingest/jobs");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { jobs: { id: string }[] };
      const ids = body.jobs.map((job) => job.id);
      // Both sources still merge for the bound Stack: the live job AND the durable one.
      expect(ids).toContain(liveJobId);
      expect(ids).toContain("ing_bound");
    } finally {
      await handle.close();
    }
  });
});
