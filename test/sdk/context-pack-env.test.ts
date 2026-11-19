/**
 * @file test/sdk/context-pack-env.test.ts
 * @description The SDK facade's `getContextPack` assembles the pack from the environment
 * the CALLER captured, never from the process it happens to run in.
 *
 * ## The condition this pins
 *
 * `createWikiCoreAtRoot` resolves the request environment ONCE (`sdk/core.ts:86`) and
 * forwards it to every door that has a Stack seam. `getContextPack` built its options
 * object without it, and `buildContextPack` resolves two of the pack's inputs from an
 * ENVIRONMENT: the viewer snapshot's page corpus (`context/build.ts:129`) and the
 * project state (`context/build.ts:146`), both falling back to `process.env` when the
 * option is omitted.
 *
 * So a handle bound to Stack B assembled a pack out of Stack A's rows whenever the
 * process itself served Stack A: the ranking, the page ids, the titles, the summaries
 * and the chunk text all belonged to another tenant. Nothing announced it — the pack is
 * well formed, it simply describes the wrong Stack.
 *
 * ## Why the case asserts both halves
 *
 * The positive half (the pack ranks the page the handle's OWN Stack holds) is what a
 * fix that returns an empty pack cannot pass. The negative half (no id, title, summary
 * or chunk text of the ambient tenant appears anywhere in the pack) is what the
 * unfixed door cannot pass. Together they pin "from the Stack the handle names", not
 * merely "from some Stack".
 *
 * ## Why the tree has no `wiki/` directory
 *
 * The root is a real temporary directory with no `wiki/` tree (asserted below), so no
 * case can pass by scanning files: every page these assertions rank exists only as a
 * `wiki.pages` row of the Stack the handle named. The two Stacks and the ambient
 * binding come from `test/sdk/two-stack-env.ts`, and nothing here reaches a provider.
 */
import { afterAll, expect, it } from "vitest";
import { seedConceptPage } from "../fixtures/mcp-stack-rows.js";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";
import type { ContextPack } from "../../packages/wiki/src/context/types.js";
import {
  bindProcessTo,
  createTwoStacks,
  expectNoWikiTree,
  requireReachable,
} from "./two-stack-env.js";

const two = await createTwoStacks("sdk-context-pack-env");

afterAll(async () => {
  await two.release();
});

it("assembles the pack from the Stack the handle names, never the ambient one", async () => {
  requireReachable(two);
  // No `wiki/` tree at all: nothing ranked below can come from a disk scan.
  await expectNoWikiTree(two.root);
  // The process serves Stack A; the handle names Stack B.
  bindProcessTo(two.ambient);

  const wiki = createWiki({ root: two.root, env: two.bound.env() });
  const pack = (await wiki.getContextPack({ prompt: "alpha" })) as ContextPack;

  // The positive half is `alpha-b` present with its own id, title, summary and chunk
  // text; the negative half is the single-entry array, which states that no ambient
  // page is present at all -- not by id, slug, title, summary or chunk text.
  expect(pack.project.pages).toBe(1);
  expect(
    pack.primary.map(({ id, title, summary, chunks }) => ({
      id,
      title,
      summary,
      text: chunks.map((chunk) => chunk.text),
    })),
  ).toEqual([
    { id: "concepts/alpha-b", title: "Alpha B", summary: "Alpha B", text: [] },
  ]);
}, 60_000);

// PRESERVE: the documented DEFAULT this change must not move. A handle that names no
// environment addresses the AMBIENT Stack -- the contract `CreateWikiOptions.env`
// states -- so its pack still describes the Stack the process serves.
it("still assembles from the ambient Stack when the handle names no environment", async () => {
  await seedConceptPage(two.ambient.harness, "default-a", "---\ntitle: Default A\nsummary: the ambient default\n---\n\nAmbient default page.\n");
  bindProcessTo(two.ambient);

  const wiki = createWiki({ root: two.root });
  const pack = (await wiki.getContextPack({ prompt: "default" })) as ContextPack;

  expect(pack.primary.map(({ id }) => id)).toEqual(["concepts/default-a"]);
}, 60_000);
