/**
 * @file test/dimensions/rows-only-review-approve.test.ts
 * @description `review approve` must write the ROW on a Stack, never the file.
 *
 * ## The two defects this pins, in the order they were found
 *
 * **D2 — the approval was refused before it wrote anything.** `approveUnderLock`
 * calls `candidateNamespacesPermitApproval`, which calls
 * `assertCandidateMutationAccess` → `assertCandidateNamespacesHealthy` →
 * `captureDirectory(root, ".llmwiki/candidates")`. On a Stack `writeCandidate`
 * takes its ROW branch, so that directory is never created, and the
 * filesystem-only custody check read the absence as a failure: exit 1, "candidate
 * store unavailable", no page anywhere.
 *
 * **D1 — once it did write, it wrote the wrong place.** `routeDefaultPageWrite`
 * called `applyApprovedMutationsLocked(root, planned)` with no options, so the
 * executor took its file branch and wrote `wiki/concepts/<slug>.md` — a file
 * nothing reads, because the corpus is `wiki.pages`.
 *
 * ## Why each assertion is exactly this
 *
 * "The row exists" alone would pass if the file were ALSO written, and a page that
 * exists in two places drifts. "No file" alone passes for the wrong reason when the
 * command bailed out early — which is how the first version of this test looked
 * green while the page was never approved at all. So the exit code is asserted
 * BEFORE the file check, and both halves are asserted together.
 *
 * The no-Stack case is pinned by the existing review suites, which must stay
 * unchanged; `review-approve-typed.test.ts` in particular asserts absolute file
 * paths in its success output.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getStoredPage } from "../../packages/wiki/src/dimensions/wiki/page-store.js";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { writeCandidate } from "../../packages/wiki/src/compiler/candidates.js";
import { useCommandProject } from "../fixtures/command-project.js";

const SLUG = "row-only-concept";
const BODY = "---\ntitle: Row Only\n---\n\n# Row Only\n\nBody.\n";

const project = useCommandProject("rows-approve-");

describe("review approve on a Stack writes the row and no file", () => {
  it("stores the approved page as a row", async () => {
    await withApprovedCandidate(async (stackId, harness) => {
      expect(await getStoredPage(harness.db, stackId, "concepts", SLUG)).toBeDefined();
    });
  });

  it("does NOT leave a page file behind", async () => {
    await withApprovedCandidate(async () => {
      // PRECONDITION, asserted before the real claim: the approve must actually have
      // reached the write. A run that bailed out early satisfies "no file" for a
      // reason that has nothing to do with the backend.
      expect(process.exitCode ?? 0).toBe(0);
      // The whole point: on a Stack the file is a second corpus nothing maintains.
      expect(existsSync(path.join(project.root, "wiki", "concepts", `${SLUG}.md`))).toBe(false);
    });
  });
});

/**
 * Provision a Stack, stage one default candidate, approve it through the real CLI
 * command, and hand the outcome to `assert`.
 *
 * The command is imported dynamically so this module's imports are evaluated before
 * the command graph binds to the environment the Stack sets up.
 *
 * @param assert - Assertions to run after the approval.
 */
async function withApprovedCandidate(
  assert: (stackId: string, harness: Awaited<ReturnType<typeof createKgPostgresHarness>>) => Promise<void>,
): Promise<void> {
  const harness = await createKgPostgresHarness(`approve-${randomUUID().slice(0, 8)}`);
  try {
    if (!harness.reachable) return;
    await withStackEnvFor(harness, async () => {
      const candidate = await writeCandidate(project.root, process.env, {
        title: "Row Only", slug: SLUG, summary: "", sources: [], body: BODY,
      });
      const { default: reviewApproveCommand } = await import("../../packages/wiki/src/commands/review-approve.js");
      await reviewApproveCommand(candidate.id);
      await assert(harness.stackId, harness);
    });
  } finally {
    await harness.cleanup();
  }
}

/**
 * Run `body` with this harness's Stack installed in the environment.
 *
 * `useStackEnv` provisions its OWN Stack from a label, which is not what this suite
 * needs: the assertions query the harness it already opened. Same install/restore
 * contract, bound to an existing handle.
 *
 * @param harness - The Stack to bind.
 * @param body - Work to run under that binding.
 */
async function withStackEnvFor(
  harness: Awaited<ReturnType<typeof createKgPostgresHarness>>,
  body: () => Promise<void>,
): Promise<void> {
  const saved = { ...process.env };
  process.env.AKS_STACK_ID = harness.stackId;
  try {
    await body();
  } finally {
    process.env = saved;
  }
}
