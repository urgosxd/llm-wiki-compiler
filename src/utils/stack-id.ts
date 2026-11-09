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
 * ## The viewer / MCP-SDK boundary, stated as it actually is
 *
 * Three wiki surfaces import `stackIdProblem` from `../utils/stack-id.js` — the host
 * API, the viewer's ingest-jobs route and the MCP tenant-db helper — so this adapter
 * still has a job: it is the one path those three share.
 *
 * What this path does NOT do is preserve the viewer boundary by where it sits. The
 * rule is reached through the `llmwiki-kg` barrel (`core-index.ts`), and that
 * barrel's transitive closure is core, DB and config modules only: it exports
 * nothing from `mcp/**` and pulls in no `@modelcontextprotocol/sdk`, so reaching the
 * rule this way cannot hand the MCP SDK to the viewer. That is the invariant, and no
 * test in the suite enforces it today.
 *
 * Two consequences, stated rather than implied. This file is a VALUE edge into the
 * whole barrel, not a leaf: evaluating it evaluates `db.js`, `config.js` and the
 * pool-holding modules alongside the rule. And that adds no new weight, because the
 * viewer's own graph already reached this same barrel through other importers before
 * this file became an adapter — a measured build of the viewer bundle produced the
 * same module set with and without this edge, differing by a few hundred bytes.
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
export { stackIdProblem } from "@repo/kg";
