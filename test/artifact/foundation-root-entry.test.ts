/**
 * @file test/artifact/foundation-root-entry.test.ts
 * @description Guards the `@repo/foundation` ROOT entry against the one failure no
 * in-process test can see: a specifier Node's own ESM resolver cannot resolve.
 *
 * ## The defect this file exists for
 *
 * `packages/foundation/package.json` publishes `"exports"."." = "./src/index.ts"` —
 * raw TypeScript, with no `dist/` behind it — and the root entry re-exported through
 * relative `./stack-id.js` specifiers. The `.js`→`.ts` remap that makes that shape
 * legal is a TypeScript and esbuild rule; **Node's resolver does not apply it**, so a
 * plain `import "@repo/foundation"` died with
 * `ERR_MODULE_NOT_FOUND: Cannot find module '.../foundation/src/stack-id.js'` while
 * `@repo/foundation/stack-id` and `@repo/foundation/stack-migration` loaded fine.
 *
 * It survived every gate because every existing consumer of the root entry resolves it
 * through the TypeScript resolver (typecheck) or through esbuild (the tsup bundles, which
 * inline `@repo/*`), and neither ever asks Node to resolve a specifier. The file
 * `packages/wiki/src/mcp/server.ts` takes `requireDimensionsPort` through that root
 * entry, so the broken route was the only route its consumer had.
 *
 * ## Why the assertion is a CHILD PROCESS
 *
 * This package has no build step, so "the built artifact" has no `dist/` to name. The
 * honest equivalent of a built consumer here is *the module as a plain Node process
 * loads it, with no TypeScript resolver in the path* — the same resolution a consumer
 * gets. Importing `src/index.ts` from inside Vitest cannot see the defect at all,
 * because Vitest's own loader applies the remap; that is precisely why the defect
 * survived. So every case below spawns `process.execPath` with `--input-type=module`
 * and imports the specifier by NAME, leaving the resolution entirely to Node.
 *
 * Using `process.execPath` rather than a pinned `node` also keeps the case honest about
 * the run: the child runs on the same interpreter as the gate that collected this file.
 *
 * ## What it does NOT prove
 *
 * That the exports WORK — only that the module resolves and that each binding is
 * present. Behaviour of `isStackId` and `requireDimensionsPort` is pinned by their own
 * suites; duplicating it here would fail twice for one cause.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Repository root, from this file's own location rather than the worker's cwd. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The package under test, repository-relative. */
const PACKAGE_DIR = "packages/foundation";

/** Its manifest, whose `exports` map is what a consumer resolves through. */
const MANIFEST = path.join(PACKAGE_DIR, "package.json");

/** The package name, as every consumer writes it. */
const ROOT_SPECIFIER = "@repo/foundation";

/** The key the root entry sits under in the `exports` map. */
const ROOT_EXPORT_KEY = ".";

/**
 * Every binding the root entry must publish, sorted the way `Object.keys().sort()`
 * reports them. This is a published surface, so it is pinned by name: a rename that
 * silently drops one is a breaking change to `@repo/foundation`'s only portable door.
 */
const EXPECTED_ROOT_EXPORTS = [
  "MissingDimensionsPortError",
  "MissingStackColumnError",
  "STACKS_ACTIVE_MIGRATION",
  "STACK_ID_PATTERN",
  "isStackId",
  "missingActiveColumnCause",
  "missingActiveColumnRefusal",
  "requireDimensionsPort",
  "stackIdProblem",
];

/** The little of the package manifest this file reads. */
interface PackageManifest {
  readonly exports?: Readonly<Record<string, string>>;
}

/**
 * Run one `node --input-type=module --eval` script at the repository root.
 *
 * `cwd` is the repository root because that is where a consumer's `node_modules` lives:
 * `--eval` resolves bare specifiers against the process's working directory.
 *
 * @param script - The module source to evaluate.
 * @returns The child's stdout, trimmed.
 * @throws When the child exits non-zero, carrying its stderr in the message so a
 * resolution failure names the missing module instead of a bare exit code.
 */
function runNode(script: string): Promise<string> {
  const args = ["--input-type=module", "--eval", script];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: REPO_ROOT }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n--- child stderr ---\n${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Import one specifier in a plain Node child process and report its export names.
 *
 * @param specifier - The bare specifier a consumer would write.
 * @returns Sorted export names of the loaded namespace.
 */
async function importInNode(specifier: string): Promise<string[]> {
  const script = [
    `const namespace = await import(${JSON.stringify(specifier)});`,
    "process.stdout.write(Object.keys(namespace).sort().join(',') + '\\n');",
  ].join("\n");
  const stdout = await runNode(script);
  return stdout.length === 0 ? [] : stdout.split(",");
}

/**
 * Every subpath the package publishes, as a specifier a consumer would write.
 *
 * Read from the manifest at test time rather than hard-coded, so a subpath added or
 * renamed is covered without editing this list; the precondition is asserted first so
 * an unreadable or emptied `exports` map fails here instead of passing vacuously.
 *
 * @returns One `@repo/foundation/<name>` specifier per published subpath.
 */
async function publishedSubpathSpecifiers(): Promise<string[]> {
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, MANIFEST), "utf8")) as PackageManifest;
  const subpaths = Object.keys(manifest.exports ?? {}).filter((key) => key !== ROOT_EXPORT_KEY);
  expect(subpaths.length, `\`${MANIFEST}\` must publish at least one subpath`).toBeGreaterThan(0);
  return subpaths.map((key) => `${ROOT_SPECIFIER}/${key.replace(/^\.\//, "")}`);
}

describe("the @repo/foundation root entry, as a plain Node consumer loads it", () => {
  it("resolves the root specifier and reports every pinned export", async () => {
    const exports = await importInNode(ROOT_SPECIFIER);

    expect(exports).toEqual(EXPECTED_ROOT_EXPORTS);
  });

  it("resolves every published subpath it still keeps alongside the root", async () => {
    for (const specifier of await publishedSubpathSpecifiers()) {
      const exports = await importInNode(specifier);

      expect(exports.length, `\`${specifier}\` must publish at least one binding`).toBeGreaterThan(0);
    }
  });
});
