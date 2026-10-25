/**
 * The seam that decides WHICH backend the page registry reads.
 *
 * `withRegistrySource` is the single point where the search and answer paths choose
 * rows or files. Its two branches must stay distinguishable: a caller with no Stack
 * must receive `undefined` (the disk path, unchanged), and a caller with a Stack must
 * receive a source that answers from rows even when the root holds no `wiki/` at all.
 *
 * That second assertion is the one worth having. A seam that silently fell back to
 * disk when rows were expected would pass every other test in the suite while making
 * a Stack-backed wiki lose every page, so the fixture root is deliberately empty.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLiveIdSet, buildNamespaceDirs } from "../../src/utils/page-registry.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { withRegistrySource } from "../../src/dimensions/wiki/page-source-seam.js";
import { DATABASE_URL, createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** The two variables the seam reads: the tenant and the database it lives in. */
const STACK_ENV = "AKS_STACK_ID";
const DATABASE_ENV = "AKS_DATABASE_URL";

/** A minimal compiled page, written through the same sink a compile uses. */
const PAGE = "---\ntitle: Alpha\nsummary: first letter\n---\n\nalpha body\n";

describe("withRegistrySource", () => {
  let harness: KgPostgresHarness;
  let root: string;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`wrs-${randomUUID().slice(0, 8)}`);
    root = mkdtempSync(path.join(tmpdir(), "wrs-"));
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("hands back undefined when no Stack is configured", async () => {
    const seen = await withRegistrySource({}, async (source) => source);
    expect(seen).toBeUndefined();
  });

  it("answers live ids from rows for a root with no wiki directory", async () => {
    const sink = createPageWriteSink(harness.db, harness.stackId);
    await sink({ directory: "concepts", slug: "alpha", body: PAGE });
    const live = await withRegistrySource(
      { [STACK_ENV]: harness.stackId, [DATABASE_ENV]: DATABASE_URL },
      (source) =>
        buildLiveIdSet(root, ["concepts"], buildNamespaceDirs(), undefined, source),
    );
    expect([...live]).toContain("concepts/alpha");
  });
});
