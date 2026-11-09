/**
 * @file packages/llmwiki-kg/ts/src/stack-id.ts
 * @description This package's public surface for the Stack-id rule, which now lives
 * at the bottom layer: a re-export of `@repo/foundation`.
 *
 * ## Why this re-export names a SUBPATH and not the barrel
 *
 * `@repo/foundation` publishes TypeScript source and has no build, so a consumer
 * that reaches its BARREL from a `tsc`-compiled `dist` gets a barrel whose internal
 * `./stack-id.js` plain Node cannot remap to `.ts`, and the process dies with
 * ERR_MODULE_NOT_FOUND; a subpath export starts resolution at the module file and
 * sidesteps the barrel. That is not hypothetical: this is the first VALUE edge from
 * compiled KG code into foundation — every earlier edge in this package was
 * `import type`, erased before emit, which is why the barrel was enough until now —
 * and `test/kg-mcp-e2e` builds `dist/` with `tsc` and runs it under plain Node.
 *
 * ## Where the rule lives, and why this file still exists
 *
 * The rule itself — `STACK_ID_PATTERN`, `isStackId` and the caller-facing message
 * `stackIdProblem` returns — is implemented once, in
 * `packages/foundation/src/stack-id.ts`. Nothing about the accepted or refused
 * shapes is decided here, and no part of it is repeated here: a second copy is the
 * drift the rule exists to prevent.
 *
 * This file remains because it is this package's public surface. `core-index.ts`
 * re-exports these three names from it, `mcp/handlers.ts` imports `stackIdProblem`
 * from it, and `stack-id.test.ts` imports from `./stack-id.js` — so the barrel, the
 * MCP surface and the test all keep the specifier they already had, unchanged. That
 * is the point of a shim: the move is invisible to every consumer, and a test that
 * pins behaviour keeps pinning it without being edited to follow a file around.
 *
 * ## Why it used to live HERE, and why that reason no longer applies
 *
 * The rule lived in this package for a reachability reason, not a taste one. Root
 * `src/**` already reached this package in production (`src/utils/lock-postgres.ts`,
 * `src/dimensions/activation.ts`, `src/host/server.ts`), so a shared module placed
 * here was free for the compiler to import, while the reverse — a file here reaching
 * out to `../../../src/**` — was impossible: this package compiles with
 * `rootDir: "src"` and `noEmitOnError`, so such an import failed with TS6059 and
 * took the package's build with it.
 *
 * That constraint does not apply to `@repo/foundation`, and the direction is the
 * reason: the rule moved DOWN, not sideways. Foundation is the bottom layer, every
 * package may depend on it (spec S2), and it depends on none of them, so importing
 * it is an edge the topology permits from here — unlike the `kg → wiki` edge the
 * `rootDir` limit would have forced. The constraint was never lifted; the rule simply
 * no longer needs to satisfy it.
 */

// A pure re-export on purpose: any body here would be a second place for the rule to
// live, and a second place is exactly what this move removed.
export { isStackId, stackIdProblem, STACK_ID_PATTERN } from "@repo/foundation/stack-id";
