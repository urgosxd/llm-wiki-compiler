/**
 * @file test/sdk/packaging.test.ts
 * @description Install-from-tarball packaging smoke test for the SDK library entry.
 *
 * Validates the full publish contract by running `npm pack`, installing the
 * resulting tarball into a throwaway ESM fixture project, and importing
 * `createWiki` from the installed package via a probe script.
 *
 * This catches mistakes that a local `dist/` import would miss:
 *   - Wrong/missing `exports` map entries
 *   - Files accidentally excluded from the `files` field
 *   - A shebang on the library bundle that would break `import`
 *   - Missing type declarations (`.d.ts`)
 *   - A consumer-facing package subpath that does not resolve from the
 *     installed tarballs (the facade's declarations import the core's
 *     `compiler-sdk` subpath, so that entry is a real contract)
 *
 * Network-dependent: `npm install <tarball>` resolves llmwiki's ~17 runtime
 * deps fresh from the registry, so this is a developer-invoked `test:pack`
 * smoke test excluded from the default/CI `npm test` run.
 * Run explicitly with: `npm run test:pack`
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PACK_DISTRIBUTION } from "./pack-distribution.js";

/** Pack already-built exact workspace dependencies alongside the standard facade. */
function packDistribution(repo: string, destination: string): string[] {
  return [...PACK_DISTRIBUTION].map(directory => {
    const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      { cwd: path.join(repo, directory), encoding: "utf8" });
    const [packed] = JSON.parse(output) as Array<{ filename: string }>;
    expect(packed!.filename).toMatch(/\.tgz$/);
    return path.join(destination, packed!.filename);
  });
}

/**
 * A mixed-package consumer must see ONE contract through both published packages.
 *
 * The facade's `Wiki` is the core's `WikiCore` with nothing added, so the two
 * declarations are mutually assignable, and the facade's `createWiki` accepts the
 * core's `CreateWikiOptions` -- a divergence in either package breaks this file.
 * `SlugSafe` proves the branded identifier types still survive the shipped
 * declarations as brands: a second copy of core's `.d.ts` (or a hand-written
 * duplicate) would either lose the brand or be indistinguishable from `string`.
 *
 * ## The dimensions port is proved from the INSTALLED declarations too (spec S9)
 *
 * Two claims, both read off the tarballs a consumer installs rather than off this
 * checkout's sources:
 *
 * 1. **The port type is publicly REACHABLE and SATISFIABLE.** A hand-written
 *    object literal is declared as `NonNullable<CreateWikiOptions["dimensionsPort"]>`
 *    and passed through the same `createWiki` call the probe already makes. A field
 *    whose type an embedder cannot name -- because its only spelling lives in a
 *    private workspace package -- is not a public option, so this is the claim that
 *    the addition is actually usable, not merely declared.
 * 2. **The option stays OPTIONAL** (spec S3): `createWiki({ root: "/tmp/x" })` also
 *    type-checks. Omitting the port is valid, and that is the non-breaking half.
 *
 * Both are type-level only. Nothing here opens a database or starts a dimension, so
 * the gate stays DB-free; the DB-backed ingest through the built entry belongs to
 * the artifact tier (`test/artifact/entries-ingest-port.test.ts`).
 */
async function verifyInstalledTypes(repo: string, fixture: string): Promise<void> {
  await writeFile(path.join(fixture, "types.ts"), `
    import { createWiki, type CreateWikiOptions as FacadeOptions, type Wiki } from "llm-wiki-compiler";
    import type { SlugSafe, WikiCore } from "@atomicstrata/llmwiki-core";
    import type { CreateWikiOptions } from "@atomicstrata/llmwiki-core/compiler-sdk";
    declare const wiki: Wiki;
    declare const options: CreateWikiOptions;
    declare const slug: SlugSafe;
    /** True only when each package's type is assignable to the other's. */
    type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    /** True when a branded type collapsed to plain string in the published .d.ts. */
    type ErasedToPlainString<T> = [T] extends [string] ? ([string] extends [T] ? true : false) : false;
    const sameContract: MutuallyAssignable<Wiki, WikiCore> = true;
    const core: WikiCore = wiki;
    const facade: Wiki = createWiki(options);
    const slugText: string = slug;
    const brandSurvives: ErasedToPlainString<SlugSafe> = false;

    /** The port type as the core's installed declarations state it. */
    type CorePort = NonNullable<CreateWikiOptions["dimensionsPort"]>;
    /** The same field as the ROOT facade's installed declarations state it. */
    type FacadePort = NonNullable<FacadeOptions["dimensionsPort"]>;

    /** A hand-written port: no private package is needed to satisfy the contract. */
    const port: CorePort = { resolve: () => [] };
    /** Both published entries name the SAME port type, so a consumer cannot drift. */
    const samePortType: MutuallyAssignable<CorePort, FacadePort> = true;
    /** Supplying it is accepted through the public option. */
    const supplied: Wiki = createWiki({ ...options, dimensionsPort: port });
    /** Omitting it stays valid (spec S3): the field is optional, never required. */
    const omitted: Wiki = createWiki({ root: "/tmp/x" });
    void [sameContract, core, facade, slugText, brandSurvives, samePortType, supplied, omitted];
  `);
  execFileSync(process.execPath, [path.join(repo, "node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "types.ts"],
  { cwd: fixture, stdio: "pipe" });
}

describe("packaging (slow; run via `npm run test:pack`)", () => {
  it("library entry imports from a packed tarball, no shebang, types emitted", async () => {
    const repo = process.cwd();
    execFileSync("npm", ["run", "build"], { stdio: "ignore", cwd: repo });
    expect((await readFile(path.join(repo, "dist/index.js"), "utf-8")).startsWith("#!")).toBe(false);
    await readFile(path.join(repo, "dist/index.d.ts"), "utf-8"); // throws if missing

    const out = await mkdtemp(path.join(tmpdir(), "wiki-pack-"));    // pack INTO temp
    const fixture = await mkdtemp(path.join(tmpdir(), "wiki-fix-"));
    try {
      const tarballs = packDistribution(repo, out);
      await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "f", type: "module" }));
      execFileSync("npm", ["install", "--ignore-scripts", ...tarballs], { cwd: fixture, stdio: "ignore" });
      await writeFile(path.join(fixture, "probe.mjs"), `import { createWiki } from "llm-wiki-compiler"; if (typeof createWiki !== "function") process.exit(2);`);
      execFileSync("node", ["probe.mjs"], { cwd: fixture, stdio: "ignore" });
      await verifyInstalledTypes(repo, fixture);
    } finally {
      await rm(out, { recursive: true, force: true });   // no .tgz left in the repo
      await rm(fixture, { recursive: true, force: true });
    }
  }, 180_000);
});
