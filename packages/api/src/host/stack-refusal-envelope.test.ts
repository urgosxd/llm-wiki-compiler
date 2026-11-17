/**
 * @file packages/api/src/host/stack-refusal-envelope.test.ts
 * @description T4: an unnamed Stack is refused BY NAME on every surface that serves it.
 *
 * ## The defect these pin
 *
 * `POST /api/ingest` with no `stackId` skipped the whole Stack branch of its validation:
 * `buildIngestEnv(undefined)` returns `process.env`, so the ingest and the compile ran under
 * whatever Stack the PROCESS named — a request silently inheriting the host's configuration,
 * which is the ambient authority S3 forbids. `GET /api/ingest/jobs` on a host that resolved no
 * Stack was worse: the durable reads rejected with a `StackAuthorityError` that the dispatcher's
 * catch turned into a bodiless 500, so a client mistake read as a server fault.
 *
 * ## What each case measures, and what would pass by accident
 *
 * Status alone is not enough: a 409 could come from the mutation lock, and an empty job list
 * could mean "refused" or "nothing ran yet". So every case asserts the EXACT envelope, and the
 * write cases assert that rejected input left no trace — no job minted, no source written.
 *
 * ## Why the environment carries a real Stack
 *
 * `useStackEnv` provisions one and exports it, which is precisely the situation that used to
 * leak: the process names a Stack, the request names none, and the work must still be refused.
 * A suite that unset the variable would prove nothing about the inheritance this removes.
 */
import { describe, expect, it } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { buildViewerSnapshot } from "@repo/wiki/viewer-snapshot";
import { createJobRegistry } from "@repo/wiki/job-registry";
import { startHost } from "./server.js";
import { scratchProjectRoot } from "../../../../test/fixtures/host-scratch.js";
import { useStackEnv } from "../../../../test/fixtures/stack-env.js";
import { createProbeStack } from "../../../../test/dimensions/harness-lifecycle.js";

/** The one wording of `stack_unnamed`, asserted as a whole envelope by every consumer. */
const UNNAMED = {
  status: 409,
  body: {
    error: {
      code: "stack_unnamed",
      message: "This request named no Stack, and a database is configured: name one with ?stackId=.",
    },
  },
};

/** A well-formed Stack id that names no row. */
const ABSENT_STACK = "00000000-0000-4000-8000-000000000000";

/** Enough text to clear the minimum length the ingest enforces. */
const BODY = "A document offered to an ingest that must never reach the compiler.";

/** One JSON POST, with the headers the mutation mount expects. */
function post(base: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A host with a project root and an observable job registry. */
async function startFor(root: string) {
  const registry = createJobRegistry();
  const handle = await startHost({
    viewerSnapshot: await buildViewerSnapshot(root),
    port: 0,
    projectRoot: root,
    ingestJobs: registry,
  });
  return { handle, registry, base: `http://${handle.host}:${handle.port}` };
}

/**
 * Post one unnamed ingest and assert the refusal in full: status AND bytes.
 *
 * Shared by the two write cases so each can spend its lines on what it proves about STORED
 * state, which is the part a status-only assertion cannot see.
 *
 * @param base - Origin of the running host.
 * @param body - The ingest body the request sends.
 */
async function expectRefusedWrite(base: string, body: Record<string, unknown>): Promise<void> {
  const res = await post(base, "/api/ingest", body);
  expect(res.status).toBe(UNNAMED.status);
  expect(await res.json()).toEqual(UNNAMED.body);
}

/** A scratch project holding one source file the request will name, plus its `sources/` dir. */
async function projectWithSource(prefix: string): Promise<{ root: string; source: string }> {
  const root = await scratchProjectRoot(prefix);
  const source = path.join(root, "offered.md");
  await writeFile(source, BODY);
  return { root, source };
}

// File-level: every case below measures a request on a host whose DATABASE is configured.
useStackEnv("t4-stack-refusal");

describe("an unnamed Stack on the viewer's mutation surface", () => {
  it("refuses an unnamed ingest by name instead of borrowing the process environment", async () => {
    const { root, source } = await projectWithSource("t4-unnamed-");
    const { handle, registry, base } = await startFor(root);
    try {
      await expectRefusedWrite(base, { source, compile: true, async: true });
      // Rejected input leaves stored state unchanged: no job was minted, so nothing will ever
      // run under this host's Stack, and no poller can find phantom work.
      expect(registry.list()).toHaveLength(0);
      // And no ingest ran: the named source was never copied into the project.
      expect(await readdir(path.join(root, "sources"))).toHaveLength(0);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it("refuses the synchronous route too, before anything is written", async () => {
    const { root, source } = await projectWithSource("t4-unnamed-sync-");
    const { handle, base } = await startFor(root);
    try {
      await expectRefusedWrite(base, { source, compile: false });
      expect(await readdir(path.join(root, "sources"))).toHaveLength(0);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it("still answers unknown_stack for an id that names no row", async () => {
    const { root } = await projectWithSource("t4-unknown-");
    const { handle, base } = await startFor(root);
    try {
      const res = await post(base, `/api/ingest?stackId=${ABSENT_STACK}`, { source: "/tmp/none.md" });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "unknown_stack", message: `No Stack '${ABSENT_STACK}' exists.` },
      });
    } finally {
      await handle.close();
    }
  }, 60_000);
});

describe("a named Stack that exists but is inactive", () => {
  it("answers stack_inactive, never unknown_stack", async () => {
    const probe = await createProbeStack("t4-stack-inactive");
    const saved = { ...process.env };
    Object.assign(process.env, probe.env());
    try {
      // The graph sub-app resolves its own pool from the KG-side `DATABASE_URL`, which no test
      // worker sets, so its routes cannot reach this row from inside a vitest process (the host's
      // `GET /stacks` answers 500 there for that reason alone). The inactivation is therefore
      // issued HERE, as the very statement `DELETE /stacks/:id` performs — `update stacks set
      // active = false ... where id = ... and active` — and the route that owns it is proven by
      // `packages/llmwiki-kg/ts/src/routes/stacks-delete.test.ts`, which drives it over a real
      // pool. What this case measures is T4's answer for the retired Stack, not T7's transition.
      await probe.harness.db.execute(sql`update stacks set active = false where id = ${probe.harness.stackId}`);

      const { root } = await projectWithSource("t4-inactive-");
      const { handle, registry, base } = await startFor(root);
      try {
        const res = await post(base, `/api/ingest?stackId=${probe.harness.stackId}`, {
          source: "/tmp/none.md",
          compile: false,
          async: true,
        });

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({
          error: {
            code: "stack_inactive",
            message: `Stack '${probe.harness.stackId}' exists but is inactive, so it cannot serve this request.`,
          },
        });
        expect(registry.list()).toHaveLength(0);
        // The two answers are different because the two FACTS are: the row is still there.
        const rows = await probe.harness.db.execute(
          sql`select id from stacks where id = ${probe.harness.stackId}`,
        );
        expect(rows).toHaveLength(1);
      } finally {
        await handle.close();
      }
    } finally {
      process.env = saved;
      await probe.harness.cleanup();
    }
  }, 60_000);
});

describe("the job reads on a host that resolved no Stack", () => {
  it("answers the named envelope instead of a bodiless 500", async () => {
    const { root } = await projectWithSource("t4-jobs-unbound-");
    // The snapshot is built while the suite's Stack is still exported, so this case measures the
    // JOB READ and nothing else: only the process's Stack declaration is removed.
    const snapshot = await buildViewerSnapshot(root);
    const named = process.env.AKS_STACK_ID;
    delete process.env.AKS_STACK_ID;
    try {
      const handle = await startHost({ viewerSnapshot: snapshot, port: 0, projectRoot: root });
      try {
        const res = await fetch(`http://${handle.host}:${handle.port}/api/ingest/jobs`);

        expect(res.status).toBe(UNNAMED.status);
        expect(await res.json()).toEqual(UNNAMED.body);
      } finally {
        await handle.close();
      }
    } finally {
      process.env.AKS_STACK_ID = named;
    }
  }, 60_000);
});

describe("a deployment with no database configured", () => {
  it("lets an unnamed ingest through, exactly as it always did", async () => {
    const { root, source } = await projectWithSource("t4-filemode-");
    const saved = { ...process.env };
    // File mode is the ABSENCE of a database, and of every row-backed dimension (S7).
    delete process.env.AKS_DATABASE_URL;
    delete process.env.AKS_STACK_ID;
    delete process.env.LLMWIKI_DIMENSIONS;
    try {
      const handle = await startHost({
        viewerSnapshot: await buildViewerSnapshot(root),
        port: 0,
        projectRoot: root,
        dimensionsPort: { resolve: async () => [] } as never,
      });
      try {
        const url = `http://${handle.host}:${handle.port}`;
        const res = await post(url, "/api/ingest", { source, compile: false });
        const body = (await res.json()) as { writeStatus?: string };

        expect(res.status).toBe(200);
        expect(body.writeStatus).toBe("created");
        expect(await readdir(path.join(root, "sources"))).toHaveLength(1);
      } finally {
        await handle.close();
      }
    } finally {
      process.env = saved;
    }
  }, 60_000);
});
