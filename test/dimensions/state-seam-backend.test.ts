/**
 * @file test/dimensions/state-seam-backend.test.ts
 * @description The state seam picks rows or files from the same variable, and never
 * reads one while writing the other.
 *
 * The failure this prevents is subtle: a caller that LOADS rows and SAVES a file
 * leaves `state.json` describing work nothing will ever load, so the next compile
 * re-derives everything. That mismatch is what makes a half-migrated state worse than
 * an unmigrated one.
 *
 * The roots here have NO `.llmwiki/`. A file-backed path would create one, so the
 * assertion that it never appears is what proves the row backend was used.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStateClassifiedFor, writeStateFor } from "../../src/dimensions/wiki/page-source-seam.js";
import { readWikiStateFromRows } from "../../src/dimensions/wiki/wiki-state-source.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

const DSN_ENV = "AKS_DATABASE_URL";

let harness: KgPostgresHarness;
let root: string;

beforeEach(async () => {
  harness = await createKgPostgresHarness(`seam-${randomUUID().slice(0, 8)}`);
  root = await mkdtemp(path.join(os.tmpdir(), "state-seam-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await harness.cleanup();
});

/** Environment naming this harness's Stack, so the seam reaches real rows. */
function stackEnv(): NodeJS.ProcessEnv {
  return {
    AKS_STACK_ID: harness.stackId,
    [DSN_ENV]: process.env.LLMWIKI_TEST_DATABASE_URL ?? "",
  } as NodeJS.ProcessEnv;
}

/** True when the project has a `.llmwiki/` directory. */
async function hasPrivateDir(): Promise<boolean> {
  return (await readdir(root).catch(() => [] as string[])).includes(".llmwiki");
}

describe("the state seam", () => {
  it("reports a fresh Stack as missing, not as an error", async () => {
    const classified = await readStateClassifiedFor(root, stackEnv());

    expect(classified.status).toBe("missing");
    expect(classified.state.sources).toEqual({});
  });

  it("persists to ROWS when a Stack is configured, creating no .llmwiki/", async () => {
    const env = stackEnv();
    const { state } = await readStateClassifiedFor(root, env);
    state.frozenSlugs = ["frozen-through-seam"];

    await writeStateFor(root, state, env);

    // The row holds it...
    const fromRows = await readWikiStateFromRows(harness.db, harness.stackId);
    expect(fromRows.frozenSlugs).toEqual(["frozen-through-seam"]);
    // ...and no file was created anywhere.
    expect(await hasPrivateDir()).toBe(false);
  });

  it("reads back what it wrote, through the seam", async () => {
    const env = stackEnv();
    const { state } = await readStateClassifiedFor(root, env);
    state.frozenSlugs = ["round-trip"];
    await writeStateFor(root, state, env);

    const again = await readStateClassifiedFor(root, env);
    // A Stack with only frozen slugs and no sources is still a configured Stack:
    // reporting "missing" here would make the caller discard what it just wrote.
    expect(again.status).toBe("ok");
    expect(again.state.frozenSlugs).toEqual(["round-trip"]);
  });

  it("uses FILES when no Stack is configured, leaving rows untouched", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const { state } = await readStateClassifiedFor(root, env);
    state.frozenSlugs = ["file-path"];
    await writeStateFor(root, state, env);

    expect(await hasPrivateDir()).toBe(true);
    const fromRows = await readWikiStateFromRows(harness.db, harness.stackId);
    expect(fromRows.frozenSlugs).toBeUndefined();
  });
});
