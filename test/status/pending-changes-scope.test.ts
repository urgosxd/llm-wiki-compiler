/**
 * @file test/status/pending-changes-scope.test.ts
 * @description Pending changes must describe the STACK, not the checkout.
 *
 * ## The defect
 *
 * `wiki_status` adopted the row-backed seam for PAGES and not for SOURCES, so one
 * object carried two numbers from two different worlds. Measured on a Stack holding a
 * single document:
 *
 *   pages: 1, sources: 1, pendingChanges: 23
 *
 * Every one of those 23 was an unrelated file in the repository's own `sources/`
 * directory, which that Stack had never contained. A caller reading it is told the wiki
 * has 23 files awaiting compilation and sent to fix a backlog that does not exist.
 *
 * `detectChanges` already reads rows when a Stack is configured, so the compiler and
 * the status surface disagreed about what the corpus IS -- the same shape as the
 * page-source, embedding, and job-mirror defects, one table over.
 *
 * ## What must not regress
 *
 * A project with no Stack keeps reading `sources/`. That deployment is supported and
 * the directory is genuinely its corpus.
 */
import { describe, it, expect } from "vitest";
import { collectStatus } from "../../src/status/collect.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/** A listing that answers with exactly the given identities. */
function listingOf(...identities: string[]) {
  return { list: async () => identities.map((sourceIdentity) => ({ sourceIdentity })) };
}

describe("pendingChanges follow the configured corpus", () => {
  it("counts the Stack's documents, not the checkout's", async () => {
    const root = await scratchProjectRoot("pending-scope-");
    // The checkout has files the Stack knows nothing about.
    await mkdir(path.join(root, "sources"), { recursive: true });
    for (const name of ["repo-only-a.md", "repo-only-b.md", "repo-only-c.md"]) {
      await writeFile(path.join(root, "sources", name), "# from the checkout\n");
    }

    const status = await collectStatus(root, {
      sourceDocuments: listingOf("http://capability/only-in-stack.md"),
    });

    // The single Stack document is pending; the three checkout files are not the
    // Stack's business and must not appear.
    expect(status.pendingChangesCount).toBe(1);
    expect(status.pendingChanges.map((c) => c.file)).toEqual(["http://capability/only-in-stack.md"]);
  }, 30_000);

  it("still reads the directory when no Stack is configured", async () => {
    const root = await scratchProjectRoot("pending-disk-");
    await mkdir(path.join(root, "sources"), { recursive: true });
    await writeFile(path.join(root, "sources", "on-disk.md"), "# a real corpus\n");

    const status = await collectStatus(root);

    expect(status.pendingChangesCount).toBe(1);
    expect(status.pendingChanges[0]?.file).toBe("on-disk.md");
  }, 30_000);

  it("reports nothing pending when the Stack's document is already compiled", async () => {
    const root = await scratchProjectRoot("pending-clean-");
    const status = await collectStatus(root, { sourceDocuments: listingOf() });

    // An empty corpus has nothing outstanding. Without the seam this would have counted
    // whatever happened to be in the checkout.
    expect(status.pendingChangesCount).toBe(0);
  }, 30_000);
});
