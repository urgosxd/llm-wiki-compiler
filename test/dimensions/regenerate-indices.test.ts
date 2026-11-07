/**
 * The derived navigational artifacts built from rows.
 *
 * `index.md` and `MOC.md` are written AFTER the compile. Reading a directory the run
 * no longer fills would write both empty and call it success, so the root here has no
 * `wiki/`: a non-empty artifact proves the rows answered.
 *
 * ## What the two destinations are, and why these cases assert BOTH
 *
 * The documented behaviour is a split, not a redirect: a project with a Stack stores
 * both artifacts as that Stack's ROWS and writes no file, and a project with no Stack
 * keeps the file it always had. These cases used to read `wiki/index.md` and
 * `wiki/MOC.md` while `env` named a Stack -- which passed only because the artifact
 * destination was resolved from `process.env` rather than from `env`, the tenant leak
 * this suite's sibling file (`test/compile-request-stack-derived-env.test.ts`) pins.
 * So each case now asserts the row's CONTENT and the file's ABSENCE together: content
 * alone would also be satisfied by a run that wrote both places, and absence alone by
 * a run that wrote nothing anywhere. The no-Stack case keeps the file fallback, which
 * is the other half of the same contract.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { regenerateIndices } from "../../src/dimensions/wiki/page-source-seam.js";
import { withDerivedSource } from "../../src/dimensions/wiki/derived-artifact-source.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";

const ALPHA = "---\ntitle: Alpha\ntags:\n  - search\n---\n\nbody\n";

/** The artifact `env`'s Stack stored for `kind`, read through the production seam. */
async function storedArtifact(
  env: NodeJS.ProcessEnv,
  kind: "index" | "moc",
): Promise<string | undefined> {
  return withDerivedSource(env, async (source) => source?.read(kind));
}

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

    expect(await storedArtifact(env, "index")).toContain("Alpha");
    expect(existsSync(path.join(root, "wiki/index.md"))).toBe(false);
  });

  it("writes the MOC from rows when not skipped", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "alpha", body: ALPHA,
    });

    await regenerateIndices(root, env);

    expect(await storedArtifact(env, "moc")).toContain("search");
    expect(existsSync(path.join(root, "wiki/MOC.md"))).toBe(false);
  });

  it("falls back to disk when no Stack is configured", async () => {
    // No pages anywhere: both artifacts must still be written, empty, rather than
    // skipped -- a missing index breaks `query`'s existence check on the file path.
    await regenerateIndices(root, {} as NodeJS.ProcessEnv);

    const index = await readFile(path.join(root, "wiki/index.md"), "utf-8");
    expect(index).toContain("Knowledge Wiki");
  });
});
