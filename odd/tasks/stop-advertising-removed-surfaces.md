# stop-advertising-removed-surfaces

Feature: stop advertising surfaces that no longer exist. Two facts drive it: no package.json in this repo declares `bin`, and the only launcher is `dist/api.js` (built from `packages/api/src/main.ts`, exec'd by `docker/entry.sh`) — a server entry with no subcommands. MCP tools and the SDK are the only callable surfaces.

## Specs

S1. Every recommended action emitted into `get_context_pack`'s `suggestedActions` must name a callable target: an MCP tool name that is actually registered, together with the input fields that tool requires. No recommendation may name a binary, a CLI subcommand, or a command line. Measured facts: `packages/wiki/src/project/recommendations.ts:35-39` types `ExecutableSpec.binary` as the literal `"llmwiki"`; the 8 action constants live at `recommendations.ts:109-169`; 3 more are built in `packages/wiki/src/context/build.ts:529-549`; the dedupe key that reads them is `context/build.ts:582-586`. All 11 carry `executable.binary: "llmwiki"`, which resolves to nothing.

S2. A recommendation that has no callable target is deleted, not reworded. Specifically `llmwiki review list` and `llmwiki review approve <id>` (`recommendations.ts:127-141`) go, because review does not come back, and `llmwiki view --open` goes, because no registered MCP tool serves the viewer — it is served by the host process (`packages/api/src/main.ts:200-202`), which is a command line and therefore not an allowed target.

S3. `packages/wiki/src/mcp/server.ts` `instructions` (lines 64-76) must name only tools that are registered. The four names `list_workflow_actions`, `describe_workflow_action`, `run_workflow_action` and `verify_artifact` are not registered anywhere in the repository and must not appear.

S4. No user-visible runtime string may instruct a user or agent to run `llmwiki <subcommand>`. Known sites: `packages/wiki/src/mcp/okf-tools.ts:72`; `packages/wiki/src/import/run.ts:163`; `packages/wiki/src/compiler/compile-report.ts:256`; `packages/wiki/src/context/pack-warnings.ts:59`; `packages/wiki/src/commands/query.ts:398`; `packages/wiki/src/viewer/assets/viewer-reviews.js:45` and its empty-state copy near `:106-107`. Where a string cannot be made true without re-adding a capability, the advert is deleted rather than softened.

S5. The advertised set and the recommended set must both be subsets of the registered set, asserted by a test that reads the real server: `createWikiMcpServer` (`packages/wiki/src/mcp/server.ts:61`) connected to `InMemoryTransport.createLinkedPair()` with a `Client`, then `client.listTools()` and `client.getInstructions()`. The fixture `buildServer` in `test/fixtures/mcp-test-env.ts:135` passes no `instructions`, so the guard must build on the production factory. Recommendation content must additionally be asserted through the `get_context_pack` handler, never only by calling `buildContextPack` directly — that bypass is why this survived (today `test/mcp-context.test.ts:163,166` asserts key shape and byte-equality with the builder, and every content pin calls the builder directly).

S6. Test-first: each behavior change observes RED before the fix and returns GREEN with focused output.

## Tasks

- T1 | S3, S5 | worker | guard test for the instructions half, then `mcp/server.ts` + new `packages/wiki/src/mcp/tool-names.ts` | d26a8f1fc4ff1f3d1eb20ef0c1a87304bf4e42a6
- T2 | S1, S2, S5 | worker | `recommendations.ts` + `context/build.ts` + the tests pinning the old shape | d26a8f1fc4ff1f3d1eb20ef0c1a87304bf4e42a6
- T3 | S4 | worker | the six runtime-string sites + the viewer asset + the viewer test | a70aadb07202236b6799c296168eda3305647a79
- T4 | S1-S5 | verify | independent verification, verdict per S# | a70aadb07202236b6799c296168eda3305647a79
- T5 | all | worker (lead cannot run shell) | gates, then work-unit commits with full SHAs recorded back into this document | a70aadb07202236b6799c296168eda3305647a79

## Non-goals

These recorded gaps are NOT part of this feature. Each is real and each is somebody else's slice:

- `writeStateFor` with no caller.
- `core-types.ts` returning `Promise<unknown>`.
- The `listSources()` row-path gap.
- The spurious `deleted`+`new` pending pair.
- The phantom commands baked into `docs/images/okf-docs-banner.svg:28,30` and `docs/images/okf-readme-banner.svg:31,33` — images are not runtime advert sites, and redrawing them is a separate job.

## Log

L1 — the Manager's assignment, verbatim: "Every place the product tells a user or an agent to do something that cannot be done. The human's ruling on the review family is final and absolute: review does not come back, nothing of review. So the setting, the strings and the phantom tools that still promise it must go."

L2 — the Manager ruled the assignment splits; this document covers only the findings half (items 1-4). Removing the `review` compile option is a separate slice, briefed separately, because it alone is 16 files.

L3 — the Manager's ruling on item 1: do not empty the phantom field — a recommendation must name an MCP tool with its input shape, or an SDK method, never a binary path or command line; and a test must assert advertised ⊂ registered and recommended ⊂ registered.

L4 — measured census facts, recorded so they are not re-derived: no `bin` in any of the 7 package.json files; `test/mcp-server.test.ts:81-102` hand-maintains the 14 registered names (the drift shape to replace, not extend); no single source of truth for tool names exists; SDK is `@modelcontextprotocol/sdk` 1.32.1 supporting `listTools()` and `getInstructions()`; the 16-file `review`-option census lives in the Manager's separate brief, not here.

L5 — Manager's ruling, restated as the standing scope of this document: the assignment splits in two, and this document covers the findings half only. The `review` compile option is a separate slice with its own brief.

L6 — the sweep record, because the first census was short. The earlier string census undercounted; the verifier's grep over the tree found 92 lines carrying command tokens. Two writers then swept in parallel, one over backend sites and one over the viewer, and a third widened the guard from 6 files to all 475 files under `packages/wiki/src` and `packages/api/src`, measuring 132 offenders across 474 files at base `0cecbee5` and 0 across 475 after the change.

L7 — two decisions worth the ink. `RECOMPILE_HINT` was deleted rather than re-pointed at `compile_wiki`: scoped recompilation is reachable from nothing callable, since `compileRecompiling` is exported by no package entry and no MCP tool takes a `pages` input, so a tool name there would promise what incremental compile does not do. And `query_wiki`'s required input field is `question`, not `query`.

L8 — gate results, all exit 0 on this tree: `gates:static`; `build`; `vitest run test/artifact` (20 tests); `pnpm test` (6147 passed, 4 skipped, 352.66 s). Lint is unchanged at the zero-headroom baseline: 566 violations in 402 files across 429 rule/file entries. The known flake `test/main-subcommand-flags.test.ts:147` did not appear in this run.
