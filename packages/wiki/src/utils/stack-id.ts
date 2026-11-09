/**
 * @file src/utils/stack-id.ts
 * @description The wiki-side path onto the shared Stack-id rule, which lives at the
 * bottom layer: a re-export of `@repo/foundation`.
 *
 * ## Where the rule lives now
 *
 * The rule itself — the canonical 8-4-4-4-12 UUID form and the caller-facing
 * explanation — lives in `packages/foundation/src/stack-id.ts`, and this file
 * re-exports it. There is exactly one implementation, so the two dimensions cannot
 * validate differently; `packages/llmwiki-kg/ts/src/stack-id.test.ts` pins the
 * boundary. The message text is unchanged character for character: every wiki
 * surface hands it straight to a client.
 *
 * ## Why foundation and not the KG package
 *
 * This adapter used to re-export the rule from `@repo/kg`, which made the wiki side
 * name a KG module to validate a string. That is a `wiki → kg` edge the topology
 * forbids (spec S3), and the boundary gate counted it. The rule is pure — it needs
 * no database, no config and no package — so the bottom layer is the only home both
 * dimensions can import without importing each other (spec S2), and the reach that
 * used to be a violation is now the permitted one.
 *
 * What this path does NOT do is preserve the viewer boundary by where it sits. The
 * old adapter reached the rule through the `llmwiki-kg` barrel, whose transitive
 * closure is core, DB and config modules only; importing `@repo/foundation` reaches
 * a module that imports nothing at all, which is strictly narrower. That claim is
 * still enforced by no test in the suite, and it matters less every step of the
 * split: the bottom layer has no dependencies to leak.
 *
 * ## Who still uses it
 *
 * The three wiki surfaces that used to share this path — the host API, the viewer's
 * ingest-jobs route and the MCP tenant-db helper — now import `stackIdProblem` from
 * `@repo/foundation` directly, because an adapter with no job is a place for a
 * second copy to appear. `test/mcp/stack-id-guard.test.ts` still imports this
 * specifier, and a test that pins the caller's exact message is not edited to follow
 * a file around, so the file remains its path.
 *
 * ## Why validate at all
 *
 * Leaving an invalid string to Postgres makes the `uuid` cast raise, and that error
 * reaches the caller as an internal failure when the honest answer is "that is not
 * a Stack id". Checking first turns a 500 into a 400 with a message a client can act
 * on.
 */

// A pure re-export on purpose: any body here would be a second place for the rule to
// live, and a second place is exactly what this refactor removed.
export { stackIdProblem } from "@repo/foundation";
