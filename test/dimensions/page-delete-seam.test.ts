/**
 * @file test/dimensions/page-delete-seam.test.ts
 * @description `llmwiki rm` must delete the ROW when pages are rows.
 *
 * `deleteWikiPagesLocked` unlinks `wiki/concepts/<slug>.md`. With a Stack that file
 * does not exist: the page is a row. `confinedUnlink` swallows every error so the
 * unlink "succeeds", `assertUnlinked` then sees ENOENT and concludes the delete
 * worked, and the batch commits. The command reports success while the row is still
 * there — a complete no-op wearing the shape of a fix, the same defect class as the
 * delete path in `applyPageMutationLocked` (11894bc).
 *
 * The row remover is passed in rather than resolved from the environment, mirroring
 * the write path: `applyApprovedMutationsLocked` takes a `pageRemover` and never
 * opens a database itself, so the module stays free of the dimensions graph.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deleteWikiPagesLocked } from "../../src/wiki/delete-page.js";
import { createPageWriteSink, createPageRemoveSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { getStoredPage } from "../../src/dimensions/wiki/page-store.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { withStackEnv } from "../fixtures/stack-env.js";
import { withPageRemover } from "../../src/dimensions/wiki/page-source-seam.js";

const BODY = "---\ntitle: Doomed\n---\n\nbody\n";

/** A project root plus a Stack, torn down together. */
async function withStack(
  label: string,
  body: (root: string, harness: KgPostgresHarness) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `${label}-`));
  const harness = await createKgPostgresHarness(`${label}-${randomUUID().slice(0, 8)}`);
  try {
    await body(root, harness);
  } finally {
    await rm(root, { recursive: true, force: true });
    await harness.cleanup();
  }
}

describe("deleting a page whose store is rows", () => {
  it("removes the ROW when a page remover is supplied", () =>
    withStack("del-seam", async (root, harness) => {
      const sink = createPageWriteSink(harness.db, harness.stackId);
      await sink({ directory: "concepts", slug: "doomed", body: BODY });
      expect(await getStoredPage(harness.db, harness.stackId, "concepts", "doomed")).toBeDefined();

      const { skipped } = await deleteWikiPagesLocked(root, ["doomed"], {
        pageRemover: createPageRemoveSink(harness.db, harness.stackId),
      });

      expect(skipped).toEqual([]);
      expect(await getStoredPage(harness.db, harness.stackId, "concepts", "doomed")).toBeUndefined();
    }));

  it("writes no journal and no wiki directory when deleting a row", () =>
    withStack("del-nofs", async (root, harness) => {
      const sink = createPageWriteSink(harness.db, harness.stackId);
      await sink({ directory: "concepts", slug: "doomed", body: BODY });

      await deleteWikiPagesLocked(root, ["doomed"], {
        pageRemover: createPageRemoveSink(harness.db, harness.stackId),
      });

      // A row delete has no previous bytes to snapshot and is already transactional,
      // so there is nothing to journal. Creating the journal dir would be a
      // filesystem effect on the backend that must have none.
      expect(existsSync(path.join(root, ".llmwiki", "journal"))).toBe(false);
      expect(existsSync(path.join(root, "wiki"))).toBe(false);
    }));

  it("still unlinks the FILE when no remover is supplied", () =>
    withStack("del-file", async (root) => {
      // The file backend must be untouched by this change.
      await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
      const target = path.join(root, "wiki/concepts/doomed.md");
      await writeFile(target, BODY);

      await deleteWikiPagesLocked(root, ["doomed"]);

      expect(existsSync(target)).toBe(false);
    }));

  it("still skips an unsafe slug without touching either backend", () =>
    withStack("del-floor", async (root, harness) => {
      const sink = createPageWriteSink(harness.db, harness.stackId);
      await sink({ directory: "concepts", slug: "kept", body: BODY });

      const { skipped } = await deleteWikiPagesLocked(root, ["../escape"], {
        pageRemover: createPageRemoveSink(harness.db, harness.stackId),
      });

      // The floor runs in both backends and never reaches the remover.
      expect(skipped).toEqual([{ slug: "../escape", reason: "floor:unsafe-slug" }]);
      expect(await getStoredPage(harness.db, harness.stackId, "concepts", "kept")).toBeDefined();
    }));
});

describe("withPageRemover resolves the remover from the environment", () => {
  it("hands a remover to the callback when a Stack is configured", async () => {
    const harness = await createKgPostgresHarness(`seam-${randomUUID().slice(0, 8)}`);
    try {
      const env = { LLMWIKI_DATABASE_URL: process.env.LLMWIKI_TEST_DATABASE_URL } as NodeJS.ProcessEnv;
      await withStackEnv(`seam-${randomUUID().slice(0, 8)}`, async () => {
        const sink = createPageWriteSink(harness.db, harness.stackId);
        await sink({ directory: "concepts", slug: "gone", body: BODY });

        const seen = await withPageRemover(process.env, async (remover) => {
          expect(remover).toBeDefined();
          await remover!({ directory: "concepts", slug: "gone" });
          return true;
        });

        expect(seen).toBe(true);
      });
      void env;
    } finally {
      await harness.cleanup();
    }
  });

  it("hands undefined for a project with no Stack", async () => {
    const seen = await withPageRemover({} as NodeJS.ProcessEnv, async (remover) => remover);
    expect(seen).toBeUndefined();
  });
});
