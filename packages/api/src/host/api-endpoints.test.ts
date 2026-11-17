/**
 * @file packages/api/src/host/api-endpoints.test.ts
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
 *
 * WHY THE COMPILE ROUTE NAMES ITS STACK. `POST /api/compile` reads and writes ONE Stack's
 * pages, so a request that names none must be refused by name instead of compiling under
 * whichever Stack the process was started with (S3 of the Stack-authority feature). Status
 * alone cannot tell that refusal from lock contention — both are 409 — so these cases
 * assert the body's `code` and, for a rejected compile, that the project gained no artifact
 * at all: no lock file, nothing compiled.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { buildViewerSnapshot } from "@repo/wiki/viewer-snapshot";
import { startHost } from "./server.js";
import { acquireLock, releaseLock } from "@repo/wiki/utils-lock";
import { useStackEnv } from "../../../../test/fixtures/stack-env.js";
import { createProbeStack } from "../../../../test/dimensions/harness-lifecycle.js";

/** The one `stack_unnamed` wording, as the `{ error: { code, message } }` envelope carries it. */
const UNNAMED = {
  code: "stack_unnamed",
  message: "This request named no Stack, and a database is configured: name one with ?stackId=.",
};

/** A well-formed Stack id that names no row. */
const ABSENT_STACK = "00000000-0000-4000-8000-000000000000";

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

/** The `error.code` a refusal carries — the part a client branches on, not the status. */
async function codeOf(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code;
}

/** The Stack this suite's environment names, as the query string a request must send. */
function namedStackQuery(): string {
  return `stackId=${process.env.AKS_STACK_ID ?? ""}`;
}

/**
 * Run `body` with `overrides` applied on top of the process environment, then restore it.
 *
 * A key mapped to `undefined` is REMOVED, which is how a case declares an absence the product
 * branches on -- no database configured, no Stack named -- without a hand-rolled save/delete/
 * restore block per case. Those blocks were byte-identical copies of the shape another suite
 * already writes, so they drifted into clone groups; one helper means a case can only forget
 * its restore in one place.
 *
 * @param overrides - Variables to set, or to REMOVE when the value is `undefined`.
 * @param body - The case body, run with the environment in place.
 */
async function withProcessEnv(
  overrides: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await body();
  } finally {
    process.env = saved;
  }
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
      // Both mutation routes must be retryable conflicts, not failures. Each NAMES the Stack,
      // because an unnamed request on a database-configured host is refused `stack_unnamed`
      // before the lock is ever tried (S3) — and it is the BODY CODE that tells them apart,
      // never the status the two refusals share.
      expect(await codeOf(await post(`/api/ingest?${namedStackQuery()}`, { source }))).toBe("busy");
      expect(await codeOf(await post(`/api/compile?${namedStackQuery()}`))).toBe("busy");
      // And the Stack refusal comes FIRST: with the lock still held, an unnamed compile names
      // the Stack it needs instead of the lock it never reached.
      expect(await codeOf(await post("/api/compile"))).toBe("stack_unnamed");
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
/**
 * Post one compile the route must REFUSE, with the project lock already held by `lockEnv`'s
 * Stack.
 *
 * Taking the lock is the FIRST thing a compile does — before the recovery gate, before any
 * page is read — so an answer that names the Stack rather than reporting `busy` proves the
 * refusal came before any compile work at all. Status alone would not: the two refusals are
 * the same 409, and the body's code is the only thing that tells them apart.
 *
 * @param post - Poster scoped to the running host.
 * @param root - Project root the lock is taken in.
 * @param route - Route to post, query string included.
 * @param expected - The exact envelope the refusal must carry.
 * @param lockEnv - Environment the held lock is keyed by.
 */
async function expectRefusedBeforeWork(
  post: (route: string) => Promise<Response>,
  root: string,
  route: string,
  expected: { status: number; code: string; message: string },
  lockEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  expect(await acquireLock(root, { quiet: true, env: lockEnv })).toBe(true);
  try {
    const res = await post(route);

    expect(res.status).toBe(expected.status);
    expect(await res.json()).toEqual({ error: { code: expected.code, message: expected.message } });
  } finally {
    await releaseLock(root, lockEnv);
  }
}

describe("a compile on a host with a database configured", () => {
  // The suite names a Stack in the PROCESS environment, which is exactly the situation that
  // must not leak into a request: the compile below names none and must still be refused.
  useStackEnv("host-api-compile");

  it("refuses a compile that names no Stack instead of borrowing the process environment", async () => {
    const root = await projectRoot();
    const { handle, post } = await startFor(root);
    try {
      // The lock is held for the Stack this suite's PROCESS names, so a compile that inherited
      // it would answer `busy`. It must name the Stack it needs instead: no lock taken, no
      // journal gate, no page read, nothing written.
      await expectRefusedBeforeWork(post, root, "/api/compile", { status: 409, ...UNNAMED });
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("compiles under the Stack the request names, not the one the process names", async () => {
    const root = await projectRoot();
    const named = process.env.AKS_STACK_ID ?? "";
    const { handle, post } = await startFor(root);
    try {
      // The process is made to name NO Stack, so a 200 here can only come from the request's
      // own `?stackId=`: whatever the environment says is not carried into the compile.
      delete process.env.AKS_STACK_ID;
      const res = await post(`/api/compile?stackId=${named}`);

      expect(res.status).toBe(200);
    } finally {
      process.env.AKS_STACK_ID = named;
      await handle.close();
    }
  }, 30_000);

});

// The two refusals a NAMED Stack can earn, kept beside each other because they are one
// question -- can this deployment use the Stack this request named -- read in two directions.
describe("a compile whose named Stack cannot be used", () => {
  useStackEnv("host-api-compile-refused");

  it("refuses an id that is not a Stack id as the client's mistake", async () => {
    const root = await projectRoot();
    const { handle, post } = await startFor(root);
    try {
      const res = await post("/api/compile?stackId=not-a-stack");

      // A malformed id is not an outage: 503 `stack_lookup_failed` would invite a retry and
      // report the client's typo as the database's fault.
      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe("invalid_request");
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("answers unknown_stack for a well-formed id that names no row", async () => {
    const root = await projectRoot();
    const { handle, post } = await startFor(root);
    try {
      const res = await post(`/api/compile?stackId=${ABSENT_STACK}`);

      expect(res.status).toBe(404);
      expect(await codeOf(res)).toBe("unknown_stack");
    } finally {
      await handle.close();
    }
  }, 30_000);
});

describe("a compile that names a Stack the database cannot serve", () => {
  it("answers stack_inactive, never unknown_stack, and compiles nothing", async () => {
    const probe = await createProbeStack("host-api-compile-inactive");
    // Issued as the very statement `DELETE /stacks/:id` performs, for the reason
    // `stack-refusal-envelope.test.ts` records: the graph sub-app resolves its own pool from
    // the KG-side `DATABASE_URL`, which no vitest worker sets. The transition itself is proven
    // by `stacks-delete.test.ts`; this case measures the compile route's answer for a retired
    // Stack.
    await probe.harness.db.execute(sql`update stacks set active = false where id = ${probe.harness.stackId}`);
    try {
      await withProcessEnv(probe.env(), async () => {
        const root = await projectRoot();
        const { handle, post } = await startFor(root);
        try {
          // The lock is held for the RETIRED Stack, so a route that accepted it would compile
          // and answer `busy`; the refusal is what must come back.
          await expectRefusedBeforeWork(post, root, `/api/compile?stackId=${probe.harness.stackId}`, {
            status: 404,
            code: "stack_inactive",
            message: `Stack '${probe.harness.stackId}' exists but is inactive, so it cannot serve this request.`,
          }, probe.env());
        } finally {
          await handle.close();
        }
      });
    } finally {
      await probe.harness.cleanup();
    }
  }, 60_000);
});

describe("a compile with no database configured", () => {
  it("still compiles with no Stack named, exactly as it always did", async () => {
    const root = await projectRoot();
    // File mode is the ABSENCE of a database, and of every row-backed dimension (S7).
    const fileMode = { AKS_DATABASE_URL: undefined, AKS_STACK_ID: undefined, LLMWIKI_DIMENSIONS: undefined };
    await withProcessEnv(fileMode, async () => {
      const handle = await startHost({
        viewerSnapshot: await buildViewerSnapshot(root),
        port: 0,
        projectRoot: root,
      });
      try {
        const res = await fetch(`http://${handle.host}:${handle.port}/api/compile`, { method: "POST" });

        // No database means no Stack to name, so the refusal must not reach this deployment.
        // The file lock the compile takes in `.llmwiki/` is what proves the work really ran.
        expect(res.status).toBe(200);
        expect(await readdir(root)).toContain(".llmwiki");
      } finally {
        await handle.close();
      }
    });
  }, 60_000);
});
