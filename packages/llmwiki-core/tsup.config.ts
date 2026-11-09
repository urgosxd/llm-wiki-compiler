/**
 * Build all core entry points together so shared authority, locks, error classes
 * and the module-instance token resolve to one set of chunks in an installation.
 */
import { defineConfig } from "tsup";
import path from "node:path";
import { execFileSync } from "node:child_process";

export default defineConfig({
  entry: {
    index: "../../packages/wiki/src/core-index.ts",
    "compiler-cli": "../../packages/wiki/src/compiler-cli.ts",
    "compiler-sdk": "../../packages/wiki/src/sdk/compiler-composition.ts",
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
  // which is how it already runs under `llmwiki serve`.
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
  dts: { compilerOptions: { rootDir: path.resolve("../../packages/wiki/src") } },
  tsconfig: "../../tsconfig.json",
  onSuccess: async () => {
    execFileSync(process.execPath, [path.resolve("../../scripts/copy-viewer-assets.mjs"), "packages/llmwiki-core/dist"]);
  },
});
