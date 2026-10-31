/**
 * Build all core entry points together so shared authority, locks, error classes
 * and the module-instance token resolve to one set of chunks in an installation.
 */
import { defineConfig } from "tsup";
import path from "node:path";
import { execFileSync } from "node:child_process";

export default defineConfig({
  entry: {
    index: "../../src/core-index.ts",
    "compiler-cli": "../../src/compiler-cli.ts",
    "compiler-sdk": "../../src/sdk/compiler-composition.ts",
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
  external: ["express", "@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "@hono/node-server"],
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: { compilerOptions: { rootDir: path.resolve("../../src") } },
  tsconfig: "../../tsconfig.json",
  onSuccess: async () => {
    execFileSync(process.execPath, [path.resolve("../../scripts/copy-viewer-assets.mjs"), "packages/llmwiki-core/dist"]);
  },
});
