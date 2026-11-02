/**
 * @file test/dimensions/row-page-batch-atomicity.test.ts
 * @description A row-backed page BATCH must land all-or-nothing, like a file batch.
 *
 * ## The defect this pins
 *
 * The file backend opens ONE journal batch and records every target's pre-state
 * before any write lands, so a failure halfway through leaves the batch `pending`
 * and `replayJournal` restores the whole set. The row backend inherited the same
 * per-target LOOP (`applyBatch`, `executor.ts`) but no equivalent unit: each
 * `upsertStoredPage` opened its own transaction through `withTenant`, so N pages
 * committed as N transactions and a failure on page 3 left pages 1-2 durable.
 *
 * `needsJournal` returns `false` whenever a `pageSink` is present, so there was no
 * journal file to replay either — the design assumed there was nothing to recover.
 *
 * ## Why the earlier suites could not see this
 *
 * `journal-skipped-on-rows.test.ts` uses a `recordingSink()` that pushes to an
 * array, so no transaction exists at all. `page-delete-rows.test.ts` uses the real
 * Postgres harness but removes ONE page, where one transaction and one page are
 * indistinguishable. Proving atomicity needs a failure in the MIDDLE of a batch.
 *
 * ## Why the seams come from `resolvePageSeams`
 *
 * The obvious test would hand `applyApprovedMutationsLocked` a `pageSink` and a
 * `pageBatchTransaction` it builds itself — and would then pass while production
 * forgot to wire either one. That is the same "test proves an option nobody passes"
 * trap this file exists to avoid. These cases resolve the options through the REAL
 * seam the compiler uses, so a broken wiring fails here.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyApprovedMutationsLocked } from "../../src/trust/executor.js";
import { pageStoreOptions, type PageSink } from "../../src/trust/page-apply.js";
import { getStoredPage } from "../../src/dimensions/wiki/page-store.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { resolvePageSeams, type PageSeams } from "../../src/dimensions/wiki/page-source-seam.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** One page-create mutation, in the shape the executor plans. */
function pageCreate(slug: string) {
  return {
    kind: "page",
    operation: "create" as const,
    body: `---\ntitle: ${slug}\n---\n\nbody of ${slug}\n`,
    target: { directory: "concepts", slug },
    provenance: { origin: "test", decision: "allow" as const, reviewRouted: false },
  };
}

const BATCH = ["alpha", "beta", "gamma"] as const;

/**
 * A sink that stores through the REAL row store but throws on the Nth call.
 *
 * Failing the sink rather than the database is deliberate: it is the failure a
 * crash or a rejected write produces mid-batch, and it arrives AFTER earlier pages
 * already committed their own transaction — precisely the window under test.
 */
function failingSink(real: PageSink, failOnCall: number): PageSink {
  let calls = 0;
  return async (request) => {
    calls += 1;
    if (calls === failOnCall) throw new Error(`synthetic failure on ${request.slug}`);
    await real(request);
  };
}

describe("a row-backed page batch is all-or-nothing", () => {
  let root: string;
  let harness: KgPostgresHarness;
  let seams: PageSeams;
  let savedStackId: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "row-batch-"));
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    harness = await createKgPostgresHarness(`batch-${randomUUID().slice(0, 8)}`);
    savedStackId = process.env.AKS_STACK_ID;
    process.env.AKS_STACK_ID = harness.stackId;
    seams = resolvePageSeams(harness.db, process.env);
  });

  afterEach(async () => {
    if (savedStackId === undefined) delete process.env.AKS_STACK_ID;
    else process.env.AKS_STACK_ID = savedStackId;
    await rm(root, { recursive: true, force: true });
    await harness.cleanup();
  });

  /** Every page in the batch that is a durable row right now. */
  async function surviving(slugs: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    for (const slug of slugs) {
      if ((await getStoredPage(harness.db, harness.stackId, "concepts", slug)) !== undefined) {
        found.push(slug);
      }
    }
    return found;
  }

  /** The resolved row sink, asserted present so a missing Stack fails loudly. */
  function requireSink(): PageSink {
    if (seams.sink === undefined) throw new Error("no row sink resolved — is the Stack bound?");
    return seams.sink;
  }

  /** The resolved seams as the options a batch call takes, via the production mapper. */
  function batchOptions(remover = seams.remover, sink = seams.sink) {
    // `pageStoreOptions` is what every compile call site uses to turn the three
    // seams into the three options. Building the object by hand here would test a
    // mapping production does not perform — and the field names really do differ
    // (`sink`/`transaction` vs `pageSink`/`pageBatchTransaction`).
    return pageStoreOptions(sink, remover, seams.transaction);
  }

  it("leaves NO page behind when the second write of three throws", async () => {
    if (!harness.reachable) return;

    await expect(
      applyApprovedMutationsLocked(
        root,
        BATCH.map((slug) => pageCreate(slug)),
        batchOptions(undefined, failingSink(requireSink(), 2)),
      ),
    ).rejects.toThrow(/synthetic failure on beta/);

    // The whole batch is undone. Before the fix this was ["alpha"]: page one
    // committed in its own transaction and page two threw.
    expect(await surviving(BATCH)).toEqual([]);
  });

  it("still lands every page when nothing throws", async () => {
    // The non-vacuity control: a wrapper that discarded every write would also
    // satisfy the test above, so the happy path is asserted too.
    if (!harness.reachable) return;

    await applyApprovedMutationsLocked(root, BATCH.map((slug) => pageCreate(slug)), batchOptions());

    expect(await surviving(BATCH)).toEqual([...BATCH]);
  });

  it("leaves BOTH rows when the second removal of a delete batch throws", async () => {
    if (!harness.reachable) return;
    const slugs = ["one", "two"];

    const seed = createPageWriteSink(harness.db, harness.stackId);
    for (const slug of slugs) {
      await seed({ directory: "concepts", slug, body: `---\ntitle: ${slug}\n---\n\nbody ${slug}\n` });
    }
    expect(await surviving(slugs)).toEqual(slugs);

    let removals = 0;
    const failingRemover = async (request: { directory: string; slug: string }) => {
      removals += 1;
      if (removals === 2) throw new Error(`synthetic removal failure on ${request.slug}`);
      if (seams.remover === undefined) throw new Error("no row remover resolved");
      await seams.remover(request);
    };

    await expect(
      applyApprovedMutationsLocked(
        root,
        slugs.map((slug) => ({ ...pageCreate(slug), operation: "delete" as const, body: "" })),
        batchOptions(failingRemover),
      ),
    ).rejects.toThrow(/synthetic removal failure/);

    expect(await surviving(slugs)).toEqual(slugs);
  });
});
