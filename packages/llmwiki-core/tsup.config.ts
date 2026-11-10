/**
 * Build all core entry points together so shared authority, locks, error classes
 * and the module-instance token resolve to one set of chunks in an installation.
 *
 * THE ENTRIES ARE THIS PACKAGE'S OWN SOURCES. They used to point into
 * `../../packages/wiki/src/`, which made whatever that package exported the
 * published surface by accident. `./src/index.ts` and `./src/compiler-sdk.ts`
 * are the facade now, they name every re-export, and they reach the wiki sources
 * by RELATIVE specifier so no undeclared bare specifier survives into `dist/`.
 * The entry values stay literal (`test/artifact/facade-surface.test.ts` parses
 * this text): no variables, no `path.resolve`.
 *
 * WHY THERE IS NO `rootDir` OVERRIDE. It used to pin
 * `path.resolve("../../packages/wiki/src")`, and once the entries moved out of
 * that tree the declaration build failed with `error TS6059: File
 * '.../packages/llmwiki-core/src/index.ts' is not under 'rootDir'
 * '.../packages/wiki/src'. 'rootDir' is expected to contain all source files.`
 * The entries and the wiki modules they re-export no longer share a root inside
 * the wiki package, so no override can be both narrow and true. Dropping it lets
 * TypeScript infer the common source directory, and tsup names each declaration
 * from its ENTRY KEY — which is why `dist/index.d.ts` and
 * `dist/compiler-sdk.d.ts` stay top-level beside the shared declaration chunk,
 * with no `dist/packages/` or `dist/src/` nesting: the paths `package.json`
 * `exports` names.
 */
import { defineConfig } from "tsup";
import path from "node:path";
import { execFileSync } from "node:child_process";

export default defineConfig({
  entry: {
    index: "./src/index.ts",
    "compiler-sdk": "./src/compiler-sdk.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "node24",
  // `express` arrives through `hostCommand`, which mounts the vendored graph app.
  // Express and its CJS transitive deps (`debug` -> `tty`) cannot be bundled into
  // an ESM output: esbuild turns their `require` calls into a dynamic-require shim
  // that throws at import time. External so Node resolves them at runtime.
  //
  // The MCP SDK arrives the same way once `hostCommand` mounts the streamable-HTTP
  // transport (`src/host/mcp-http.ts` -> `src/mcp/server.ts` -> the SDK). Bundling
  // it pulls its validation layer, and `ajv-formats` does `require("ajv")` — under
  // an ESM output that becomes a dynamic-require shim which throws
  // `Dynamic require of "ajv" is not supported` at import time. The bundle built
  // fine and the CLI died before parsing a single argument; measured with
  // `node dist/cli.js --version`. External so Node resolves the SDK at runtime,
  // which is how the shipped launcher already runs it: `dist/api.js` in its
  // `serve` mode, the stdio MCP server that `createWikiMcpServer` builds.
  //
  // `mammoth` arrives through the `.docx` ingest adapter (`src/ingest/docx.ts`).
  // It is CommonJS-only (`module.exports = ...`, no ESM entry), and its
  // `lib/docx/files.js` calls `require("url")`; bundled into an ESM output those
  // calls become the same dynamic-require shim, so the build succeeded and
  // `node dist/cli.js --version` exited 1 with
  // `Dynamic require of "url" is not supported` before parsing an argument.
  // External so Node resolves mammoth at runtime, exactly like `express` above.
  //
  // `@hono/node-server` is different: our own source never imports it, and it
  // appears in no `dist/*.js` chunk, so listing it changes nothing about the
  // bundle we ship today. It is externalized because the dependency is a runtime
  // one that is already live — the MCP SDK declares it as a hard dependency and
  // `server/streamableHttp.js` imports `getRequestListener` from it — so the
  // boundary is resolved from `node_modules` after the bundle loads. Naming it
  // here keeps that boundary explicit and keeps a future direct import (a Node
  // adapter mounted beside the streamable-HTTP transport) a bare specifier
  // instead of source silently inlined into the ESM output.
  external: [
    "express",
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/*",
    "@hono/node-server",
    "mammoth",
  ],
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: true,
  tsconfig: "../../tsconfig.json",
  onSuccess: async () => {
    execFileSync(process.execPath, [path.resolve("../../scripts/copy-viewer-assets.mjs"), "packages/llmwiki-core/dist"]);
  },
});
