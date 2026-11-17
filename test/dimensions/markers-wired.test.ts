/**
 * @file test/dimensions/markers-wired.test.ts
 * @description With a Stack configured, the three markers live in rows.
 *
 * The roots have NO `.llmwiki/`. A file-backed writer creates one, so asserting it
 * never appears is what proves the row path was taken. The settle case matters most:
 * a marker written to a file while reads come from rows would re-queue work that
 * already succeeded, forever.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingEmbeddings,
  loadPendingEmbeddings,
  writePendingEmbeddings,
} from "../../packages/wiki/src/utils/pending-embeddings.js";
import { readRuleState, updateRuleSourceState } from "../../packages/wiki/src/compiler/rule-state.js";
import { readLintCache, writeLintCache } from "../../packages/wiki/src/linter/cache.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { createStackEnvBinding, describeRestoredStackEnv } from "../fixtures/env-stack.js";
import { createProbeStack } from "./harness-lifecycle.js";

let harness: KgPostgresHarness;
let root: string;

/**
 * The apply/restore pair this file wraps around each seam exercise.
 *
 * One per file, at module scope, because {@link describeRestoredStackEnv} below has to install
 * the SAME binding these tests use for its control cases to be about this file's wiring.
 *
 * The suite setup publishes this run's database URL into both variables before any test module
 * loads, so cleanup puts THAT value back: dropping the variable instead makes the next file's
 * `createDimensionsDatabase(process.env)` fall through to the vendored default on port 5432, and
 * `""` reads as absent the same way.
 */
const stackEnv = createStackEnvBinding();

beforeEach(async () => {
  harness = (await createProbeStack("mk-wired")).harness;
  root = await mkdtemp(path.join(os.tmpdir(), "markers-wired-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await harness.cleanup();
  stackEnv.clear();
});

/** True when the project has a `.llmwiki/` directory. */
async function hasPrivateDir(): Promise<boolean> {
  return (await readdir(root).catch(() => [] as string[])).includes(".llmwiki");
}

describe("markers with a Stack configured", () => {
  it("writes pending embeddings to rows, creating no .llmwiki/", async () => {
    stackEnv.apply(harness.stackId);
    await writePendingEmbeddings(root, [{ pageId: "concepts/alpha", attempts: 1 }]);

    const loaded = await loadPendingEmbeddings(root, 10);
    expect(loaded.map((entry) => entry.pageId)).toContain("concepts/alpha");
    expect(await hasPrivateDir()).toBe(false);
  });

  it("clears the ROW when the queue drains, not a file that is not there", async () => {
    // The defect this guards: a clear that only unlinks a file is a complete no-op
    // with rows, leaving every id queued for a retry that already succeeded.
    stackEnv.apply(harness.stackId);
    await writePendingEmbeddings(root, [{ pageId: "concepts/alpha", attempts: 1 }]);
    await clearPendingEmbeddings(root);

    expect(await loadPendingEmbeddings(root, 10)).toEqual([]);
  });

  it("round-trips the rule cursor through rows", async () => {
    stackEnv.apply(harness.stackId);
    await updateRuleSourceState(root, "sources/a.md", {
      hash: "h1", concepts: [], compiledAt: "2026-02-01T10:00:00.000Z", version: 2,
    } as never);

    const state = await readRuleState(root);
    expect(state.sources["sources/a.md"]?.hash).toBe("h1");
    expect(await hasPrivateDir()).toBe(false);
  });

  it("round-trips the lint cache through rows", async () => {
    stackEnv.apply(harness.stackId);
    await writeLintCache(root, {
      results: [], warnings: 2, errors: 0,
    } as never);

    const cached = await readLintCache(root);
    expect(cached?.warnings).toBe(2);
    expect(await hasPrivateDir()).toBe(false);
  });
});

// The two control cases that pin the restore semantics. Registered from the shared fixture so this
// file and `graph-backend-wired.test.ts` run one copy of them, against their OWN binding.
describeRestoredStackEnv(stackEnv);
