/**
 * @file test/sdk/okf-export-env.test.ts
 * @description The SDK facade's `exportOkf` reads its pages from the environment the
 * CALLER captured, never from the process it happens to run in.
 *
 * ## The condition this pins
 *
 * `createWikiCoreAtRoot` resolves the request environment ONCE (`sdk/core.ts:86`) and
 * forwards it to every door that has a Stack seam. `exportOkf` called
 * `runOkfExport(root, opts)` without it, and the callee resolves `opts.env ?? process.env`
 * (`export/okf/run.ts:17`) before reading the pages through
 * `withRawPageSource(root, env, …)`. So a handle bound to Stack B exported Stack A's
 * pages whenever the process itself served Stack A: a perfectly valid OKF bundle that
 * described another tenant, with nothing inside it to say so.
 *
 * ## Why the case pins the WHOLE document set
 *
 * An OKF bundle of one page is exactly `index.md`, `log.md` and one document per page,
 * so the exact document set is the negative half stated once for every field a leak
 * could reach: no ambient page is in the bundle by path. The positive half is that the
 * handle's OWN page is in it, which a fix that exports nothing cannot pass. The joined
 * text then says the same for the slug, the title and the body, which is what an
 * `index.md` entry or a document body would carry.
 *
 * ## Why the tree has no `wiki/` directory
 *
 * The root is a real temporary directory with no `wiki/` tree (asserted below), so no
 * bundle below can come from scanning files: both pages exist only as `wiki.pages` rows
 * of the Stack that holds them. The two Stacks, the temp root and the ambient binding
 * come from `test/sdk/two-stack-env.ts`, and nothing here reaches a provider.
 */
import { afterAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";
import type { OkfExportReport } from "../../packages/wiki/src/export/okf/run.js";
import {
  bindProcessTo,
  createTwoStacks,
  expectNoWikiTree,
  handleOnBoundStack,
  requireReachable,
} from "./two-stack-env.js";

const two = await createTwoStacks("sdk-okf-export-env");

afterAll(async () => {
  await two.release();
});

/** Every document the export wrote, bundle-relative, sorted, with its text. */
async function exportedDocs(report: OkfExportReport): Promise<{ rel: string; text: string }[]> {
  const docs = await Promise.all(
    report.writtenPaths.map(async (abs) => ({
      rel: path.relative(report.outDir, abs).split(path.sep).join("/"),
      text: await readFile(abs, "utf8"),
    })),
  );
  return docs.sort((a, b) => a.rel.localeCompare(b.rel));
}

it("exports the pages of the Stack the handle names, never the ambient one", async () => {
  // The process serves Stack A; the handle names Stack B; the root has no `wiki/` tree.
  const wiki = await handleOnBoundStack(two);
  const docs = await exportedDocs(await wiki.exportOkf({ out: path.join(two.root, "bundle") }));

  // Positive: the handle's own page is one of the three documents. Negative: those
  // three names are the whole bundle, so no ambient page is in it.
  expect(docs.map(({ rel }) => rel)).toEqual(["concepts/alpha-b.md", "index.md", "log.md"]);
  const text = docs.map(({ text: body }) => body).join("\n");
  expect(text).toContain("Only this Stack holds alpha-b.");
  expect(text).not.toContain("alpha-a");
}, 60_000);

// PRESERVE: the documented DEFAULT this change must not move. A handle that names no
// environment addresses the AMBIENT Stack -- the contract `CreateWikiOptions.env`
// states -- so its bundle is still built from the Stack the process serves.
it("still exports the ambient Stack when the handle names no environment", async () => {
  requireReachable(two);
  bindProcessTo(two.ambient);

  const wiki = createWiki({ root: two.root });
  const docs = await exportedDocs(await wiki.exportOkf({ out: path.join(two.root, "bundle-default") }));

  expect(docs.map(({ rel }) => rel)).toEqual(["concepts/alpha-a.md", "index.md", "log.md"]);
}, 60_000);
