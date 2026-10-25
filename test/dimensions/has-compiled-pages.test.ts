/**
 * The compile-first gate asks about PAGES, not about the derived index file.
 *
 * `existsSync(index.md)` was used as a proxy for "has anything been compiled". The
 * index is a projection of the pages, so its absence never proved that -- and in a
 * Stack-backed project there is no file even when every page is present.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasCompiledPages } from "../../src/dimensions/wiki/page-source-seam.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** Environment naming THIS harness's Stack, so the seam reaches real rows. */
function envFor(harness: KgPostgresHarness): NodeJS.ProcessEnv {
  return {
    AKS_STACK_ID: harness.stackId,
    AKS_DATABASE_URL: process.env.LLMWIKI_TEST_DATABASE_URL ?? "",
  } as NodeJS.ProcessEnv;
}

describe("hasCompiledPages", () => {
  let harness: KgPostgresHarness;
  let root: string;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`has-${randomUUID().slice(0, 8)}`);
    root = await mkdtemp(path.join(os.tmpdir(), "no-wiki-has-"));
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("is false on an empty project", async () => {
    expect(await hasCompiledPages(root, {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is true from disk even with no index file", async () => {
    // The exact case the old gate got wrong: pages present, index absent.
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(root, "wiki/concepts/a.md"), "---\ntitle: A\n---\n\nbody\n");

    expect(await hasCompiledPages(root, {} as NodeJS.ProcessEnv)).toBe(true);
  });

  it("is true from rows with no wiki/ directory at all", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "a", body: "---\ntitle: A\n---\n\nbody\n",
    });

    expect(await hasCompiledPages(root, envFor(harness))).toBe(true);
  });
});
