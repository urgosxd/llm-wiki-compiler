/**
 * @file test/sdk/okf-import-env.test.ts
 * @description The SDK facade's `importOkf` writes the imported pages into the Stack
 * the CALLER captured, never into the process it happens to run in.
 *
 * ## The condition this pins
 *
 * `createWikiCoreAtRoot` resolves the request environment ONCE (`sdk/core.ts:86`) and
 * forwards it to every door that has a Stack seam. `importOkf` called
 * `runOkfImport(root, dir, opts)` without it, and the callee resolves
 * `opts.env ?? process.env` (`import/run.ts:131`) before writing through
 * `writeAll(root, valid, env)` → `withPageSeams(env, …)` (`import/run.ts:97`). So a
 * handle bound to Stack B WROTE its imported pages into Stack A whenever the process
 * itself served Stack A -- another tenant's corpus grown by this caller's import, with
 * the report reading `written` either way.
 *
 * ## Which half of an import is a Stack seam, verified rather than assumed
 *
 * Only the WRITE. `importOkfBundle` reads the bundle from `dir` (`readOkfBundle`) and
 * its collision policy asks the filesystem and the candidate store
 * (`import/okf-collision.ts`), so no read inside an import consults a Stack at all. The
 * seam is the page sink in `writeAll`, which is why the proof reads the tenant BACK
 * afterwards through one facade handle per Stack: the report describes the bundle and
 * is identical on both sides of the fix, so it cannot witness where the pages landed.
 *
 * ## Why the ambient binding and the empty tree are load-bearing
 *
 * The root is a real temporary directory with no `wiki/` tree (asserted below), so no
 * page below can come from a disk write, and the process serves Stack A while the
 * handle names Stack B, so a door that agrees with the ambient environment by accident
 * proves nothing. The two Stacks, the temp root and the ambient binding come from
 * `test/sdk/two-stack-env.ts`, and nothing here reaches a provider.
 */
import { afterAll, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";
import type { OkfImportReport } from "../../packages/wiki/src/import/run.js";
import type { ListPagesResult, Page } from "../../packages/wiki/src/pages/list.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import {
  bindProcessTo,
  createTwoStacks,
  handleOnBoundStack,
  requireReachable,
  type TwoStacks,
} from "./two-stack-env.js";

/** Body of the imported document: the text a write into the wrong tenant would carry. */
const BUNDLE_BODY = "Only the bundle holds imported-b.";

const two = await createTwoStacks("sdk-okf-import-env");

afterAll(async () => {
  await two.release();
});

/** Write a foreign OKF bundle holding ONE concept doc, under `<root>/kb-<slug>`. */
async function writeBundle(root: string, slug: string): Promise<string> {
  const bundle = path.join(root, `kb-${slug}`);
  await mkdir(path.join(bundle, "concepts"), { recursive: true });
  await writeFile(
    path.join(bundle, "concepts", `${slug}.md`),
    `---\ntype: concept\ntitle: Imported\n---\n\n${BUNDLE_BODY}\n`,
  );
  return bundle;
}

/** The qualified page ids `stack` holds, read through a facade handle bound to it. */
async function pageIdsOf(owner: TwoStacks, stack: ProbeStack): Promise<string[]> {
  const listing = (await createWiki({ root: owner.root, env: stack.env() }).listPages()) as ListPagesResult;
  return listing.pages.map(({ pageDirectory, slug }) => `${pageDirectory}/${slug}`).sort();
}

it("writes the imported pages into the Stack the handle names, never the ambient one", async () => {
  // The process serves Stack A; the handle names Stack B; the root has no `wiki/` tree.
  const wiki = await handleOnBoundStack(two);
  const bundle = await writeBundle(two.root, "imported-b");

  const report = (await wiki.importOkf(bundle, { trusted: true })) as OkfImportReport;
  expect(report.mode).toBe("written");
  expect(report.pages.map(({ slug }) => slug)).toEqual(["imported-b"]);

  // Positive: B holds its own seeded page AND the imported one, body included.
  // Negative: B's listing is those two, and A's is the page A alone had -- so neither
  // tenant's listing shows a page the other one holds.
  expect(await pageIdsOf(two, two.bound)).toEqual(["concepts/alpha-b", "concepts/imported-b"]);
  expect(await pageIdsOf(two, two.ambient)).toEqual(["concepts/alpha-a"]);
  const imported = (await createWiki({ root: two.root, env: two.bound.env() }).getPage({
    pageDirectory: "concepts",
    slug: "imported-b",
  })) as Page | null;
  expect(imported?.body).toContain(BUNDLE_BODY);
}, 60_000);

// PRESERVE: the documented DEFAULT this change must not move. A handle that names no
// environment addresses the AMBIENT Stack, so its import still lands there.
it("still writes into the ambient Stack when the handle names no environment", async () => {
  requireReachable(two);
  bindProcessTo(two.ambient);
  const bundle = await writeBundle(two.root, "imported-default");

  await createWiki({ root: two.root }).importOkf(bundle, { trusted: true });

  expect(await pageIdsOf(two, two.ambient)).toEqual(["concepts/alpha-a", "concepts/imported-default"]);
  expect(await pageIdsOf(two, two.bound)).not.toContain("concepts/imported-default");
}, 60_000);
