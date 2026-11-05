# Feature: align-dimension (Project 2 of 3)

One name for the Stack argument across both dimensions, two `list_stacks` tools that
agree field for field, and no surviving documentation claiming a Python oracle still
governs either dimension. Branch `feat/align-dimension`, base
`feat/all-tools-without-stackId` @ 2340970 (17 commits; `npm test` green at 784 files /
5940 tests / 272s).

## Specs

S1. ONE NAME FOR THE STACK ARGUMENT, BOTH DIMENSIONS. `stackId` (camelCase) becomes the only name; `stack_id` disappears from the KG dimension's MCP surface. It is a rename of one concept, not a new concept: both dimensions keep the SAME validation rule, a UUID, exactly the semantics `src/mcp/stack-arg.ts` enforces and `test/mcp/stack-id-guard.test.ts` pins. The KG side gets the equivalent validation if it does not already have it — a malformed id must be refused before it reaches Postgres in both dimensions, with one shared rule, not two drifting copies.

S2. The rename covers every surface that carries the inbound field: KG MCP schemas (`packages/llmwiki-kg/ts/src/mcp/handlers.ts`, `dispatch.ts`, `format.ts`, `narrow.ts`, `query-string.ts`), HTTP routes (`packages/llmwiki-kg/ts/src/routes/**`), pydantic-style schemas (`packages/llmwiki-kg/ts/src/pydantic/**`), core params (`packages/llmwiki-kg/ts/src/core/**`), SQL and stored procedure parameters under `packages/llmwiki-kg/db/**` where it is an inbound field, plus docs, examples, fixtures and tests. Distinguish inbound request fields from outbound response fields and report that split; renaming an outbound field is a separate decision not made alone.

S3. UNIFY THE TWO `list_stacks` TOOLS. They are two separate stdio servers, so "unified" cannot mean one shared implementation: it means identical tool name, identical input schema and identical output shape, each implemented in its own dimension. Fix a single contract and make both dimensions satisfy it, proven by one contract test that drives both servers over a real handshake and compares the declared schema and the response envelope field by field. Both stay exempt from the required-stack rule, as decided in Project 1 (a discovery tool cannot require the id it discovers); that exemption must survive the unification and stay pinned per dimension.

S4. DOCUMENTATION OF PARITY THAT NO LONGER EXISTS. Delete the comments and doc notes that claim parity or mirroring with the Python reference oracle in `packages/llmwiki-kg/ts/src/mcp/py-format.ts` and `packages/llmwiki-kg/ts/src/pydantic/**`, and any markdown that asserts it. The human ruled the oracle non-authoritative ("IGNORA PYTHON_TOOLS_JSON , ya no importa el oraculo") and chose to remove the stale documentation so it cannot mislead later. Remove the claim, keep the code.

S5. Every existing caller, fixture and test that uses the old name is updated, and the list goes in this feature document.

S6. Docs and CHANGELOG: every markdown that documents the field name or the tool contract is updated, and the CHANGELOG carries an explicit breaking-change entry naming the rename and what an external consumer must change.

## Tasks

T0. In `test/quickstart-integration.test.ts`, replace the four `it.skipIf(stackAlwaysOn)` call sites with a plain `it.skip` that states the real reason, and correct the docblock that calls the predicate "the honest signal". Behavior-identical: `testDatabaseUrl()` never returns an empty string, so the predicate is a constant `true`. The four tests stay non-executing; resurrection belongs to `feat/reach-test`. — S4, and the named gap in L6 — route: worker — commit: pending

T1. State the Stack-id UUID rule once in a home both dimensions can import, and make the KG dimension refuse a malformed id before it reaches Postgres, with the same rule and the same message semantics the wiki dimension already has. — S1 — route: worker — commit: pending

T2. Rename the inbound Stack field from `stack_id` to `stackId` across the KG MCP surface, its tests, fixtures and examples, keeping the suite green. — S2, S5 — route: worker — commit: pending

T3. Rename the inbound Stack field from `stack_id` to `stackId` across the KG HTTP routes and their tests, keeping the published route contract otherwise byte-identical. — S2, S5 — route: worker — commit: pending

T4. Rename the inbound Stack carrier from `stack_id` to `stackId` across KG pydantic schemas and core params, keeping every acceptance and rejection behaviour those schemas pin. — S2, S5 — route: worker — commit: pending

T5. Fix one `list_stacks` contract and make both dimensions satisfy it, proven by one contract test that drives both stdio servers over a real handshake and compares declared schema and response envelope field by field, with the required-stack exemption still pinned in each dimension. — S3 — route: worker — commit: pending

T6. Remove the Python-oracle parity claims from `py-format.ts`, `packages/llmwiki-kg/ts/src/pydantic/**` and the markdown that asserts them, keeping all code, identifiers and imports. — S4 — route: worker — commit: pending

T7. Update every markdown that documents the field name or the tool contract, and add the CHANGELOG breaking-change entry naming the rename and what an external consumer must change. — S6 — route: worker — commit: pending

T8. Update the remaining callers, fixtures and tests that use the old name and record the S5 inventory table in this document under `### S5 inventory`. — S5 — route: worker — commit: pending

T9. Run the gates with their exact scope (`npx tsc --noEmit`, `npm run build`, `npm test`, `fallow`) and the shared-code differential against the base commit in a `mktemp -d` scratch, and record both results in this document. — all S# — route: verify — commit: pending

INBOUND/OUTBOUND SPLIT. S2 requires the rename to be reported as a split, and the split is a deliverable of this feature, not a note: inbound request fields become `stackId`, outbound response fields are reported and left alone unless the Manager rules otherwise.

## Log

L1 (human request, verbatim, do not translate): "Project 2: feat/align-dimension
se unificaran las tools de list_stacks, y alinea el  Naming divergente: stackId (camel) vs stack_id (snake) para el mismo concepto entre dimensiones.
    Ninguna de las dos usa tenant, ni slug, ni RLS — sigue siendo stack id, validado como UUID
    (stack-arg.ts + test/mcp/stack-id-guard.test.ts), debe corregireso esto solo un nombre"

L2 (STEP 0, tracking): this document was created and mirrored to persistent memory under topic_key `odd/align-dimension` before any source write, per the ODD tracking rule. Base verified: `feat/align-dimension` and `feat/all-tools-without-stackId` both point at 2340970, the working tree is clean, and `main` @ 8203862 does not contain 2340970.

L3 (recon, T0 provenance verdict): the four skipped expectations in `test/quickstart-integration.test.ts` PRE-EXIST base 8203862 and were not introduced by Project 1. Evidence: the file blob is byte-identical at 8203862 and at HEAD (`31e0fc58` both, `sha256 4f63307c…`, 473 lines both); `git log 8203862..HEAD -- test/quickstart-integration.test.ts` is empty; the pickaxe searches over `it.skip`, `skipIf` and `stackAlwaysOn` each return only `0ce01fc`, whose ancestry check against 8203862 is rc=0. No skip was added or renamed later, so nothing was moved. The four call sites are `it.skipIf(stackAlwaysOn)` at lines 291, 424, 438 and 451.

L4 (Manager ruling on T0): "leave the tests dead, but do NOT leave the lie in place. Both halves are required." Resurrection is not this project's work — it is the same family as Project 1's L16 and belongs to `feat/reach-test` (Project 3), the branch that stands up Postgres, the API and database-level isolation. What this project does fix is the falsehood: T0 replaces the tautological predicate with a plain `it.skip` carrying the real reason in source and corrects the docblock. Behavior-identical, which is exactly why it is safe: what runs does not change, only the source's false claim that a live guard exists.

L5 (recon, contract surface correction): `contract-cordination.json` is NOT the published HTTP contract. It declares producer status at `:3` and otherwise assigns write ownership; the actual published surface consumed by the external AgentDocumentor repository is the route tree `packages/llmwiki-kg/ts/src/routes/**` (`aks.ts`, `backfeed.ts`, `documents.ts`, `ingest.ts`, `pages.ts`, `stacks.ts`, `stack_graph.ts`, `synthesize.ts`). The S2 inbound/outbound split and the `Risk: item 3` argument are therefore made from that route tree, never from the coordination file.

L6 (named gap, not fixed in this project): these four tests execute in NO configuration. `test/fixtures/test-database.ts:62-65` `testDatabaseUrl()` returns `DEFAULT_TEST_DATABASE_URL` (`postgresql://aks:aks@localhost:5434/aks`, `:49`) when the override is empty and never returns `""`, so `stackAlwaysOn = testDatabaseUrl() !== ""` is unconditionally `true`. The inline docblock at `:39-47` claiming the URL "is what activates the dimensions, so it is the honest signal" is false. They were skipped originally because the locker is a Postgres advisory lock keyed by Stack id and one fixture is 33 characters, so repairing the predicate is not a two-line fix. Pointer: `feat/reach-test` (Project 3), alongside Project 1's L16 items.

L7 (documentation staleness follow-up, deliberately not edited): `contract-cordination.json` still describes roles and worktrees that no longer match reality — it names `orchestrator-a`, `orchestrator-b` and a retired `orchestrator-c` — and it is shared coordination surface, so this project records the staleness and does not rewrite the file.

L8 (recon, the two `list_stacks` as found): they are structurally far apart, which is what makes S3 a contract decision rather than a tidy-up. The wiki dimension registers at `src/mcp/stack-tools.ts:29-67` with an input schema of `limit?: number` plus `stackId?: string` whose meaning is mark-current rather than narrow, reads Postgres through `withTenantDatabase`/`listStacks`, and returns JSON `{ stacks, count }` through `jsonResult`. The KG dimension registers at `packages/llmwiki-kg/ts/src/mcp/handlers.ts:445-485` with NO input schema and NO description, proxies a remote `GET {baseUrl}/stacks`, and returns human-readable prose lines through `formatStacksResponse` (`format.ts:213-223`) with no envelope at all. The wiki side has 11 tests in `test/mcp/list-stacks.test.ts`; the KG side has none.
