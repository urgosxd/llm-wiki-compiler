/**
 * @file test/viewer-pages-stack-scope.test.ts
 * @description `GET /api/pages` reads the Stack the REQUEST names — one process, no restart.
 *
 * ## The defect these pin
 *
 * `buildViewerSnapshot` is built ONCE at boot and served to every page request, so a Stack
 * created afterwards is served as an empty corpus until the process restarts, and a Stack
 * that was deactivated keeps being served. Both are invisible to a suite that boots one
 * Stack and reads it once: the value the boot froze and the value the request names have to
 * be DIFFERENT, and the read has to happen after the change, on a listener that was never
 * restarted.
 *
 * ## Where the Stack comes from, and why from a child process
 *
 * `POST /stacks`, `PATCH /stacks/:id` and `DELETE /stacks/:id` are the real routes, reached
 * over HTTP on the launcher bundle (`launchDatabaseHost`), so the Stack this file reads is
 * one the PUBLIC surface really created. They run in a child of their own because a
 * wiki-side suite may not import the api package (eslint `no-restricted-imports`, wiki →
 * api), and the alternative — issuing the route's `insert`/`update` SQL here — would pin
 * the viewer against setup nobody's public route wrote.
 *
 * The VIEWER, which is what this file measures, is built in THIS process
 * (`startViewerServer`) and never restarted within a case.
 *
 * ## Why the cache assertions are on `updatedAt`
 *
 * The envelope's `updatedAt` is the snapshot's own build stamp. Two reads with an UNMOVED
 * Stack row repeat it exactly when the snapshot came from the cache, and a row whose
 * `updated_at` advanced has to produce a different one. That is the observable of the named
 * invalidation without asserting anything about how the entry is stored.
 *
 * ## The one environmental fact the database needs
 *
 * `kgConfig.DATABASE_URL` is a lazy singleton read from `DATABASE_URL` at first access, and
 * the dimensions layer reads `AKS_DATABASE_URL`; both are pointed at this process's own
 * per-run database here, before the first request, so no case can reach the shared server.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKgPostgresHarness } from "./fixtures/kg-postgres.js";
import { usePerCaseFileMode, withFileMode } from "./fixtures/file-mode.js";
import { launchDatabaseHost, type Running } from "./fixtures/launcher-harness.js";
import { buildViewerSnapshot } from "../packages/wiki/src/viewer/snapshot.js";
import { startViewerServer } from "../packages/wiki/src/viewer/server.js";
import { createPageWriteSink } from "../packages/wiki/src/dimensions/wiki/page-write-sink.js";

const harness = await createKgPostgresHarness("viewer-pages-stack-scope");
const { db, reachable } = harness;

// Both channels at once: the mutation routes use the kg pool, the viewer the dimensions one.
process.env["DATABASE_URL"] = harness.url;
process.env["AKS_DATABASE_URL"] = harness.url;
// The boot this file measures resolved NO Stack, which is the shape `POST /stacks` serves.
delete process.env["AKS_STACK_ID"];

// A MIXED file: most cases are row-backed, the last one is file-backed, so the mode is per case.
usePerCaseFileMode();

/** The mutation surface: the real routes, over HTTP, on the launcher bundle. */
let mutations = "";
let mutationHost: Running | undefined;
let mutationRoot = "";

beforeAll(async () => {
  if (!reachable) return;
  mutationRoot = await mkdtemp(path.join(tmpdir(), "viewer-pages-mutations-"));
  const boot = await launchDatabaseHost(mutationRoot, harness.url);
  mutationHost = boot.running;
  mutations = boot.announced;
}, 120_000);

afterAll(async () => {
  mutationHost?.terminate();
  await mutationHost?.exited;
  if (mutationRoot !== "") await rm(mutationRoot, { recursive: true, force: true });
  await harness.cleanup();
});

/** The parts of the `/api/pages` envelope these cases assert, with the refusal envelope beside them. */
interface PagesEnvelope {
  counts: { concepts: number };
  pages: { slug: string }[];
  updatedAt: string;
  error?: { code?: string };
}

/** One page read, as the route answered it. */
interface PagesRead {
  status: number;
  body: PagesEnvelope;
}

/** A message naming the whole answer, so a failure on the body is readable. */
function describeRead(read: PagesRead): string {
  return `${read.status} ${JSON.stringify(read.body).slice(0, 300)}`;
}

/** Read `/api/pages` for the given Stack, or with no Stack named at all. */
async function getPages(base: string, stackId?: string): Promise<PagesRead> {
  const query = stackId === undefined ? "" : `?stackId=${encodeURIComponent(stackId)}`;
  const res = await fetch(`${base}/api/pages${query}`);
  return { status: res.status, body: (await res.json()) as PagesEnvelope };
}

/** Send a JSON mutation to a Stack route on the public surface and hand back the response. */
async function stackRoute(route: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${mutations}${route}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

/** Create ONE Stack through the public route, as an operator does after the first boot. */
async function createStack(label: string): Promise<string> {
  const domain = `${label}-${String(Date.now()).slice(-9)}`;
  const res = await stackRoute("/stacks", "POST", { name: label, domain });
  expect(res.status, "POST /stacks must create the Stack this case is about").toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Commit one compiled page into a Stack through the row sink the ingest/compile path uses. */
async function seedPage(stackId: string, slug: string): Promise<void> {
  await createPageWriteSink(db, stackId)({
    directory: "concepts",
    slug,
    body: `---\ntitle: ${slug}\nsummary: summary of ${slug}\n---\n\nBody for ${slug}.\n`,
  });
}

/**
 * Run `body` against an IN-PROCESS viewer booted here and never restarted.
 *
 * The snapshot is the empty one a Stack-less, database-backed boot freezes unless a
 * `bootStackId` is given, in which case it is the snapshot that boot froze for that Stack —
 * the shape a deployment has when its environment names one.
 */
async function withViewer(
  body: (base: string) => Promise<void>,
  bootStackId?: string,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "viewer-pages-scope-"));
  try {
    const snapshot = await buildViewerSnapshot(
      root,
      process.env,
      bootStackId === undefined ? undefined : { kind: "stack", stackId: bootStackId },
      bootStackId === undefined ? { stackUnresolved: true } : undefined,
    );
    const server = await startViewerServer(snapshot, { host: "127.0.0.1", port: 0 });
    try {
      await body(`http://${server.host}:${server.port}`);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Create a Stack with ONE page already committed, then run `body` against a fresh viewer.
 *
 * The three shapes below (a new Stack, a retired one, a growing one) all need the same two
 * setup steps, and repeating them is what fallow reports as a clone group.
 */
async function withSeededStack(
  label: string,
  slug: string,
  body: (base: string, stackId: string) => Promise<void>,
): Promise<void> {
  const stackId = await createStack(label);
  await seedPage(stackId, slug);
  await withViewer((base) => body(base, stackId));
}

describe.skipIf(!reachable)("a Stack created after the viewer booted", () => {
  it("serves the content ingested into it, with no restart", async () => {
    await withSeededStack("alpha-docs", "first-concept", async (base, stackId) => {
      const read = await getPages(base, stackId);
      expect(read.status, `a named Stack must be served: ${describeRead(read)}`).toBe(200);
      expect(read.body.pages.map((row) => row.slug), "the Stack's content must be visible").toEqual([
        "first-concept",
      ]);
      expect(read.body.counts.concepts, "the count must be the Stack's own").toBe(1);
    });
  });
});

describe.skipIf(!reachable)("a Stack that was deactivated", () => {
  it("is refused by name even after the same Stack was served", async () => {
    await withSeededStack("retired-docs", "retired-concept", async (base, stackId) => {
      const served = await getPages(base, stackId);
      expect(served.status, `the Stack must serve first: ${describeRead(served)}`).toBe(200);
      const retired = await stackRoute(`/stacks/${stackId}`, "DELETE");
      expect(retired.status, "DELETE /stacks/:id retires the Stack").toBe(204);
      const after = await getPages(base, stackId);
      expect(after.status, "a retired Stack must not be served").toBe(404);
      expect(after.body.error?.code, "and must say so by name").toBe("stack_inactive");
    });
  });
});

describe.skipIf(!reachable)("a cached snapshot that stays valid", () => {
  it("is served again while nothing about the Stack changes", async () => {
    await withSeededStack("cached-docs", "one", async (base, stackId) => {
      const first = await getPages(base, stackId);
      expect(first.body.counts.concepts, describeRead(first)).toBe(1);
      const second = await getPages(base, stackId);
      expect(second.body.updatedAt, "nothing moved, so the cached snapshot is served").toBe(
        first.body.updatedAt,
      );
      expect(second.body.counts.concepts).toBe(1);
    });
  });
});

describe.skipIf(!reachable)("a cache that must be rebuilt", () => {
  // The bug this half exists for: `create -> ingest -> look -> ingest more -> look`. While the
  // epoch was keyed on the Stack ROW alone, the fifth step served the snapshot the third froze.
  // The write seam now advances the epoch, so growth is visible on the next read.
  it("reflects content ingested after the first read, in one process", async () => {
    await withSeededStack("growing-docs", "one", async (base, stackId) => {
      const first = await getPages(base, stackId);
      expect(first.body.counts.concepts, describeRead(first)).toBe(1);
      await seedPage(stackId, "two");
      const grown = await getPages(base, stackId);
      expect(grown.body.pages.map((row) => row.slug).sort(), "the new content must be visible").toEqual([
        "one",
        "two",
      ]);
      expect(grown.body.counts.concepts, "and counted").toBe(2);
      expect(grown.body.updatedAt, "a rebuilt snapshot").not.toBe(first.body.updatedAt);
    });
  });

  it("rebuilds even when only the Stack row itself moves", async () => {
    await withSeededStack("touched-docs", "one", async (base, stackId) => {
      const first = await getPages(base, stackId);
      const touched = await stackRoute(`/stacks/${stackId}`, "PATCH", { description: "touched" });
      expect(touched.status, "PATCH /stacks/:id advances the row").toBe(200);
      const rebuilt = await getPages(base, stackId);
      expect(rebuilt.body.updatedAt, "an advanced epoch must be rebuilt").not.toBe(first.body.updatedAt);
    });
  });
});

describe.skipIf(!reachable)("a request that names no Stack, with a database configured", () => {
  // S9 was NARROWED here, on purpose, and this case is the pin for it: the bundled shell
  // fetches `/api/pages` with NO query (`viewer.js:104`) and renders "Could not load
  // /api/pages" when it fails (`:260`), so a refusal here blanks the dashboard of every
  // database-backed deployment. The unnamed request therefore keeps being served the
  // snapshot the BOOT froze — the Stack this deployment's environment named — and a caller
  // that wants a specific Stack names it. Do not "fix" this back to a 409.
  it("is served the boot snapshot rather than refused", async () => {
    const bootStackId = await createStack("booted-docs");
    await seedPage(bootStackId, "booted-concept");
    await withViewer(async (base) => {
      const unnamed = await getPages(base);
      expect(unnamed.status, `the dashboard's query-less fetch must answer: ${describeRead(unnamed)}`).toBe(200);
      expect(unnamed.body.pages.map((row) => row.slug), "with the boot's own snapshot").toEqual([
        "booted-concept",
      ]);
    }, bootStackId);
  });
});

describe("a deployment with no database configured", () => {
  it("is still served the boot snapshot", async () => {
    await withFileMode(async () => {
      const root = await mkdtemp(path.join(tmpdir(), "viewer-pages-file-"));
      try {
        await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
        await writeFile(
          path.join(root, "wiki", "concepts", "on-disk.md"),
          "---\ntitle: on-disk\n---\n\nBody on disk.\n",
          "utf8",
        );
        const snapshot = await buildViewerSnapshot(root);
        const server = await startViewerServer(snapshot, { host: "127.0.0.1", port: 0 });
        try {
          const read = await getPages(`http://${server.host}:${server.port}`);
          expect(read.status, `file mode names no Stack: ${describeRead(read)}`).toBe(200);
          expect(read.body.pages.map((row) => row.slug)).toEqual(["on-disk"]);
        } finally {
          await server.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
