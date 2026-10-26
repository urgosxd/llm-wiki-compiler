/**
 * Core SDK construction and standard composition compatibility witnesses.
 * These source-level checks do not claim installed-package independence.
 */
import { afterEach, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createWikiCore } from "../../src/sdk/core.js";
import { createWiki } from "../../src/sdk/wiki.js";
import { withStackEnv } from "../fixtures/stack-env.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("bundles the core SDK without loading local workflow execution", async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    entryPoints: ["src/core-index.ts"], bundle: true, write: false,
    platform: "node", format: "esm", packages: "external", metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs).toContain("src/sdk/core.ts");
  expect(inputs.filter((input) => /^src\/(?:local-workflows|workflows)\//.test(input))).toEqual([]);
  expect(inputs).not.toContain("src/sdk/wiki.ts");
  expect(inputs).not.toContain("src/sdk/workflow-facade.ts");
});

/** Allocate only test-owned roots for cleanup. */
async function freshRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "wiki-core-composition-"));
  roots.push(root);
  return root;
}

it("constructs a knowledge facade without local workflow methods or writes", () =>
  // A Stack is REQUIRED now: every dimension is Postgres-backed, so an ingest without
  // one has no tenant to key a row by. This test predates that contract.
  withStackEnv("sdk-core-composition", async () => {
  const root = await freshRoot();
  const wiki = createWikiCore({ root });
  // The workflow/operations/product slices were removed with their subsystems; a
  // reintroduction here would ship a facade method with nothing behind it.
  for (const gone of ["startWorkflow", "approveGate", "operations", "product"]) {
    expect(wiki, `${gone} belongs to a removed subsystem`).not.toHaveProperty(gone);
  }
  expect(await readdir(root)).toEqual([]);
  await wiki.ingestText({ title: "Core input", text: "Retained knowledge without a local workflow." });
  expect(await readdir(path.join(root, "sources"))).toHaveLength(1);
  }));

it("reads root once and keeps all core methods in standard composition", async () => {
  const root = await freshRoot();
  let reads = 0;
  const wiki = createWiki({ get root() { reads++; return root; } });
  expect(reads).toBe(1);
  // The property worth keeping: `createWiki` composes EVERYTHING `createWikiCore`
  // provides. It used to be checked incidentally, on a facade that also added workflow
  // methods; the composition guarantee outlives those methods.
  for (const name of Object.keys(createWikiCore({ root }))) expect(wiki).toHaveProperty(name);
  expect(await readdir(root)).toEqual([]);
});
