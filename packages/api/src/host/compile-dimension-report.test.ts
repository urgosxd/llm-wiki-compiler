/**
 * @file packages/api/src/host/compile-dimension-report.test.ts
 * @description `POST /api/compile` must SAY what happened to every dimension: this route
 * composes the wiki compile and nothing else, so `kg` reads `not part of this route`
 * instead of rendering as silence.
 *
 * ## Why silence was the bug
 *
 * The operator's log said `Wiki compiled.` while the deployment carried
 * `LLMWIKI_DIMENSIONS=wiki,kg`. Nothing was missing from that run: `kg` never runs on this
 * route by design, and the word design was never written down anywhere a reader could see
 * it. So the acceptance case is a compile whose report NAMES `kg` as outside the route
 * (S5 of `odd/tasks/ingest-dimension-reporting.md`).
 *
 * ## Halves are not dimensions (S7)
 *
 * `/api/ingest` spreads `IngestResult` and `CompileResult` -- the ingest and compile
 * HALVES, not the `wiki` and `kg` DIMENSIONS -- so nothing here is modelled on that union.
 * The `dimensions` entry is a report over dimensions, produced by the one producer the
 * coordinator and every other surface share.
 *
 * ## The key set is PINNED, deliberately
 *
 * The `dimensions` key is ADDITIVE: the six keys the body already carried keep their names
 * and their values, and a consumer that ignores unknown keys keeps working. Both halves are
 * observed below rather than asserted in prose -- the exact key list, and the exact legacy
 * view -- because the next feature composes `kg` on this route and must then change this
 * contract LOUDLY instead of slipping past a passing suite.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildViewerSnapshot } from "@repo/wiki/viewer-snapshot";
import { startHost } from "./server.js";

/** The `wiki` entry a compile of an EMPTY project reports: the real counts of that run. */
const WIKI_SUMMARY = "wiki: compiled=0 skipped=0 deleted=0 concepts=0 pages=0 errors=0";

/** Every key the compile body carries, pinned in full (S5: the addition is the only change). */
const PINNED_KEYS = [
  "compiled",
  "concepts",
  "deleted",
  "dimensions",
  "errors",
  "pages",
  "skipped",
];

/** The keys the body carried BEFORE this change -- what a consumer already reads. */
const LEGACY_KEYS = ["compiled", "skipped", "deleted", "concepts", "pages", "errors"];

/**
 * The six keys a consumer that predates the report reads out of the body.
 *
 * Named once, so the compat case cannot drift into a hand-listed object that quietly
 * stopped covering a key.
 *
 * @param body - The compile 200 body.
 * @returns Exactly the legacy keys, with the values the body carried.
 */
function legacyView(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(LEGACY_KEYS.map((key) => [key, body[key]]));
}

/**
 * Post one compile on a file-backed project -- no database, no Stack -- and return its body.
 *
 * File mode is the ABSENCE of a database, so this answers 200 without provisioning
 * anything: the reporting addition may never turn that 200 into a 500 (S5), and this is
 * the deployment where a port-backed resolution would throw.
 *
 * @returns The status the route answered and the parsed body.
 */
async function compileBodyInFileMode(): Promise<{ status: number; body: Record<string, unknown> }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "compile-report-")));
  await mkdir(path.join(root, "sources"), { recursive: true });
  const saved = { ...process.env };
  delete process.env.AKS_DATABASE_URL;
  delete process.env.AKS_STACK_ID;
  delete process.env.LLMWIKI_DIMENSIONS;
  try {
    const snapshot = await buildViewerSnapshot(root);
    const handle = await startHost({ viewerSnapshot: snapshot, port: 0, projectRoot: root });
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/api/compile`, { method: "POST" });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } finally {
      await handle.close();
    }
  } finally {
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  }
}

describe("a compile reports every dimension, including the one it does not run", () => {
  it("reports kg as not part of this route and wiki as succeeded with its real counts", async () => {
    const { status, body } = await compileBodyInFileMode();

    expect(status).toBe(200);
    // Both entries, exact: a substring check would pass on a report that never named `kg`.
    expect(body.dimensions).toEqual([
      { name: "wiki", status: "succeeded", summary: WIKI_SUMMARY },
      { name: "kg", status: "skipped", reason: "not-in-route" },
    ]);
  }, 60_000);

  it("carries exactly the pinned key set, so a future contract change fails loudly", async () => {
    const { body } = await compileBodyInFileMode();

    expect(Object.keys(body).sort()).toEqual(PINNED_KEYS);
  }, 60_000);

  it("still carries every pre-existing key, with the values it always had", async () => {
    const { body } = await compileBodyInFileMode();

    // The additive claim, observed: an empty project compiled to nothing, and that is what
    // the six keys said before the report existed and must keep saying.
    expect(legacyView(body)).toEqual({
      compiled: 0,
      skipped: 0,
      deleted: 0,
      concepts: [],
      pages: [],
      errors: [],
    });
  }, 60_000);
});
