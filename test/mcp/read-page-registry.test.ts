/**
 * @file test/mcp/read-page-registry.test.ts
 * @description `read_page` must read the registry, not the filesystem.
 *
 * ## The condition the old tests did not contain
 *
 * `read_page` had passing tests: they wrote a page to disk and read it back, so the
 * source and the fixture agreed and the seam was never exercised. The defect only
 * shows up in the deployment this suite builds on purpose — a Stack whose pages exist
 * in the database and **nowhere on disk**.
 *
 * That is the same class recorded elsewhere as "the fixture did not contain the
 * condition", so the fixture here is the opposite of the old one: the project root has
 * no `wiki/` directory at all, and the page is inserted as a row.
 *
 * ## What must hold on that deployment
 *
 *   1. A slug that exists only in the database is readable, with its body.
 *   2. A slug that exists nowhere still fails — the fix must not turn a 404 into an
 *      empty page.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { readPageBySlugForTest } from "../../src/mcp/tools.js";
import { provisionStack, type ProvisionedStack } from "../fixtures/stack-harness.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";

/** A page body with frontmatter, as the compiler would render it. */
const DB_ONLY_BODY = "---\ntitle: Db Only\nsummary: stored as a row\n---\n\nDB_ONLY_BODY content.";

describe("read_page against a database-only wiki", () => {
  let stack: ProvisionedStack;
  let root: string;

  beforeEach(async () => {
    stack = await provisionStack("read-page-registry");
    // Deliberately NO wiki/ directory: the root has no on-disk pages at all.
    root = await scratchProjectRoot("read-page-db-");
  });

  afterEach(async () => {
    await stack.release();
    await rm(root, { recursive: true, force: true });
  });

  it("reads a page that exists only as a row, with its body", async () => {
    if (!stack.harness.reachable) return;
    await createPageWriteSink(stack.harness.db, stack.harness.stackId)({
      directory: "concepts",
      slug: "db-only",
      body: DB_ONLY_BODY,
    });

    const page = await readPageBySlugForTest(root, "db-only", stack.harness.stackId);

    expect(page).not.toBeNull();
    expect(page?.slug).toBe("db-only");
    // The body is the point: a fix that resolved the slug but returned no content
    // would satisfy a naive assertion and still leave the tool useless.
    expect(page?.body).toContain("DB_ONLY_BODY");
  }, 60_000);

  it("still fails for a slug that exists nowhere", async () => {
    if (!stack.harness.reachable) return;
    const page = await readPageBySlugForTest(root, "never-written", stack.harness.stackId);
    expect(page).toBeNull();
  }, 60_000);
});
