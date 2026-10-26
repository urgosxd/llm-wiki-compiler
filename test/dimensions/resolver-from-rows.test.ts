/**
 * Link resolution reading pages from rows.
 *
 * The property: the same wikilinks must be produced whether the pages came from disk
 * or from the table. Resolution is read-modify-write inside the compile, so a
 * divergence here silently stops interlinking pages that live in the DB.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLinks } from "../../src/compiler/resolver.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { createResolverPageSource } from "../../src/dimensions/wiki/page-scan-source.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

const ALPHA = "---\ntitle: Alpha\n---\n\nAlpha mentions Beta but is not linked.\n";
const BETA = "---\ntitle: Beta\n---\n\nBeta stands alone.\n";

describe("link resolution from rows", () => {
  let harness: KgPostgresHarness;
  let root: string;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`resolve-${randomUUID().slice(0, 8)}`);
    root = await mkdtemp(path.join(os.tmpdir(), "resolve-"));
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("adds the same wikilink from rows as from disk", async () => {
    await writeFile(path.join(root, "wiki/concepts/alpha.md"), ALPHA);
    await writeFile(path.join(root, "wiki/concepts/beta.md"), BETA);
    const sink = createPageWriteSink(harness.db, harness.stackId);
    await sink({ directory: "concepts", slug: "alpha", body: ALPHA });
    await sink({ directory: "concepts", slug: "beta", body: BETA });

    const fromDisk = await resolveLinks(root, ["alpha"], ["beta"]);
    const fromRows = await resolveLinks(
      root, ["alpha"], ["beta"], createResolverPageSource(harness.db, harness.stackId),
    );

    expect(fromRows.map((w) => w.slug)).toEqual(fromDisk.map((w) => w.slug));
    expect(fromRows[0]?.body).toContain("[[beta|Beta]]");
  });

  it("returns nothing when the page is already linked", async () => {
    const linked = "---\ntitle: Alpha\n---\n\nAlpha links [[beta|Beta]] already.\n";
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "alpha", body: linked,
    });
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "beta", body: BETA,
    });

    const writes = await resolveLinks(
      root, ["alpha"], ["beta"], createResolverPageSource(harness.db, harness.stackId),
    );

    expect(writes).toEqual([]);
  });

  /**
   * The INBOUND pass, which is a different code path from the outbound one above.
   *
   * Inbound resolves a page that did not itself change by scanning it for a NEW
   * title, and it used to re-read that page from disk instead of using the text the
   * title index had already supplied. With a row corpus the read found nothing, so
   * resolution silently produced zero links while the compile reported success.
   */
  it("adds inbound links from rows with no page on disk", async () => {
    const sink = createPageWriteSink(harness.db, harness.stackId);
    await sink({ directory: "concepts", slug: "alpha", body: ALPHA });
    await sink({ directory: "concepts", slug: "beta", body: BETA });

    // `beta` is NEW and `alpha` is untouched: only the inbound pass can link them.
    const writes = await resolveLinks(
      root, [], ["beta"], createResolverPageSource(harness.db, harness.stackId),
    );

    expect(writes.map((w) => w.slug)).toEqual(["alpha"]);
    expect(writes[0]?.body).toContain("[[beta|Beta]]");
  });
});
