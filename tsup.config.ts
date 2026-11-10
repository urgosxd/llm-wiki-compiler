/**
 * Build the standard distribution as a facade over one core and engine package.
 * Dependency builds finish first; both the library and the launcher externalize
 * the same entries.
 */
import { defineConfig, type Options } from "tsup";
import { buildCompilerDependencies } from "./scripts/tsup-command.js";

// Fields shared by every bundle. Extracted into one base object so the entries
// can't drift on format/target/output settings.
const shared = {
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  splitting: false,
  sourcemap: true,
  external: ["@atomicstrata/llmwiki-core", "@atomicstrata/llmwiki-core/*"],
} satisfies Options;

export default defineConfig(async (options) => {
  await buildCompilerDependencies(process.cwd());
  let initialBuild = true;
  return [
  {
    ...shared,
    entry: ["packages/wiki/src/index.ts"],
    // Per-entry targeted clean: only this bundle's own outputs, never a sibling's.
    clean: ["dist/index.js", "dist/index.js.map", "dist/index.d.ts"],
    dts: true,
    // No banner — library bundle must not include a shebang line.
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
  ];
});
