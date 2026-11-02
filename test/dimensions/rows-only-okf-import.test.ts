/**
 * @file test/dimensions/rows-only-okf-import.test.ts
 * @description A trusted OKF import must land pages as rows on a Stack.
 *
 * ## The defect
 *
 * `writeAll` (`src/import/run.ts`) wrote every imported page with a bare
 * `atomicWrite(path.join(root, dir, slug.md), page.body)`. It does not go through
 * the executor at all, so it never had a chance to consult a `pageSink`: an import
 * into a Stack produced files and no rows.
 *
 * ## Why this one takes the SINK rather than refusing
 *
 * Unlike the typed and lifecycle paths, this writes DEFAULT pages — `concepts` and
 * `queries` — which `wiki.pages` stores natively. There is a row to write, so the
 * fix is to write it, not to refuse.
 *
 * The import must still leave no file behind: on a Stack a page file is a second
 * corpus nothing reads.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStoredPage } from "../../src/dimensions/wiki/page-store.js";
import { runOkfImport } from "../../src/import/run.js";
import { withRowsStack } from "../fixtures/rows-only-stack.js";

const SLUG = "imported-by-rows";

/** One concept page in the bundle. `type: concept` is what the mapper keys on. */
const BUNDLE = "---\ntype: concept\ntitle: Imported By Rows\n---\n\n# Imported\n\nBody.\n";

/**
 * Write an OKF bundle holding one concept page.
 *
 * The bundle uses bare namespaces (`concepts/`, not `wiki/concepts/`); the mapper
 * resolves the target wiki directory from each page's `type`.
 *
 * @param root - Project root the bundle is created under.
 * @returns The bundle directory.
 */
async function bundleDir(root: string): Promise<string> {
  const dir = path.join(root, "bundle");
  await mkdir(path.join(dir, "concepts"), { recursive: true });
  await writeFile(path.join(dir, "concepts", `${SLUG}.md`), BUNDLE);
  return dir;
}

describe("a trusted OKF import on a Stack", () => {
  it("stores the imported page as a row", async () => {
    await withRowsStack("okf", async ({ root, harness }) => {
      await importBundle(root);

      expect(await getStoredPage(harness.db, harness.stackId, "concepts", SLUG)).toBeDefined();
    });
  });

  it("does NOT leave a page file behind", async () => {
    await withRowsStack("okf-file", async ({ root }) => {
      await importBundle(root);

      expect(existsSync(path.join(root, "wiki", "concepts", `${SLUG}.md`))).toBe(false);
    });
  });
});

/**
 * Import the bundle into `root` and assert the importer accepted the page.
 *
 * The acceptance check is a PRECONDITION, not decoration: an import that silently
 * skipped every page would satisfy the "no file" assertion for a reason that has
 * nothing to do with the backend, which is how an earlier version of the review
 * test looked green while nothing had been written at all.
 *
 * @param root - Project root holding the bundle.
 */
async function importBundle(root: string): Promise<void> {
  const report = await runOkfImport(root, await bundleDir(root), { trusted: true });
  expect(report.pages.map((p) => p.slug)).toContain(SLUG);
}
