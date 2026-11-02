/**
 * @file test/newsroom-profile.test.ts
 * @description Second-profile genericity proof (CLP Phase-7 C1). A deliberately
 * dissimilar `newsroom` profile (three unrelated entity types + one relation) drives
 * the SAME read surfaces the research proof does — status counts, JSON export, viewer
 * graph, lint, and the context pool — with ZERO core code specific to it. If a tiny
 * unrelated fixture can run the machinery, the machinery is not secretly research-shaped.
 */
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectStatus } from "../src/status/collect.js";
import { exportJson } from "../src/commands/export.js";
import { lint } from "../src/linter/index.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { buildContextPack } from "../src/context/build.js";
import { runCLI } from "./fixtures/run-cli.js";
import {
  buildNewsroomProject,
  NEWSROOM_ENTITY_TYPES,
} from "./fixtures/newsroom-profile.js";

let root = "";
const EXPECTED_ENTITY_COUNTS = { articles: 1, desks: 1, bylines: 1 };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "newsroom-profile-"));
  await buildNewsroomProject(root);
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("newsroom profile — genericity proof over the shared read surfaces", () => {
  it("status reports per-type entity counts", async () => {
    const result = await collectStatus(root);
    expect(result.profile?.profileId).toBe("newsroom");
    expect(result.profile?.entityCounts).toEqual(EXPECTED_ENTITY_COUNTS);
  });

  it("export carries the typed pages; lint is clean", async () => {
    const doc = await exportJson(root);
    expect(doc.profile?.entityPages).toHaveLength(3);
    const types = new Set(doc.profile?.entityPages.map((p) => p.entityType));
    for (const t of NEWSROOM_ENTITY_TYPES) expect(types.has(t)).toBe(true);
    const { results } = await lint(root);
    expect(results.some((r) => r.severity === "error")).toBe(false);
  });

  it("viewer graph surfaces the typed nodes", async () => {
    const snapshot = await buildViewerSnapshot(root);
    expect(snapshot.graph.nodes.filter((n) => n.nodeKind === "entity")).toHaveLength(3);
  });

  it("ranks a typed entity page into primary[] for a matching prompt", async () => {
    // "Dockworkers" appears only in the seeded article body — mirrors the
    // research proof's context-pool assertion (test/research-profile.test.ts),
    // adapted to newsroom vocabulary.
    const pack = await buildContextPack({ root, prompt: "Dockworkers" });
    const ids = pack.primary.map((p) => p.id as unknown as string);
    expect(ids).toContain("articles/port-strike-latest");
  });
});
