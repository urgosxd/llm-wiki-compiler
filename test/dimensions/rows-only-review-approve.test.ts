/**
 * @file test/dimensions/rows-only-review-approve.test.ts
 * @description `review approve` must write the ROW on a Stack, never the file.
 *
 * ## The defect
 *
 * `routeDefaultPageWrite` (`src/commands/review-approve.ts`) called
 * `applyApprovedMutationsLocked(root, planned)` with no options, so the executor
 * never saw a `pageSink` and took its file branch. On a Stack that writes
 * `wiki/concepts/<slug>.md` — a file nothing reads, because the corpus is
 * `wiki.pages`. It then RETURNED that path, so the CLI also reported a page at a
 * location that is not where the page lives.
 *
 * The seam was already in the file: it imports `withPageSeams` for the link-repair
 * tail, and simply did not route the write through it.
 *
 * ## Why the assertion is exactly this
 *
 * "The row exists" alone would pass if the file were ALSO written. Both halves
 * matter on a Stack: a page that exists in two places drifts, and the file is the
 * copy nothing maintains. So the row is asserted present AND the file absent.
 *
 * The no-Stack case is pinned by the existing suites, which must stay unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getStoredPage } from "../../src/dimensions/wiki/page-store.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { writeCandidate } from "../../src/compiler/candidates.js";

const SLUG = "row-only-concept";
const BODY = `---\ntitle: Row Only\n---\n\n# Row Only\n\nBody.\n`;

describe("review approve on a Stack writes the row and no file", () => {
  let root: string;
  let harness: KgPostgresHarness;
  let savedEnv: NodeJS.ProcessEnv;
  let originalCwd: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "rows-approve-"));
    harness = await createKgPostgresHarness(`approve-${randomUUID().slice(0, 8)}`);
    savedEnv = { ...process.env };
    originalCwd = process.cwd();
    process.chdir(root);
    process.env.AKS_STACK_ID = harness.stackId;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env = savedEnv;
    vi.restoreAllMocks();
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
    await harness.cleanup();
  });

  it("stores the approved page as a row", async () => {
    if (!harness.reachable) return;
    const candidate = await writeCandidate(root, {
      title: "Row Only", slug: SLUG, summary: "", sources: [], body: BODY,
    });

    const { default: reviewApproveCommand } = await import("../../src/commands/review-approve.js");
    await reviewApproveCommand(candidate.id);

    const row = await getStoredPage(harness.db, harness.stackId, "concepts", SLUG);
    expect(row).toBeDefined();
  });

  it("does NOT leave a page file behind", async () => {
    if (!harness.reachable) return;
    const candidate = await writeCandidate(root, {
      title: "Row Only", slug: SLUG, summary: "", sources: [], body: BODY,
    });

    const { default: reviewApproveCommand } = await import("../../src/commands/review-approve.js");
    await reviewApproveCommand(candidate.id);

    // PRECONDITION, asserted before the real claim: the approve must actually have
    // reached the write. Without this, a run that bailed out early would satisfy
    // "no file" for a reason that has nothing to do with the backend — which is
    // exactly how the first version of this test passed while the page was never
    // approved at all.
    expect(process.exitCode ?? 0).toBe(0);
    // The whole point: on a Stack the file is a second corpus nothing maintains.
    expect(existsSync(path.join(root, "wiki", "concepts", `${SLUG}.md`))).toBe(false);
  });
});
