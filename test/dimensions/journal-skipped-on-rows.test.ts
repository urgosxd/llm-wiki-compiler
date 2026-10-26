/**
 * @file test/dimensions/journal-skipped-on-rows.test.ts
 * @description A fully row-backed apply must not touch the journal directory.
 *
 * ## What the journal is for, and when it is not needed
 *
 * `recordPreState` snapshots a target's PREVIOUS BYTES so a crash can restore them.
 * That exists because file writes are not atomic as a SET: if A lands and B fails, A
 * has to be undone by hand. A row write has no previous bytes to snapshot, and the
 * database already gives all-or-nothing for free through its transaction — so
 * `applyPageMutationLocked` deliberately SKIPS the journal when a `pageSink` is
 * present. That reasoning is written down in `executor.ts` and is correct.
 *
 * What it did not do is stop opening the batch. `applyApprovedMutationsLocked` still
 * called `openBatch` (creating `.llmwiki/journal/<id>.json`) and `commitBatch`
 * (deleting it) around a run in which NOTHING was journalled. So a project that reads
 * and writes every page as a row still created and removed a filesystem artifact on
 * every apply — the same shape of defect as the four earlier unconditional-effect
 * bugs: work that belongs to one backend performed before asking which one is active.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withStackEnv } from "../fixtures/stack-env.js";
import { applyApprovedMutationsLocked } from "../../src/trust/executor.js";
import { applyPageMutationLocked } from "../../src/trust/page-apply.js";
import type { PageSink } from "../../src/trust/page-apply.js";

/** Provision a project root plus a Stack, always tearing both down. */
async function withProject(label: string, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), `${label}-`));
  try {
    await withStackEnv(label, () => body(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A sink that records what it was asked to store and writes nothing. */
function recordingSink(): { sink: PageSink; stored: string[] } {
  const stored: string[] = [];
  const sink: PageSink = async (request) => {
    stored.push(request.body);
  };
  return { sink, stored };
}

/** One page-create mutation, in the shape the executor plans. */
function pageCreate(slug: string) {
  return {
    kind: "page",
    operation: "create",
    body: `# ${slug}\n`,
    target: { directory: "concepts", slug },
    provenance: { origin: "test", decision: "allow" as const, reviewRouted: false },
  };
}

describe("journal is not opened for a fully row-backed apply", () => {
  it("leaves no journal directory behind when every target is a row", () =>
    withProject("journal-rows", async (dir) => {
      const { sink, stored } = recordingSink();

      await applyApprovedMutationsLocked(dir, [pageCreate("alpha")], { pageSink: sink });

      // The page went to the sink...
      expect(stored).toEqual(["# alpha\n"]);
      // ...and no journal file or directory was created for it.
      expect(existsSync(path.join(dir, ".llmwiki", "journal"))).toBe(false);
    }));

  it("still journals when the file backend is active", () =>
    withProject("journal-files", async (dir) => {
      // No sink: the page is written as a file, so a pre-state is recorded and a
      // batch MUST exist. Guards against "skip the journal always" masquerading as
      // a fix.
      await applyApprovedMutationsLocked(dir, [pageCreate("gamma")]);

      expect(existsSync(path.join(dir, ".llmwiki", "journal"))).toBe(true);
    }));

  it("still journals a row-backed delete that falls back to the file remover", () =>
    withProject("journal-del", async (dir) => {
      // A sink with NO remover: the write goes to a row, but the delete unlinks a
      // file and therefore records a pre-state. The batch is required again.
      const deleteMutation = {
        ...pageCreate("delta"),
        operation: "delete" as const,
      };

      await applyApprovedMutationsLocked(dir, [deleteMutation], { pageSink: recordingSink().sink });

      expect(existsSync(path.join(dir, ".llmwiki", "journal"))).toBe(true);
    }));

  it("refuses a file-backed mutation that arrived without a batch", () =>
    withProject("journal-guard", async (dir) => {
      // Defense in depth. `applyApprovedMutationsLocked` opens a batch whenever any
      // file branch is reachable, so this cannot happen from there. Calling the
      // mutation entry point directly with no batch must fail LOUDLY rather than
      // write a file whose pre-state nobody recorded.
      await expect(
        applyPageMutationLocked(dir, pageCreate("epsilon"), undefined),
      ).rejects.toThrow(/requires an open journal batch/);
    }));

  it("creates no .llmwiki at all when the only writes are rows", () =>
    withProject("journal-nodir", async (dir) => {
      await applyApprovedMutationsLocked(dir, [pageCreate("beta")], { pageSink: recordingSink().sink });

      expect(existsSync(path.join(dir, ".llmwiki"))).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    }));
});
