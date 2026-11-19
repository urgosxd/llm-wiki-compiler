/**
 * @file test/sdk/export-json-env.test.ts
 * @description The SDK facade's `exportJson` collects its pages from the environment the
 * CALLER captured, never from the process it happens to run in.
 *
 * ## The condition this pins
 *
 * `createWikiCoreAtRoot` resolves the request environment ONCE (`sdk/core.ts:86`) and
 * forwards it to every door that has a Stack seam. `exportJson` called
 * `exportJson(root, opts)` without it, and unlike the other three doors this callee had
 * no environment route at all: `commands/export.ts:270` hardcoded
 * `withRawPageSource(root, process.env, (source) => collectExportPages(root, source,
 * process.env))`. So a handle bound to Stack B exported Stack A's pages whenever the
 * process itself served Stack A: a well-formed JSON document describing another tenant,
 * with nothing inside it to say so.
 *
 * ## Why the case asserts both halves
 *
 * The exact page list is the negative half stated once for every field a leak could
 * reach -- no ambient page is in the document by path, slug or title -- and it is also
 * the positive half, because the one entry is the handle's OWN page, which a fix that
 * exports nothing cannot pass. The joined text repeats that for the slug and the body,
 * which is what a leaked page body would carry.
 *
 * ## Why the tree has no `wiki/` directory
 *
 * The root is a real temporary directory with no `wiki/` tree (asserted by the shared
 * opening), so no document below can come from scanning files: both pages exist only as
 * `wiki.pages` rows of the Stack that holds them. The two Stacks, the temp root and the
 * ambient binding come from `test/sdk/two-stack-env.ts`, and nothing here reaches a
 * provider.
 */
import { afterAll, expect, it } from "vitest";
import type { JsonExportDocument } from "../../packages/wiki/src/export/json-export.js";
import { createTwoStacks, handleOnAmbientStack, handleOnBoundStack } from "./two-stack-env.js";

const two = await createTwoStacks("sdk-export-json-env");

afterAll(async () => {
  await two.release();
});

it("exports the JSON pages of the Stack the handle names, never the ambient one", async () => {
  // The process serves Stack A; the handle names Stack B; the root has no `wiki/` tree.
  const wiki = await handleOnBoundStack(two);
  const doc = (await wiki.exportJson()) as JsonExportDocument;

  // Positive: the handle's own page, with its id and title. Negative: it is the WHOLE
  // page list, so no ambient page is in the document under any id or title.
  expect(doc.pages.map(({ pageDirectory, slug, title }) => ({ id: `${pageDirectory}/${slug}`, title })))
    .toEqual([{ id: "concepts/alpha-b", title: "Alpha B" }]);
  const text = JSON.stringify(doc);
  expect(text).toContain("Only this Stack holds alpha-b.");
  expect(text).not.toContain("alpha-a");
}, 60_000);

// PRESERVE: the documented DEFAULT this change must not move. A handle that names no
// environment addresses the AMBIENT Stack -- the contract `CreateWikiOptions.env`
// states -- so its document still holds the Stack the process serves.
it("still exports the ambient Stack when the handle names no environment", async () => {
  const doc = (await handleOnAmbientStack(two).exportJson()) as JsonExportDocument;

  expect(doc.pages.map(({ slug }) => slug)).toEqual(["alpha-a"]);
}, 60_000);
