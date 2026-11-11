/**
 * Build the standard distribution from this repository's own sources.
 *
 * The distribution used to be a facade over `@atomicstrata/llmwiki-core`, whose
 * separately-built engine chunk had to finish first, so this config built that
 * package before either entry. The collapse (`odd/tasks/collapse-core-package.md`)
 * deleted that package: the engine is inlined below, there is no dependency build
 * to wait for, and the root tarball is the whole distribution.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { defineConfig, type Options } from "tsup";

// Fields shared by every bundle. Extracted into one base object so the entries
// can't drift on format/target/output settings.
//
// Deliberately NO `external` here. The two entries externalize differently, and
// sharing one list would change a bundle in a way nothing asked for: see
// LIBRARY_EXTERNALS below.
const shared = {
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  splitting: false,
  sourcemap: true,
} satisfies Options;

/**
 * Dependencies the LIBRARY bundle externalizes, and why they are not on `shared`.
 *
 * Every one of them reaches the engine that this bundle now carries, and every one is
 * CommonJS — directly, or through a transitive `require`. With `splitting: false` and an
 * ESM output, esbuild turns those `require` calls into a dynamic-require shim that THROWS
 * at import time: measured on the deleted core's own build as
 * `Dynamic require of "ajv" is not supported`, `... of "tty" ...` (express, via
 * body-parser and debug) and `... of "url" ...` (mammoth). The bundle built fine and the
 * process died before parsing a single argument. External so Node resolves them at
 * runtime — which is why each is also a root `dependencies` entry.
 *
 * WHY NOT ON `shared`: the `api` entry BUNDLES express on purpose and survives it with the
 * module-scope `createRequire` banner below, which `packages/api/src/main.test.ts` proves.
 * Adding this list to `shared` would externalize express out of that bundle too, silently
 * changing a launcher nothing in this change asked to change. The library entry carries no
 * banner (a library bundle must have no shebang and no `require`), so it is the only entry
 * that needs this list.
 */
const LIBRARY_EXTERNALS = [
  "@hono/node-server",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
  "express",
  "mammoth",
];

/**
 * The `./compiler-sdk` subpath, emitted as a ZERO-STATE re-export shim.
 *
 * WHY A HAND-WRITTEN SHIM AND NOT A THIRD ENTRY. `splitting: false` means every entry
 * inlines its own copies of the modules it imports. A `compiler-sdk` entry built from
 * `packages/wiki/src/sdk/compiler-composition.ts` would therefore inline a SECOND
 * `AsyncLocalStorage` from `packages/wiki/src/utils/output.ts`, and quiet output entered
 * through this subpath would be invisible to the engine in `dist/index.js` — silently,
 * with no stream ever showing it. One statement that re-exports the engine's own bindings
 * out of `./index.js` carries no module state at all: the quiet scope is constructed once,
 * by `dist/index.js`, and `withQuiet` here IS that instance.
 *
 * `test/artifact/bundle-engine.test.ts` holds both halves: this file publishes exactly
 * `createWikiCoreAtRoot` and `withQuiet`, and constructs no quiet scope of its own.
 *
 * WHY THE DECLARATIONS COME FROM THE dts PIPELINE AND NOT FROM HERE. tsup's own dts step
 * deletes every emitted declaration already sitting in `outDir` before it writes its own
 * (`cleanDtsFiles` removes the `.d.ts`, `.d.mts` and `.d.cts` files), so a `.d.ts` written
 * by an `onSuccess` hook is removed again by the declaration build that follows it —
 * measured: the hand-written file vanished while the `.js` beside it survived.
 * The subpath therefore names `packages/wiki/src/index.ts` as a SECOND dts entry key, which
 * is the same declarations the bundle re-exports; a `.d.ts` carries no runtime state, so
 * publishing it twice cannot split the quiet scope.
 */
const COMPILER_SDK_BUNDLE = "dist/compiler-sdk.js";
const COMPILER_SDK_BUNDLE_TEXT = 'export { createWikiCoreAtRoot, withQuiet } from "./index.js";\n';

/** The library source both declaration keys are generated from. */
const LIBRARY_SOURCE = "packages/wiki/src/index.ts";

/**
 * Write the `./compiler-sdk` bundle the root manifest's `exports` names.
 *
 * Runs as the library entry's `onSuccess`, after `dist/index.js` exists, so the two files
 * always ship together. Only the `.js` is written here: see the note above on why a `.d.ts`
 * from this hook does not survive.
 */
async function emitCompilerSdkShim(): Promise<void> {
  await mkdir("dist", { recursive: true });
  await writeFile(COMPILER_SDK_BUNDLE, COMPILER_SDK_BUNDLE_TEXT);
}

export default defineConfig(() => [
  {
    ...shared,
    entry: [LIBRARY_SOURCE],
    // Per-entry targeted clean: only this bundle's own outputs, never a sibling's.
    clean: ["dist/index.js", "dist/index.js.map", "dist/index.d.ts"],
    // See LIBRARY_EXTERNALS: this bundle has no banner, so a CommonJS dependency would
    // die at import time rather than resolve.
    external: [...LIBRARY_EXTERNALS],
    // Two declaration keys, ONE dts build: `dist/index.d.ts` for the entry, and
    // `dist/compiler-sdk.d.ts` for the subpath that re-exports it. One build matters —
    // each dts build removes the other's `*.d.ts` at its start.
    dts: { entry: { index: LIBRARY_SOURCE, "compiler-sdk": LIBRARY_SOURCE } },
    // No banner — library bundle must not include a shebang line.
    // The `./compiler-sdk` bundle shim is written here, next to the bundle it re-exports.
    onSuccess: emitCompilerSdkShim,
  },
  {
    ...shared,
    // The container launcher, emitted as `dist/api.js` so the final image stage
    // keeps copying a single root `dist/`. `docker/entry.sh` execs this bundle in
    // both modes; `packages/api/package.json` publishes no path to it.
    entry: { api: "packages/api/src/main.ts" },
    // Per-entry targeted clean, for the reason the library entry documents: the array
    // entries build in parallel, so a blanket `clean: true` would delete a
    // sibling's output mid-write and turn every watch rebuild into a race.
    clean: ["dist/api.js", "dist/api.js.map"],
    // Every `@repo/*` workspace package is BUNDLED, not externalized. They publish
    // raw TypeScript paths, so an externalized specifier would ship a bundle that
    // imports files the consumer does not have — the failure mode
    // `test/artifact/dist-specifiers.test.ts` asserts at zero — and the runtime
    // image carries no `packages/api` or `packages/wiki` tree to resolve them from.
    noExternal: [/^@repo\//],
    // The shebang, plus a module-scope `require`. Bundled dependencies are CommonJS
    // (express, via body-parser and debug), so esbuild rewrites their `require("tty")`
    // into a `__require` shim that THROWS in ESM output unless a `require`
    // identifier exists in module scope. Measured: without the last two lines this
    // bundle dies at its first import with `Dynamic require of "tty" is not
    // supported`, and `packages/api/src/main.test.ts` is what caught it.
    banner: {
      js: [
        "#!/usr/bin/env node",
        'import { createRequire as __createRequire } from "node:module";',
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
    // Mirror the viewer's static assets (shell template, stylesheet, client
    // script) into dist/viewer/assets/ so they ship with the published npm
    // package AND with the container image. The viewer server reads the template
    // at runtime and serves /assets/* from this directory.
    //
    // It hangs off THIS entry because `host` is the only mode that serves the
    // viewer, and this is the only bundle that carries it. It used to hang off the
    // CLI entry; when that entry was deleted the copy silently stopped and
    // `dist/viewer/assets` came back EMPTY while the build still reported success.
    onSuccess: "node scripts/copy-viewer-assets.mjs",
  },
]);
