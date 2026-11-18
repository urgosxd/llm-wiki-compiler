# KG compile spend brake

Gives the vendored per-document KG **compile** route the request cap its ingest twin already has, plus a `dryRun` that stops before both paid calls. Branch `fix/kg-compile-spend-brake`, base `877e792ae0f306065afac4392a14ee7769659830`.
Outcome: an over-cap compile is REFUSED before the first paid call with stored data untouched, and the shared brake lives once in `@repo/foundation` instead of being copied.

## Specs

**S1 — A compile whose planned extraction requests exceed `LLMWIKI_KG_MAX_EXTRACTION_REQUESTS` is REFUSED before the first paid call.**
Verbatim: "**A compile whose planned extraction requests exceed `LLMWIKI_KG_MAX_EXTRACTION_REQUESTS` is REFUSED before the first paid call, and the refusal leaves stored data unchanged** — no entity, no relationship, no chunk mutation, no audit row, no ledger write."
The refusal happens before any provider call is issued, and it leaves stored data unchanged in all five named places: no entity, no relationship, no chunk mutation, no audit row, no ledger write.

**S2 — Refuse, never truncate.**
Verbatim: "**Refuse, never truncate.** A silent partial extraction that reports success is worse than a refusal; the existing cap's semantics are the specification, not an inspiration."
The existing cap's semantics are the specification. A partial extraction that reports success is the defect, not an acceptable degradation.

**S3 — `dryRun` on the compile route stops before both paid calls.**
Verbatim: "**`dryRun` on the compile route stops before both paid calls** — zero chat requests, zero embedding requests."
Zero spend is proven by the RECORDING DOUBLE RECORDING ZERO CALLS, not by "not 200", not by the absence of a counter value. The spec names which double was observed empty: the injected chat backend and the injected embedding backend, and the assertion states that both were empty.
S3 also requires the dry run's OUTPUT: a dry-run compile must report the plan it computed — planned chunk count, planned requests, the cap in force, and whether it would have refused. A dry run that answers "fine" without saying what it would have done is decoration, and it is the same defect `29b2f3a4` fixed, one phase over.

**S4 — The wiki dimension's cap behaviour is unchanged, byte for byte.**
Verbatim: "**The wiki dimension's existing cap behaviour is unchanged, byte for byte**, measured differentially against `877e792a`."
Measured differentially against `877e792a`: same input, both trees, stdout, stderr and exit code compared.

**S5 — The shared cap logic lives in `@repo/foundation` as a MOVE, not a rewrite.**
Verbatim: "**Relocate the shared logic to `@repo/foundation`** ... **A move, not a rewrite:** same exported names, same refusal shape, same counted unit, same env parser." and "a relocated brake that counts differently is two brakes."
The module is relocated, re-exported and repointed; no second copy is created in `packages/llmwiki-kg`, and no semantic change is introduced by the move.

**S6 — Under cap, extraction proceeds and the graph is written.**
Verbatim: "**Under cap → extraction proceeds and the graph is written.** The cap must not be satisfiable only by a path that does nothing."
A compile that is within the cap reaches the provider and produces graph rows; a cap satisfiable by a path that extracts nothing is not a brake, it is a disable.

**S7 — A repeat compile of an unchanged document moves no graph value.**
Verbatim: "**A repeat compile of an unchanged document moves no graph value** — confidence, `last_seen_at`, `updated_at` — because that property is what a future caller depends on and this change must not disturb it."
`confidence`, `last_seen_at` and `updated_at` are byte-identical after a second compile of an unchanged document.

**S8 — No fifth refusal label is introduced.**
Verbatim: "No fifth refusal label is introduced. A budget refusal reuses the existing `failed` arm, which carries the error text naming the variable, the cap and the actual chunk count. Do not add a label to `packages/wiki/src/dimensions/outcome.ts`."
The refusal reports itself as `failed` with error text naming the variable, the cap and the actual chunk count. No label is added to `packages/wiki/src/dimensions/outcome.ts`.

**S9 — A budget refusal is CLIENT-ADDRESSABLE, not a server fault.**
The caller can raise the cap or send a smaller document. The refusal's HTTP status must be decided from what the compile route already does for its other refusals, and pinned EXACTLY in the test together with the exact refusal message; "not 200" is not an acceptable assertion. The refusal path writes nothing — entity, relationship, chunk, ledger and audit counts identical before and after, asserted, not argued.

**S10 — One definition, one path.**
The cap is relocated, not shimmed: `packages/wiki/src/dimensions/kg/request-cap.ts` is DELETED, every caller is repointed at `@repo/foundation`, and no re-export is left behind keeping the old path alive. A re-export is permitted only if a consumer OUTSIDE this repository imports that exact specifier — and if so the spec must name that consumer, because a published barrel is a contract.

**Test obligation for every rule above (spec-adjacent, not a numbered spec).**
Every test asserts every observable effect of the rule it covers — exit or status code, exact message text, and that rejected input leaves stored data and counters unchanged — and checks through the public interface, never internal storage.

## Tasks

- T1 | S5 | feature document | commit: pending
- T2 | S5 | relocate `request-cap.ts` from `packages/wiki/src/dimensions/kg/` to `@repo/foundation`, repoint every caller and delete the old file; leave no shim (S10) — a move, not a rewrite; published-package contract change (`Risk: item 3`), own commit | commit: 49b279ae984917431f3c5e6efd916498cbd4313a
- T3 | S1, S2, S6, S9 | request cap and refusal on the `@repo/kg` compile route, test-first, exact status and message pinned | commit: 84e28fee6920c096eff92ea3b4ec1abdda1e14ac
- T4 | S3 | `dryRun` on the `@repo/kg` compile route reporting its computed plan, zero calls proven by the recording double, test-first | commit: 9f95deb362eb88a28caac716f791eb903e09897a
- T5 | S4 | differential check of the wiki dimension cap against `877e792a` in a `mktemp -d` scratch tree; scratch script only, never committed | commit: pending
- T6 | S7 | repeat-compile idempotence regression pin | commit: pending

## Log

- L1 (project assignment, verbatim):

```
Project assignment for branch fix/kg-compile-spend-brake:

## Goal
`main` today (tip `877e792ae0f306065afac4392a14ee7769659830`) has two phases for the vendored per-document KG path:
- **Phase 1 — ingest** (`POST /stacks/:stackId/documents/:doc_id/ingest`): loads, chunks, embeds, persists chunks. No model call.
- **Phase 2 — compile** (`POST /stacks/:stackId/documents/:doc_id/compile`): reads stored chunks, runs extraction + classification + consolidation.

**Phase 2 has neither a request cap nor a `dryRun`.** It can spend unbounded provider money on a document with many chunks, through a reachable HTTP route, while phase 1 and the wiki dimension are both bounded. Close that.

## Non-negotiable outcome, stated as behaviour
1. **A compile whose planned extraction requests exceed `LLMWIKI_KG_MAX_EXTRACTION_REQUESTS` is REFUSED before the first paid call, and the refusal leaves stored data unchanged** — no entity, no relationship, no chunk mutation, no audit row, no ledger write.
2. **Refuse, never truncate.** A silent partial extraction that reports success is worse than a refusal; the existing cap's semantics are the specification, not an inspiration.
3. **`dryRun` on the compile route stops before both paid calls** — zero chat requests, zero embedding requests, observed through the provider counters, not asserted.
4. **The wiki dimension's existing cap behaviour is unchanged, byte for byte**, measured differentially against `877e792a`.

## Step 1 — locate before you design. No premise in this brief is authoritative.
**Every path below is from a report, not from your own read. Verify each with `path:line` and log a correction if it is wrong.**
- `packages/wiki/.../request-cap.ts` — `assertWithinExtractionRequestCap(plannedChunks, cap)` at or near `:138`.
- Reached from a KG code path at or near `kg/index.ts:558` via `beforeProviderSpend`.
- `dryRun` short-circuits at or near `kg/index.ts:1015-1016`, ahead of `chunkAndEmbed` and `extractPendingChunks`.
- The KG dimension's commit writes at or near `dimensions/kg/index.ts:413-436`.
- `KNOWN_DIMENSIONS = ["wiki","kg"]` at or near `packages/.../activation.ts:67`.
- **The eslint boundary** in `scripts/eslint-rules/dimension-boundary.mjs` and the `no-restricted-imports` config: `wiki ↔ kg` forbidden both ways; `{wiki,kg,api} → foundation` allowed.

**The single most important thing to establish first: if a KG module already imports from `packages/wiki`, the boundary is either not what the report says or that module lives under `packages/wiki` rather than `packages/llmwiki-kg`.** **Which of those is true decides whether this task is a relocation or a boundary repair, and they are different pieces of work.** **Report that finding before writing code.**

## Step 4 — test-first, and the tests are the deliverable
Write the RED first for each rule, and observe it fail for the right reason:
1. **Over cap → refused, and stored data unchanged.** Assert the exit/status, the exact refusal message, and that entity, relationship, chunk and ledger counts are identical before and after.
2. **Under cap → extraction proceeds and the graph is written.** The cap must not be satisfiable only by a path that does nothing.
3. **`dryRun` on compile → zero chat requests and zero embedding requests**, read from the counters, plus zero graph rows.
4. **A repeat compile of an unchanged document moves no graph value** — confidence, `last_seen_at`, `updated_at` — because that property is what a future caller depends on and this change must not disturb it.
5. **One differential case for the wiki dimension's cap**: same input against `877e792a` in a `mktemp -d` scratch tree and against your change; compare stdout, stderr and exit code. Any difference nobody asked for is a regression to fix and pin.

## Standing constraints
- **Never print, copy or commit a credential.** Provider counters are how you prove zero spend; a live provider call is not required and is not authorised.
- **Do not read or modify `.env` files.**
- **Node 24 on PATH for any `git commit`** or the hook refuses under v22: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`. Never `--no-verify`, never `HUSKY=0`.
- **File mode must be declared** in tests, as in production.
- **A committed test must never read git history.** Differential checks live in scratch scripts, not in the suite.
- **Do not touch** `packages/llmwiki-kg/LICENSE.md` or `packages/llmwiki-kg/ts/oracle/**`.
- **Do not change the extraction algorithm**: same entities, same relationships, same chunk boundaries, same prompts, same per-chunk calls, same graph hash for the same input. Only the brake is new.

## Deliverables and reporting
- **The feature document `odd/tasks/kg-compile-spend-brake.md`**, with `## Specs` quoting this brief's numbered outcomes, `## Tasks`, and `## Log` whose L1 is this task verbatim.
- Work-unit commits on `fix/kg-compile-spend-brake`, Conventional Commit messages, tests and docs in the same slice as the behaviour, and the `Risk:` line on every commit.
- **Report the full 40-character SHAs.** Abbreviated SHAs are refused by integration.
- **Report failures and skips explicitly, with the scope that produced each number.** A green from a narrower scope must say what it excluded.
- **Report your disagreements:** any premise here you disprove is worth more than the code.
- **Nothing pushed. No pull request. No merge.**

**End the report with the branch's final `git rev-parse HEAD`, `git status --porcelain` empty, and the gate you ran with its file and test counts.**
```

- L2 — Step 1 findings (verified by recon, before any code):
  - There is NO existing `@repo/kg → @repo/wiki` reach. `packages/wiki/src/dimensions/kg/index.ts` (the kg dimension adapter inside `@repo/wiki`) holds `beforeProviderSpend` at :548, resolving the cap at :558 and asserting at :562. The money-spending HTTP compile route is `packages/llmwiki-kg/ts/src/routes/ingest/compile.ts` in `@repo/kg`. This is therefore a RELOCATION, not a boundary repair.
  - The eslint matrix forbids `wiki ↔ kg` both ways (`WIKI_TO_KG` patterns `(^|/)packages/llmwiki-kg(/|$)` and `^@repo/kg(/|$)`, in `eslint.config.mjs`), and nothing restricts importing `@repo/foundation`, which both packages already import.
  - The compile route has NO `dryRun` anywhere today; `dryRun` exists only in the wiki dimension (`packages/wiki/src/dimensions/kg/index.ts`, :1015-1016 short-circuit ahead of `chunkAndEmbed`/`extractPendingChunks`).
  - The KG dimension's graph writes are around :655-718 (`writeGraph`), not :413-436 as the brief stated.

- L3 — Manager corrections to the brief (four premises), accepted:
  - There is no `@repo/kg → @repo/wiki` reach. `request-cap.ts` is the kg dimension adapter living inside `@repo/wiki`; the money-spending route is `packages/llmwiki-kg/ts/src/routes/ingest/compile.ts` in `@repo/kg`. The boundary is intact; the problem is placement, not violation. This is a RELOCATION, not a boundary repair.
  - Outcome 3 is new surface, not a fix: the compile route has no `dryRun` and no spend concept at all, so this invents one on a route that never had it.
  - "Observed through the provider counters" was a claim about an instrument never verified to exist. `@repo/kg` has injectable backends and no located counters. A recording double is the instrument, and the spec names which double was observed empty.
  - `writeGraph` is around `:655-718` with the ledger at `:712`; `:413-436` was wrong.

- L4 — Step 3 decision and its reasoning (no fifth label):
  Reject `not-attempted` (the run does reach the dimension), `disabled` (`LLMWIKI_DIMENSIONS` is not what refused it; a cap is not a switch), `declined` (it had plenty to write) and `not-in-route` (the route composes it). Reuse the existing `failed` arm: the state is `"failed"` on a throw, and `ExtractionRequestCapError`'s message names the variable, the cap and the actual chunk count — a failure that states its own remedy. The bar for a fifth label is that every other label would be a lie about this case, and that bar is NOT cleared. The compile route emits no `DimensionOutcome` at all, so it needs no label. `packages/wiki/src/dimensions/outcome.ts` is not modified by this feature.

- L5 — T2 findings, correcting my own task text:
  - `test/dimensions/kg-request-cap.test.ts` EXISTS and is the cap's only direct unit coverage; the earlier claim that it did not exist was wrong. Observed counts, identical before and after the move: `Test Files 1 passed (1)`, `Tests 11 passed (11)` — 11 `it` blocks, not the 12 my task text asserted. Its import specifier is repointed at `@repo/foundation/extraction-request-cap` in the same slice; no assertion, case name or order changed.
  - That file also pins the recording doubles this feature will use for zero-spend proofs: `test/fixtures/kg-provider-fetch.ts` exports `installKgProviderStub`, `uninstallKgProviderStub`, `clearCapturedRequests`, `chatRequestCount`, `embeddingRequestCount`. **That is the instrument**: "observed through the counters" means these counters read as absolutes after `clearCapturedRequests()`, and T3/T4 read the same ones.
  - `@repo/foundation` is consumed as raw TypeScript (`exports` → `./src/*.ts`, no `dist`, no package tsconfig); the cap is published as the `./extraction-request-cap` subpath and is deliberately NOT re-exported from the root barrel — one brake, one public specifier. No `#extraction-request-cap` interior name was minted, because no barrel re-export would use one.

- L6 — T3 evidence (compile route brake), test-first:
  - RED, observed against the pre-change route: `expected 413 "Payload Too Large", got 200 "OK"` for the over-cap case and `expected 500 "Internal Server Error", got 200 "OK"` for the unresolvable-cap case; the at-the-cap case passed before and after, which is what S6 wants (it is the guard that the cap is not satisfied by a do-nothing path, not a behaviour this task changes).
  - The brake is placed in `compileDocument` between the read stage and `compileChunks`, using `read.chunks.length` as the planned extraction request count. No tokenisation pass was added.
  - 413 is pinned with the cap module's own message, obtained in the test by calling `assertWithinExtractionRequestCap` and catching it, so no sentence is hand-written. The invalid-cap 500 is pinned against `resolveExtractionRequestCap(...).problem` the same way.
  - `stackSnapshot`/`counted` moved from `compile-route.test.ts` into `routes/ingest-harness.ts` and imported by both compile suites; `compile-route.test.ts` cases untouched.
  - Checks before the commit: `pnpm exec tsc --noEmit` clean, `pnpm run typecheck:tests` "1714 files checked; 237 baseline diagnostics in 85 files; no regression", `pnpm run build` success. Route suites: 21 files, `Test Files 20 passed | 1 skipped (21)`, `Tests 132 passed | 1 skipped (133)`; the single skip is `ingest-gateway.test.ts`, which gates on `AKS_TEST_GATEWAY=1` and is unrelated to this task. The database was obtained (the suite adopted a running `pgvector/pgvector:pg16` container), so nothing was skipped for lack of one, and `LLMWIKI_TEST_ALLOW_NO_DATABASE` was never set.

- L7 — T4 evidence (`dry_run`), test-first:
  - RED, observed against the post-T3 route: the under-cap dry run returned the 8-key compile result instead of the 5-key plan; the over-cap dry run returned `413` where the plan is required; `?dry_run=maybe` returned `200` (the flag was stripped as an unknown query key) instead of `422`. Two cases passed before and after, by design: the unusable-cap `500` and the ingest-ignores-`dry_run` case.
  - `dry_run` is read by `parseIngestRequest` exactly like `synthesize_descriptions` (`pydanticBoolean().optional()`), declared last so the reported 422 order stays `synthesize_descriptions`, `ontology_contract`, `dry_run`. `IngestParams.dryRun` is `boolean | null`, so "absent" stays distinct from "explicitly false".
  - The plan DTO `CompilePlan` lives in `models.ts` with `dry_run` as `z.literal(true)`, so a payload cannot claim `false` and be read as a completion. It carries no compile-result field.
  - Ordering in `compileDocument`: resolve the cap → `500` when unresolvable → `200` plan when `params.dryRun === true` → assert the cap → `413`. So a dry run is never refused for cost, and a misconfiguration is never reported as a plan.
  - The instructed documentation grep `grep -rn "documents/:doc_id/compile" docs README.md packages/llmwiki-kg --include=*.md` matches NOTHING (exit 1): every markdown reference uses the FastAPI brace form `documents/{doc_id}/compile`, and the only file matching that form is `packages/llmwiki-kg/README.md`. That file is the documentation updated in this slice.
  - Checks before the commit: `pnpm exec tsc --noEmit` clean, `pnpm run typecheck:tests` "1715 files checked; 237 baseline diagnostics in 85 files; no regression", `pnpm run build` success. Route suites: 22 files, `Test Files 21 passed | 1 skipped (22)`, `Tests 137 passed | 1 skipped (138)`; same single pre-existing `AKS_TEST_GATEWAY` opt-in skip, no database-related skip.
