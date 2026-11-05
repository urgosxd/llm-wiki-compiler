/**
 * @file src/utils/stack-id.ts
 * @description The wiki dimension's adapter onto the shared Stack-id rule.
 *
 * ## Where the rule lives now
 *
 * The rule itself — the canonical 8-4-4-4-12 UUID form and the caller-facing
 * explanation — lives in `packages/llmwiki-kg/ts/src/stack-id.ts`, and this file
 * re-exports it. There is exactly one implementation, so the two dimensions cannot
 * validate differently; `stack-id.test.ts` in that package pins the boundary.
 *
 * It lives in the KG package for a reachability reason, not a taste one. Root
 * `src/**` already imports `llmwiki-kg` in production (`src/utils/lock-postgres.ts`,
 * `src/dimensions/activation.ts`, `src/host/server.ts`), so a shared module there is
 * free to consume. The reverse is not available: that package compiles with
 * `rootDir: "src"` and `noEmitOnError`, so a file in it reaching into root `src/`
 * would fail TS6059 and break its build.
 *
 * ## Why this file still exists
 *
 * Three wiki surfaces import `stackIdProblem` from `../utils/stack-id.js` — the host
 * API, the viewer's ingest-jobs route and the MCP tenant-db helper — and the viewer
 * must stay free of the MCP SDK. Keeping the adapter at this path preserves that
 * boundary while the rule moves to the package that both dimensions can reach.
 *
 * ## Why validate at all
 *
 * Leaving an invalid string to Postgres makes the `uuid` cast raise, and that error
 * reaches the caller as an internal failure when the honest answer is "that is not
 * a Stack id". Checking first turns a 500 into a 400 with a message a client can act
 * on. The message is deliberately unchanged by this refactor: callers surface it
 * verbatim.
 */

// A pure re-export on purpose: any body here would be a second place for the rule
// to live, and a second place is exactly what this refactor removed.
export { stackIdProblem } from "llmwiki-kg";
