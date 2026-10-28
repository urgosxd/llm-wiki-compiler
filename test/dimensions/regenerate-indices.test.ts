/**
 * The derived navigational artifacts built from rows.
 *
 * `index.md` and `MOC.md` are written AFTER the compile. Reading a directory the run
 * no longer fills would write both empty and call it success, so the root here has no
 * `wiki/`: a non-empty artifact proves the rows answered.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { regenerateIndices } from "../../src/dimensions/wiki/page-source-seam.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";

const ALPHA = "---\ntitle: Alpha\ntags:\n  - search\n---\n\nbody\n";

describe("regenerateIndices from rows", () => {
  let harness: KgPostgresHarness;
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`idx-${randomUUID().slice(0, 8)}`);
    root = await mkdtemp(path.join(os.tmpdir(), "no-wiki-idx-"));
    env = {
      AKS_STACK_ID: harness.stackId,
      AKS_DATABASE_URL: testDatabaseUrl(),
    } as NodeJS.ProcessEnv;
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("indexes a row-backed page", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "alpha", body: ALPHA,
    });

    await regenerateIndices(root, env, { skipMoc: true });

    const index = await readFile(path.join(root, "wiki/index.md"), "utf-8");
    expect(index).toContain("Alpha");
  });

  it("writes the MOC from rows when not skipped", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "alpha", body: ALPHA,
    });

    await regenerateIndices(root, env);

    const moc = await readFile(path.join(root, "wiki/MOC.md"), "utf-8");
    expect(moc).toContain("search");
  });

  it("falls back to disk when no Stack is configured", async () => {
    // No pages anywhere: both artifacts must still be written, empty, rather than
    // skipped -- a missing index breaks `query`'s existence check on the file path.
    await regenerateIndices(root, {} as NodeJS.ProcessEnv);

    const index = await readFile(path.join(root, "wiki/index.md"), "utf-8");
    expect(index).toContain("Knowledge Wiki");
  });
});
