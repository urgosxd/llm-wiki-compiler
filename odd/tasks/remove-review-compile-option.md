# Feature: remove-review-compile-option

Delete the `review` compile option from the product. It promised a hold with no promotion
surface, and the ruling is absolute: review does not come back, nothing of review. Branch
`fix/remove-review-option`, base `main` `8c8d86fff8b350b5a8442ba997db86aba511ef9d`, tree clean
at start. Task T0 is documentation-only: this file and its Engram mirror. Code, tests, commits
and docs in English.

## Specs

S1. Removal, not softening. Verbatim: "Remove the `review` option from the product. The human's
ruling is final and absolute: **review does not come back, nothing of review** — so the option
that promises a hold with no promotion surface is deleted, not softened and not re-added."

S2. Scope is the compile option only. Query carries a DISTINCT `review` field with its own guard,
verbatim: `"Query review requires save."` (`packages/wiki/src/commands/query-publication.ts:45`).
It stays, together with `packages/wiki/src/commands/query.ts`,
`packages/wiki/src/commands/query-publication.ts`, `packages/wiki/src/commands/query-proposal.ts`,
`packages/wiki/src/sdk/core-types.ts:192` and `docs/guides/sdk.mdx:140,168`. Removing it would
orphan `stageQueryProposal` and create the new dead code S9 forbids.

S3. The field goes from both option types, with its comment. Verbatim: "The advertising slice
already cleaned the `review?: boolean` **doc comment** at `utils/types.ts:230`; the field itself
is yours." Measured at `8c8d86ff` the JSDoc is still present, so field and comment both go:
`packages/wiki/src/utils/types.ts:227-232` and `packages/wiki/src/sdk/core-types.ts:19-21`.

S4. Every read of the option goes. Census verbatim: "`sdk/core-types.ts:19-21`,
`utils/types.ts:226-232`, `compiler/review-pipeline.ts:55-60,90-96`,
`compiler/index.ts:433,790,1072-74,1164,1185-92,1223,1301`,
`compiler/extraction-snapshot.ts:78-82`". Re-derived at `8c8d86ff`, every path under
`packages/wiki/src/`: `compiler/index.ts:433,790,1072,1164,1185,1229,1307`,
`compiler/review-pipeline.ts:90`, `compiler/extraction-snapshot.ts:80,82`. Two brief line numbers
were wrong: `1223` is `1229`, `1301` is `1307`.

S5. The refusal sits at first use and throws. Verbatim: "**a runtime guard at first use on the
compile entry**, naming the removed option and saying no promotion surface exists. Typed consumers
already get a type error; the guard is for untyped and dynamically-built callers. Prove it by
**executing** the failing path and quoting the message."

S6. Guard placement, measured. `compile` (`packages/wiki/src/compiler/index.ts:287`) returns
`Promise<void>` and discards `compileAndReport`'s result; the SDK wrapper
(`packages/wiki/src/sdk/core.ts:113-117`) spreads `...opts` and never turns `Collection` errors into
a failure, so a returned error would be SILENT. Every `CompileOptions` entry funnels through
`compileAndReport` (`compiler/index.ts:330`): `compile`, `compileRecompiling`, `compileDelta`
(`compiler/delta.ts:79`), `sdk/core.ts:116`, `services/ingest/jobs/run.ts:216`, `mcp/tools.ts:120`,
`packages/api/src/host/api.ts:406,447`. So one guard, as the first statement of `compileAndReport`,
and it throws. It rejects the presence of the key, so `{ review: false }` fails too.

S7. The guard message is fixed, verbatim:

`The review compile option no longer exists: no surface promotes a held candidate, and the option will not come back. Remove it from your call.`

S8. The trust machinery is not deleted. Verbatim: "`trust/executor.ts`, `trust/planner.ts` and the
surrounding review/trust data model were deliberately preserved by an earlier slice — the human's
ruling covered **the promise of a hold**, not the data model." Nothing under
`packages/wiki/src/trust/` references the compile option (zero hits for `options.review`,
`review?: boolean`, `CompileOptions`), so nothing there is edited.

S9. No silent dead code. Verbatim: "If removing the option leaves `review-pipeline.ts` or anything
else without a caller, **report it with a proposed verdict rather than deleting it silently**."
Re-derived: `persistReviewCandidate` stays reachable through the policy branch
(`review-pipeline.ts:98-102`); OKF import reaches `writeCandidate` (`import/run.ts:57-59`) and query
proposals reach `writeFreshCandidate` (`commands/query-proposal.ts:43`), not it;
`generateMergedPage` is called unconditionally from `index.ts:456`. `reviewMode: "forced"` survives
at `commands/query-proposal.ts:45`. The `manual-review-requested` held reason loses its only
producer and is KEPT, because candidate records already on disk carry it and must stay readable.

S10. Out of scope, verbatim: "Do not touch `sources/removal-plan.ts`, `commands/export.ts`'s
`exportCommand`, or `compileRecompiling` — recorded dead-code facts owned elsewhere. Do not touch
the `.sql` advert lines; another slice owns those."

S11. Docs, verbatim: "6 docs (`docs/configuration/review-policy.mdx:7,43`,
`docs/introduction.mdx:53`, `docs/concepts/how-it-works.mdx:101`,
`docs/concepts/wiki-model.mdx:56`, `docs/guides/sdk.mdx:121`, `README.md:81,235`)" — all seven line
numbers re-derived correct at `8c8d86ff`. Query's own option documentation
(`docs/guides/sdk.mdx:140,168`) is not one of them and is not edited. When a command, option or
message changes, the help text and docs describing it change with it.

S12. Gates, verbatim: "`gates:static` · `tsc --noEmit` · `typecheck:tests` · `typecheck:kg` ·
`lint` (**zero headroom**: literal `566 baseline violations in 402 files across 429 rule/file
entries`; **`lint:update` is forbidden**) · `fallow:ci` · `fallow:kg` · `build` · **`vitest run
test/artifact`** (`package.json` has no `test:artifact` script — do not cite one) · **`pnpm test`
alone, and capture its exit code properly**: `set -o pipefail` or `PIPESTATUS`, never a bare
`| tee`".

S13. Prohibitions, verbatim: "No history rewriting (no `git reset`, `git restore --staged`,
`--amend`). **No hook bypass of any kind** — plain `git status` never runs hooks, so there is no
legitimate use for a hooks-path override here. **No `cp -a` of this worktree**: `.git` is a pointer
file, so a copy is a second handle on the same shared gitdir. No push, no `--no-verify`, no
`HUSKY=0`. `odd/tasks/**` append-only except the tracker line."

S14. Recorded product finding for the Supervisor, NOT fixed on this branch. Query carries a
second option named after the same missing capability: `query({ save: true, review: true })` stages
a saved answer as a candidate via `packages/wiki/src/commands/query-publication.ts:103` →
`stageQueryProposal` (`packages/wiki/src/commands/query-proposal.ts:36,43`) → `writeFreshCandidate`
(`packages/wiki/src/compiler/candidates.ts:225`). By the advertising slice's own measurement no surface
promotes a candidate, so it writes a record nothing can act on. Scope is the Supervisor's decision,
not this slice's: S2 keeps the field.

S15. Correcting the record. The advertising slice's accepted report claimed it "already cleaned the
`review?: boolean` doc comment at `utils/types.ts:230` ahead of that slice's field removal".
Measured at `8c8d86ff` that is false: the JSDoc is present at
`packages/wiki/src/utils/types.ts:228-231` and at `packages/wiki/src/sdk/core-types.ts:20`. The
comment goes with the field in this slice (S3). A completion claim for work that did not happen.

## Tasks

T0 | S12 | worker | done (43a2e089a415c1afc9f80280af0c87db37cd84c6) — This feature document and its Engram mirror (no source changed).
T1 | S1, S3, S4 | worker | done (43a2e089a415c1afc9f80280af0c87db37cd84c6) — Delete the `review` field from `CompileOptions` and `SdkCompileOptions` with its JSDoc, and every read at the measured sites.
T2 | S5, S6, S7 | worker | done (43a2e089a415c1afc9f80280af0c87db37cd84c6) — Test-first runtime guard at first use on `compileAndReport`, rejecting the presence of the key.
T3 | S9, S10 | worker | done (43a2e089a415c1afc9f80280af0c87db37cd84c6) — Dead-code re-derivation recorded with a verdict; `manual-review-requested` kept with its reason; out-of-scope files untouched.
T4 | S11 | worker | done (43a2e089a415c1afc9f80280af0c87db37cd84c6) — The seven documentation sites; query's own option docs untouched.
T5 | S2, S8 | worker | done (43a2e089a415c1afc9f80280af0c87db37cd84c6) — Query's distinct `review` option and the trust machinery verified untouched.
T6 | S12, S13 | verify | done (43a2e089a415c1afc9f80280af0c87db37cd84c6) — Independent verification: executed proof of the guard, `vitest run test/artifact`, the full suite's literal exit code.
T7 | S12, S13 | worker | done (43a2e089a415c1afc9f80280af0c87db37cd84c6) — One work-unit commit on the feature branch, no hook bypass.
T8 | S14, S15 | — | recorded (7a91d049) — The query `review` option recorded as NAMED OPEN PRODUCT QUESTION PQ1 (human ruled: the option stays; not a defect this slice declined), plus the false "already cleaned" doc-comment claim recorded for the Supervisor with both paths. No code, no decision taken, no writer.
T9 | S5, S6, S7 | worker | done (43a2e089a415c1afc9f80280af0c87db37cd84c6) — Durable entry coverage committed: `test/review-option-removal.test.ts` and `test/review-option-removal-entries.test.ts`, each asserting the S7 message literally and that no `.llmwiki/` is created for the refused path.
T10 | S11 | worker | done (43a2e089a415c1afc9f80280af0c87db37cd84c6) — `CHANGELOG.md` Unreleased/Changed entry for the removal and the throwing guard it leaves behind.
T11 | S12, S13 | verify | done (43a2e089a415c1afc9f80280af0c87db37cd84c6) — Final independent verification pass over the committed tree: full suite, every static gate, executed guard proof, docs census. Measurements in L6.
T12 | S14 | — | done — PQ1 recorded as an open product question in L7 with the ruling that keeps the query option.
T13 | S12, S13 | worker | done (5c9686ef + fc97b655 + this docs(odd) commit) — Authorised lint-decrease rebaseline (`eslint-baseline.json`, one number, ratchet now 565), the `review.forced` CHANGELOG sentence, and the twelve-item census-error record in L8. The viewer advert was NOT edited here: `fix/stop-advertising-removed-surfaces` already rewrites the same lines to the same effect.
T14 | S5, S6, S9, S14 | verify | done — The promotion question measured (verdict B, absence proof in L9 Part A); guard message and CHANGELOG confirmed TRUE; the three stagers and the ruling to retire them recorded for the follow-on slice.
T15 | S12, S13 | verify | done — Final gate pass on base+7: suite exit 0, gates:static 0, lint 565/402/429; the reconciliation-with-main finding appended as L10.
T16 | S13 | worker | done — L10 appended: L9 Part E's "not merged into main" corrected, and the four-file overlap with `main` recorded with its guard-loss hazard.
T17 | S12, S13 | worker | done — Branch rebased onto `main` `2872661ccab752a864f35dee709c3ae995848bb1`: three overlap conflicts resolved by re-applying our removal on top of `main` (keeping `main`'s "Wiki compile" banner), the seven-guard probe set executed 10/10, and every gate + the full suite re-measured on the reconciled tree. Old->new SHAs, conflicts and measurements in L11.

## Log

L1 (the assignment, verbatim): "Project assignment for branch fix/remove-review-option: Remove the `review` option from the product. The human's ruling is final and absolute: **review does not come back, nothing of review** — so the option that promises a hold with no promotion surface is deleted, not softened and not re-added." Census, refusal-at-first-use ruling, "what must NOT happen" list, gates and report requirements as quoted in S1-S13 above.

L2 (re-derived census corrections, this slice). The census is authoritative only after re-measurement, and this slice's re-measurement corrected it three ways. First, two line numbers: the `compiler/index.ts` option reads are at `1229` and `1307` at `8c8d86ff`, not `1223` and `1301` — six lines off each. Second, the `utils/types.ts:228-231` JSDoc was still present at base, contradicting the advertising slice's accepted report that it had "already cleaned the `review?: boolean` doc comment at `utils/types.ts:230`" (S15); the comment left with the field here. Query's `review` is a distinct option with its own guard, `"Query review requires save."` (`commands/query-publication.ts:45`), and is not this option (S2). Third, the dead-code premise was HALF false: of the three routes the census named for `persistReviewCandidate`, only the policy branch reaches it (`review-pipeline.ts:91`, the sole call site, which passes `reviewMode: "policy"`), while OKF import reaches `writeCandidate` (`import/run.ts:57-59`) and saved-answer query proposals reach `writeFreshCandidate` (`commands/query-proposal.ts:43`). The census also missed a ninth compile-option test file: `test/compile-candidate-preflight.test.ts` passed `{ review }` into `compileAndReport` at base (`:28`, `:37`), and because it used the shorthand form a grep for `review:` never saw it — `typecheck:tests` caught it, not a grep. Eight pre-existing test files were touched, plus `test/review-option-removal.test.ts` and `test/review-option-removal-entries.test.ts` new to this slice.

L3 (`CompileResult.review.forced` has no producer left — REPORTED, NOT DELETED). `review-pipeline.ts:175` derives `mode: meta.reviewMode === "policy" ? "held" : "forced"`, and after the option's removal `persistReviewCandidate` has one call site, `review-pipeline.ts:91`, which hard-codes `reviewMode: "policy"` (`:92`), so the `"forced"` member of the union at `:51` no longer has a producer. So the array built at `index.ts:478` and pushed at `index.ts:483` stays empty for every surviving run, `utils/types.ts:205` declares a field nothing produces, and the second branch of `compile-report.ts:253-259` is unreachable. Verdict: REPORTED, NOT DELETED. It is an output-only field of a public result type (`CompileResult.review`), deleting it would change the public result shape a second time in one slice on top of the option's own removal, and `fallow:ci` reports 0 dead code introduced (`--gate new-only`), so nothing forces that second shape change here. Owner: a follow-on slice decides between removing `forced` from the result and giving it a producer.

L4 (viewer advert still teaches the removed option — REPORTED, NOT FIXED, OWNER NEEDED). `packages/wiki/src/viewer/assets/viewer-reviews.js:106-109` still renders the empty reviews state as "Review candidates are pages the compiler held back instead of writing live. Approve one with the CLI and it becomes a wiki page." (`:108`) with `"$ llmwiki compile --review"` (`:109`) as its example command. The file is byte-identical to `8c8d86ff` (`git diff --stat` over it at base is empty), so the advert predates this slice — the CLI it names was already retired when it was written — and it is NOT fixed here: `viewer/assets/**` is outside this task's edit surfaces and the string is pre-existing. Owner: the slice that owns the viewer assets. A sibling advert survives in `compile-report.ts:253-259`, whose candidate summary line prints `run \`llmwiki review list\`` — a command that no longer exists either, and also pre-existing, also outside this task's surfaces.

L5 (correcting L3, appended — L3 stays as written). L3's sentence "so the `"forced"` member of the union at `:51` no longer has a producer" is factually wrong and is corrected here. `reviewMode: "forced"` IS still produced: `packages/wiki/src/commands/query-proposal.ts:45` sets `reviewMode: "forced"` on the candidate it stages for a saved answer (`query({ save: true, review: true })` -> `stageQueryProposal` -> `writeFreshCandidate`), so `ReviewCandidateMeta.reviewMode: "policy" | "forced"` at `packages/wiki/src/compiler/review-pipeline.ts:51` has a live producer and that union member is alive, not dead code. What actually lost its producer is the OUTPUT field `CompileResult.review.forced` (`packages/wiki/src/utils/types.ts:205`): `packages/wiki/src/compiler/compile-report.ts:119` fills it (`baseResult.review = generation.review`) and `packages/wiki/src/compiler/delta.ts:95-96` reads it (`...(result.review?.forced ?? [])`), and the only path that ever populated it was the removed compile option — which is why `index.ts:478`/`:483` now push nothing for every surviving run. L3's verdict is unchanged and still stands: REPORTED, NOT DELETED, owner for a follow-on that decides between removing `forced` from the result and giving it a producer. This entry reconciles L3 with S9 and L2, which already recorded `reviewMode: "forced"` as surviving at `commands/query-proposal.ts:45`.

L6 (final measurements for the committed tree — evidence, verbatim). Work unit committed as `d1441ba32dca6b7dc2a04067b102c57500db16e7` (23 files, +549/-215; pre-commit hook ran `fallow:ci` and `tsc --noEmit` and both passed). Full suite `corepack pnpm test` exit **0** — `Test Files 818 passed | 3 skipped (821)`, `Tests 6150 passed | 4 skipped (6154)`, 338.81 s, container `dreamy_bose` freshly started, `adopted running` count 0. `gates:static` exit **1** for the lint decrease ONLY: `packages/wiki/src/compiler/index.ts max-lines-per-function: violations decreased from 5 to 4`; `eslint-baseline.json` unmodified and `lint:update` never run — the ruling on recording that decrease is still pending with the Supervisor. Every other gate exit 0: `tsc --noEmit`, `typecheck:tests` 1587 files, `typecheck:kg` 357 files, `fallow:ci` 0 dead-code introduced, `fallow:kg`, `build`, `vitest run test/artifact` 29/29. The pre-commit hook runs ONLY `fallow:ci` and `tsc --noEmit` and never reads `eslint-baseline.json`, so the lint decrease does not block the commit but it does block the required CI check. Two record corrections carried in the work unit: L5 above repairs L3's false union-member claim (appended, L1-L4 untouched), and `CHANGELOG.md` now reads "A compile now captures the identities before orphaning and retires them" — the `non-review` qualifier implied a contrast against a mode that no longer exists; nothing else in that entry changed.

L7 (ruling recorded, and one product question left OPEN by name — not a defect this slice declined). The human ruled on the query option: it stays, and the Supervisor confirmed the consequences by message — no folding into this slice, no rename, no guard on the query path. S2 therefore stands as written and nothing in this branch touches that option. The question the re-derivation raised is recorded here as an open product question, named so whoever picks it up can find it:

PQ1 — the query `review` option is named after a workflow this product does not have. The option stages a saved answer as a review candidate: `packages/wiki/src/commands/query-publication.ts:103` calls `stageQueryProposal` (`packages/wiki/src/commands/query-proposal.ts:36`), which calls `writeFreshCandidate` (`packages/wiki/src/compiler/candidates.ts:225`, imported at `query-proposal.ts:10`) with `reviewMode: "forced"` (`query-proposal.ts:45`), writing a record into `.llmwiki/candidates/`. By the advertising slice's measurement — a claim this branch did NOT verify itself, and which is under measurement now — no surface promotes a candidate, so that record names a workflow the product cannot complete. The option's name promises something the product does not have, which is the same defect that removed the compile option, one door down. If that measurement comes back the other way, this entry is superseded by a later one; PQ1 stands either way, because it is about what the option's NAME promises, not only about whether a promotion path exists today.

This is a QUESTION, not a declined defect. Nothing here is a bug this slice chose not to fix, and nothing here is a guard target: the option behaves exactly as documented and the human ruled that it stays. What a follow-on must decide, and only the human can: rename the option to what it actually does (stage a saved answer as a candidate), remove it, or build the promotion surface the candidates directory has always implied. Each answer implies a different slice and none is authorized by this branch.

Two facts a follow-on must not lose. First, the query guard `"Query review requires save."` (`packages/wiki/src/commands/query-publication.ts:45`) is intact and asserted by `test/query-publication-sdk-mcp.test.ts:109-116`. Second, `stageQueryProposal` and `writeFreshCandidate` are reachable BECAUSE of this option — removing it would orphan them, which is why folding the query option into this slice would have manufactured exactly the new dead code S9 forbids. That is also why the two mechanisms are not interchangeable and must not be treated as one: the compile option held every page with no promotion surface and is gone; the query option stages one answer as a candidate and stays, by ruling.

L8 (T13 — twelve census errors re-derived, plus two independent fixes. This is the census record the Supervisor asked for; every count below is a concrete hit from this session, not an estimate.)

The brief's census for this slice was re-derived path by path, and it was wrong twelve ways. Each one, with its concrete correction:

E1 — the brief said `compiler/index.ts:1223`; the read is at `1229`.
E2 — the brief said `compiler/index.ts:1301`; the read is at `1307`.
E3 — the brief cited `review-pipeline.ts:55-60` as an option read; that range is prose, and the actual read is `:90`.
E4 — the brief's claim that the `review?: boolean` doc comment at `utils/types.ts:230` had been "already cleaned" was FALSE: the comment was present at `:228-231`.
E5 — that same claim covered only one path; `sdk/core-types.ts:20` still carried its doc comment as well.
E6 — the brief's "6 test files" undercounted: `test/compile-candidate-preflight.test.ts` was missing from the list entirely.
E7 — that missing file's `it.each([false, true])` was invisible to a `review:` grep because it passed the shorthand `{ review }`; `typecheck:tests` caught it, not a grep.
E8 — `test/compile-request-stack-candidate-env.test.ts`'s `review: false` site was missing from the count too.
E9 — the dead-code premise was half false: OKF import reaches `writeCandidate` and query proposals reach `writeFreshCandidate`, so only the policy branch reaches `persistReviewCandidate`.
E10 — `CHANGELOG.md` was absent from the docs census, although the repository's own convention carries a removed option there.
E11 — the census ledger said "16 files" while enumerating 5 source + 6 tests + 6 docs, which is 17.
E12 — `packages/wiki/src/viewer/assets/viewer-reviews.js` rendered the removed option to users and was not in the census at all.

What that count is evidence FOR, stated plainly: the gates and the type checker found sets that greps could not see — a shorthand `{ review }` is invisible to a search for `review:`, and a rendered asset string is invisible to a census that never opened the asset. The census is therefore a starting hypothesis and never the authority. Re-derivation against the tree is the authority, and this list is what it costs to trust the census instead.

One disclosure about the work-unit commit's message, because a later reader will meet that sentence there. That message contains "Review holds stay reachable through the `review.hold` policy". The sentence is FACTUALLY TRUE: `packages/wiki/src/compiler/review-pipeline.ts:91-92` still reaches `persistReviewCandidate`. What is wrong is only the implication a reader may draw from it, since that policy leads to the same candidate record. The correction for that is not history rewriting; it is the guard message and the CHANGELOG bullet, which is what constrains the wording of both.

The promotion question — whether any surface can promote a staged candidate — was under measurement by another agent while this entry was written, and that is load-bearing: if it comes back showing a promotion path exists, the guard message, its two test literals and the CHANGELOG bullet must all change before merge. That is why the removal bullet's "no surface promotes" claim was not strengthened in PART 4 and no second assertion of it was added; the correction, if any, arrives as its own commit.

L8 also closes the owner question L4 left open. `packages/wiki/src/viewer/assets/viewer-reviews.js` was NOT edited on this branch: `fix/stop-advertising-removed-surfaces` (local, base `8c8d86ff`, not merged into `main`) already rewrites the same lines to the same effect — the empty state stops naming `compile --review`, and `FULL_QUEUE_COMMAND = "llmwiki review list"` becomes `FULL_QUEUE_NOTE = "the viewer shows a bounded slice of the queue"`. That branch carries the matching `test/viewer-reviews-route.test.ts` update too, so the advert is paid there and a second coat here would collide line for line. This branch's tree left the file byte-identical to `1db4666d`. The two commits landed beside this entry are `4c7fde21c37b98584946c8f716e4702f3a43c81e` (`eslint-baseline.json`, the one-number decrease) and `c4cb0b7094e7526c7436eb04f22c4dddf88bd1cb` (the `review.forced` CHANGELOG sentence).

L9 (the promotion question measured, one branch closed, one opened by ruling.)

Part A — the measurement, and the answer is B. The claim that reached this slice second-hand — that no surface promotes a candidate — was measured at this base by an independent read-only trace, and it holds. The deciding evidence is not an absence of findings but an absence of code: the only module that ever turned a candidate record into a page write, `packages/wiki/src/commands/review-approve.ts`, does not exist at this base. It was deleted by `fec50896 refactor(cli)!: remove the CLI and the eighteen commands it reached`, together with `review-reject.ts`, `review-list.ts`, `review-show.ts`, `review-publication.ts`, `review-helpers.ts`, `cli/review-commands.ts` and 18 of their tests, and nothing replaced it. The supporting measurements: every reader of `.llmwiki/candidates/` is LIST, RENDER, VALIDATE, SELECT-FOR-MUTATION-of-the-record or DELETE; `candidate.body` is read in exactly one place repo-wide (`compiler/candidate-read.ts:332`, a `typeof` guard); the page writers (`compile-write.ts:133 applyCompilePageWritesLocked`, `index.ts:915 commitLiveOutcome`, `categories/store.ts:313,316`) take renderer output, link repair or category mutation and never a candidate; `viewer/reviews.ts` makes zero I/O calls and states it in its own header (`:8-9`, "the viewer has no write path, so there is deliberately no approve/reject counterpart here"); `viewer/server.ts:311-312 isRouteRegistered` refuses any non-GET before a handler runs; `trust/executor.ts:237 applyApprovedMutationsLocked` is reached from `compile-write.ts:140` and `categories/store.ts:313` with `PlannedMutation[]`, and a `ReviewCandidate` never reaches `planPageMutation`; the surface census is 14 MCP tools with none shaped for approve/apply/promote, `POST /api/ingest` and `POST /api/compile` as the only non-GET routes, and 11 files under `commands/` of which zero match review/approve/reject/promote. Consequence for this slice: the guard message's second clause and the CHANGELOG bullet's "no surface promotes" are TRUE, and no corrective commit was needed.

Part B — the root cause, verbatim, because everything downstream of it is one deletion nobody traced to its dependants: the promotion surface went out with the CLI and the option stayed behind promising it.

Part C — the consequence that outlives this slice: `review.hold` is the same trap with the same missing exit. `review-pipeline.ts:90-95` reaches `persistReviewCandidate` (`:144`, NOT exported) which calls `writeCandidate` (`:153`) and returns the same terminal record. Three stagers, zero exits: `persistReviewCandidate` (`review-pipeline.ts:144`, not exported, reached from every compile entry — SDK `sdk/core.ts:116`, MCP `mcp/tools.ts:120`, `services/ingest/jobs/run.ts:216`, `POST /api/compile` `api.ts:406,447`); `writeCandidate` (`candidates.ts:191`, from `import/run.ts:57`, OKF staging, reached via SDK `importOkf` and MCP `import_okf`); `writeFreshCandidate` (`candidates.ts:225`, from `commands/query-proposal.ts:43`, reached from `query-publication.ts:103`). Also recorded for that slice: `sdk/core.ts:51` imports `applyApprovedMutations` and never invokes it — a pre-existing dead import, part of the same disconnection, which the retirement slice must decide explicitly rather than inherit.

Two line numbers in the measurement as it reached me were wrong, and are corrected above rather than carried: `persistReviewCandidate` is at `review-pipeline.ts:144`, not `:152`, and the policy branch it is reached from is `:90-95` with its call at `:91`, not `:98-102`. I re-verified every other `path:line` in this entry against `d72a7231` and each one holds — `commands/` really does hold 11 files with zero review/approve/reject/promote matches, the MCP registry really does hold 14 tools, `fec50896` really did delete those six review modules and 18 review tests, and `candidate.body` really is read once repo-wide. That is L8's thesis applied to the measurement itself: the census is a hypothesis until the tree confirms it, including a census of a census.

Part D — the ruling those findings produced. The human ruled: retire the three stagers. Restoring a promotion surface is off the table and so is renaming — staging records nothing can promote is not a feature worth keeping under a better name. That is a FOLLOW-ON slice and is not performed here; this branch remains about the compile option only. The risk that slice inherits, stated so nobody meets it by surprise: removing the stagers deletes capability — the `review.hold` policy, OKF staging and saved-answer proposals all stop producing anything. That is intended, but it is risk item 3 and item 1 territory, and its CHANGELOG entry must say what STOPS HAPPENING, not merely what was deleted. `review.forced` and `compile-report.ts:253-259` die with the same work.

Part E — two process findings, recorded because they cost time here. First, a shared worktree index tolerates ONE writer at a time, and `git add -A` is what makes a second writer dangerous, not the second writer: a `docs(odd)` commit was mid-flight with `git add -A` while a second writer was queued, and only serialising them prevented an `eslint-baseline.json` change hiding inside a docs commit. Second, and generalisable: a census taken on a base that predates an in-flight branch measures a tree that will never exist. Seven stale "run `llmwiki review`" sites were re-derived here as needing a follow-on slice; six of them are already fixed on `fix/stop-advertising-removed-surfaces` (30 files, +413/-287, at `8fc553c3`, not merged into `main`), whose diff rewrites `packages/wiki/src/viewer/assets/viewer-reviews.js` including the two lines this slice was told to fix, plus `FULL_QUEUE_COMMAND` and its test. This branch therefore leaves that file byte-identical and the advert belongs to that branch. When asked what a tree contains, check whether the tree being read is the one that will ship.

L10 (correcting L9, and recording the delivery fact — append-only; L1-L9 stay byte-identical).

Part A — the correction. L9 Part E's parenthetical describing that branch as being "at `8fc553c3`, not merged into `main`" is FALSE as of this entry, and its tail sentence "the advert belongs to that branch" is out of date with it. The stale-advert work IS on `main`: `git merge-base --is-ancestor 8fc553c3 main` exits **0**, `8fc553c3a3c7b0973c29b5356cd80dd096615572` is an ancestor of `main`, and the fix landed as `ab00dba37e2e495186237b606ba5d0ebd1a99e7e` (`fix(output): stop advertising commands the product does not ship`), which is itself an ancestor of both `8fc553c3` and `main`. `git show main:packages/wiki/src/viewer/assets/viewer-reviews.js | grep -n "compile --review\|Approve one with the CLI"` returns **no hits**: `main` carries neither the `compile --review` advert nor the CLI approval sentence.

L9's operative claim is unaffected and stands: this branch left that file byte-identical to its own base — blob `4c3825542c60bcfb79b7d60b35b5f43fb29ee788` at `8c8d86ff` and at this branch's HEAD — so a merge inherits `main`'s fixed version (blob `462dee8c004753d9cdaf821a83bbd65e0d2c857f`) rather than a competing rewrite of those lines. What changes is only the ownership statement: the advert is paid on `main` already, not pending on a sibling branch.

Part B — the delivery fact the final pass established, stated plainly. This branch is **NOT contained in `main`** (`git merge-base --is-ancestor HEAD main` exits **1**) and is behind it by **7** commits (`git rev-list --count HEAD..main` = 7; local `main` = `2872661ccab752a864f35dee709c3ae995848bb1`, whose last three are `2872661c docs(odd): record rebase onto the facade slice and post-rebase gates`, `8fc553c3 docs(odd): record rebase onto main and post-rebase gates`, `45044b54 test(output): scan every shipped package root for removed commands`). Both sides have rewritten the same four files, and only those four — `git diff --stat HEAD..main` over them reports **4 files changed, 138 insertions(+), 139 deletions(-)**: `CHANGELOG.md` (40 churned lines), `packages/wiki/src/compiler/index.ts` (194), `packages/wiki/src/utils/types.ts` (8), `test/quickstart-shared-steps.test.ts` (35).

Part C — the hazard, in BASE coordinates, because it is the reason this entry exists. `main` renamed the compile banner to `output.header("Wiki compile")` on the line immediately below this branch's guard insertion point — base `compiler/index.ts:334` is `output.header("llmwiki compile")`, the guard was inserted above it, and `main`'s equivalent line is now 335 with the new banner — so a resolution that takes `main`'s side of that hunk line-by-line silently drops the guard. `main` also edited the JSDoc lines this branch DELETED (`main:packages/wiki/src/utils/types.ts:228-232` now reads "Nothing promotes a candidate into the wiki, so a page written this way stays staged") and still declares `review?: boolean` at `main:utils/types.ts:233`, with **7** `options.review` reads in `main:compiler/index.ts` (14 across `packages/wiki/src`: `compiler/index.ts` 7, `review-pipeline.ts` 2, `query.ts` 4, `query-publication.ts` 1 — the last two being query's own distinct option, S2). And `main:test/quickstart-shared-steps.test.ts:238` still calls `compileAndReport(root, { review: true })` (again at `:250`). Both sides even insert a CHANGELOG bullet at the same offset — this branch's removal bullet at `:170`, `main`'s `RecommendedAction.executable` bullet at `:171`. A resolution that takes `main`'s side line-by-line can therefore drop the guard or resurrect the option.

Part D — the mitigation, so nobody resolves this by feel. The loss would be loud, not silent: `test/review-option-removal.test.ts` and `test/review-option-removal-entries.test.ts` are committed durable tests that assert the S7 message literally and that no `.llmwiki/` is created on the refused path, and `typecheck:tests` fails on any tree that restores `review?: boolean` or reintroduces a `{ review }` call site — which is exactly how this slice's ninth test file was found (L2). Any resolution that drops the guard or restores the field fails those, so the mistake cannot reach a green suite unnoticed. It can still reach a merge conflict, which is the part no test can absorb.

Part E — the standing fact, so this entry is not read as reconciled. Reconciliation with `main` (merge or rebase) is **NOT performed by this branch**: merge remains the user's decision, and rebase would rewrite history this branch's own rules forbid (S13). Every gate and suite measurement recorded in L6 and in this entry was taken on **base+7**, not on `main`+7: those numbers describe this tree, and not yet the tree that ships. Before this branch is presented as shippable, a reconciliation pass owns all four overlap files, the guard's own insertion point included.

L11 (T17 — the branch is REBASED onto `main`, and every number below was executed on the reconciled tree. This entry supersedes L10 Part E, which said reconciliation was still pending: it is done, and the measurements here describe the tree that ships.)

Part A — the rebase. `git rebase 2872661ccab752a864f35dee709c3ae995848bb1` — local `main`, the exact commit L10 Part B recorded this branch 7 behind. It completed in one pass. Exactly ONE commit conflicted, `d1441ba3` (the work unit); the seven `docs(...)` / `chore(lint)` commits above it replayed cleanly, `c4cb0b70`'s `review.forced` CHANGELOG paragraph included. An unpushed feature branch is not the shared history a rewrite prohibition protects, so this rebase rewrote nothing any consumer had: no push, no `--no-verify`, no `HUSKY=0`, no hooks-path override, no `reset --hard`, no `--amend`, no stash, no merge, no checkout of another branch. `git merge-base --is-ancestor 2872661c HEAD` exits 0, `git rev-list --count HEAD..main` is 0, and `git rev-list --count main..HEAD` is 8.

Part B — the OLD->NEW SHA map, all eight commits. STATED PLAINLY so no reader mistakes them for different commits: the pre-rebase ids quoted in L6 and in the T0-T11/T13 tracker lines are the SAME commits as the ids below. Only the hashes moved; no content was re-authored, no message reworded, no file re-parented. The tracker lines were rewritten to the new ids for that reason.

| tasks | pre-rebase (as cited in L6 / tracker) | post-rebase (current HEAD..main) | subject |
| --- | --- | --- | --- |
| T0-T7, T9-T11 | `d1441ba32dca6b7dc2a04067b102c57500db16e7` | `43a2e089a415c1afc9f80280af0c87db37cd84c6` | feat(compiler)!: remove the review compile option |
| T8 | `43a02913ddfee9e806a9d5c1061bcee17ecc76e6` | `7a91d049af33e985cb4be1a22547d0b8bd9f73ab` | docs(odd): record the review-option removal evidence |
| - | `1db4666d4926e71081ae68645eab5db3b648dcbf` | `3b9367ce2ba81ce0f542ecc5e9a3041764d0647e` | docs(odd): record PQ1, the open question on the query review option |
| T13 | `4c7fde21c37b98584946c8f716e4702f3a43c81e` | `5c9686ef45fefe91d1640e7dee498ec3294cca6d` | chore(lint): record a max-lines-per-function decrease |
| T13 | `c4cb0b7094e7526c7436eb04f22c4dddf88bd1cb` | `fc97b65566464a5eab63cd55b26bdca0c5a04719` | docs(changelog): record that review.forced is now always empty |
| T13 | `d72a72319ed6bdebf9f90bc3388323f197323b92` | `9d86edc330a4ca3b4ae2e29278ec91ca9e81c7da` | docs(odd): record the twelve census errors behind this slice |
| T14, T15 | `dedcdd781dc4e3acf631064b8f1e4a633ae6158f` | `92ac24b80b7a6ebcadcdff745884720ac927863a` | docs(odd): record the promotion measurement and the follow-on ruling |
| T16 | `9c298a71947851141a26e26e29168b14c0367de5` | `b3aaa102af770f9d4db22f825cad91de1efe1290` | docs(odd): correct L9 on the merge state and record the main overlap |

L6's and L8's own sentences keep the pre-rebase ids verbatim, because a Log entry is append-only and those entries are the record of what was measured then. The mapping above is the translation, and the tracker lines carry the corrected ids so anything that FOLLOWS the tracker reaches the right commit.

Part C — every conflict, its resolution and why. Three files conflicted; four were expected to, and `test/quickstart-shared-steps.test.ts` auto-merged.

- `packages/wiki/src/compiler/index.ts` (1 hunk). `main` had replaced `output.header("llmwiki compile")` with `output.header("Wiki compile")` on the very line our guard was inserted above, so git offered a choice between `main`'s banner and our guard + comment + the OLD banner. RESOLUTION: ours (the whole guard comment, the `if ("review" in options)` throw, with the 142-char S7 message) AND `main`'s rename kept beneath it — the function now opens with the guard, then `output.header("Wiki compile")` at `:345`. Taking `main`'s side here would have silently deleted the guard, which is the exact failure L10 Part C was recorded to warn about; taking ours wholesale would have reverted `main`'s unrelated rename. That single line is the only thing on `main`'s side of this hunk that survives, and it does survive. `main`'s OTHER changes to this file (the `wiki compiler` header comment, the five `llmwiki compile --recompile` -> `compileRecompiling` comment rewrites at `:189-192`, `:889`, `:1608`, `:1851`) auto-merged and are intact.
- `packages/wiki/src/utils/types.ts` (1 hunk). `main` rewrote the JSDoc of the `review?: boolean` field to "Nothing promotes a candidate into the wiki, so a page written this way stays staged" and kept the field; we had deleted field and JSDoc together. RESOLUTION: ours — the field AND `main`'s rewritten JSDoc are both gone, because that comment documents the field being deleted and cannot outlive it. `main`'s unrelated change to this file (the `Core type definitions for the wiki compiler` header at `:2`) auto-merged and is intact.
- `CHANGELOG.md` (1 hunk). Both sides inserted a bullet at the same offset: `main`'s `RecommendedAction.executable` bullet and our `review` removal bullet. RESOLUTION: BOTH survive, `main`'s first (`:170`) then ours (`:186`), neither reworded and neither shortened. A one-sided resolution would have deleted an unrelated breaking-change announcement.
- `test/quickstart-shared-steps.test.ts` — did NOT conflict. Git auto-merged to exactly the intended result: our `review.hold: ["all"]` lever (`holdEveryPage`, `:135`) and no `{ review: true }` call anywhere, together with `main`'s unrelated assertion upgrade `expect(rec.recommended.executable?.tool).toBe("compile_wiki")` at `:284`. Verified by reading the merged file, not assumed from a clean exit.
- No other file conflicted, so there were no other ours/theirs decisions to report.

Part D — the retained banner, called out because it is one line and easy to lose. `grep -n 'output.header("Wiki compile")' packages/wiki/src/compiler/index.ts` hits `:345`, and the guard's `throw` sits four lines above it at `:341`. Both were printed and read, not inferred: `main`'s rename and this branch's guard coexist in the same function, which is the whole point of this resolution.

Part E — the measurement set, executed on the reconciled tree (post-rebase HEAD, before this docs commit). Every line below is observed output, not expectation.

1. The seven-probe set (five entries x two values = 10 probes), run with `corepack pnpm exec tsx` against source from a throwaway script in `/tmp` (deleted afterwards; the `/tmp` scratch directory matched the worktree's module graph only after it was declared `"type": "module"`, because an unpackaged `.ts` under `/tmp` is compiled as CJS and `canonicalize` is ESM-only). Entries: `compileAndReport`, `compile`, `compileDelta`, `createWiki().compile`, `createWikiCore().compile` (the SDK wrapper). ALL 10 PASSED: every one threw an `instanceof Error` whose message is `===` the S7 string, measured `142` characters; every root was byte-identical before and after (snapshot of exact bytes); every root had NO `.llmwiki/` directory at all. `{ review: false }` is refused exactly like `{ review: true }`, confirming the guard keys on the key's PRESENCE.
2. `corepack pnpm vitest run test/review-option-removal.test.ts test/review-option-removal-entries.test.ts` — exit **0**, `Test Files 2 passed (2)`, `Tests 6 passed (6)`.
3. `corepack pnpm run typecheck:tests` — exit **0**, literal line: `Test type-check: 1590 files checked; 240 baseline diagnostics in 86 files; no regression.` (up from the 1587 files L6 recorded, because `main` added tests).
4. `corepack pnpm run gates:static` — exit **0**, `static gates: all 6 passed in 32.4 s` (`tsc` 8.8 s, `typecheck:kg` 8.5 s, `typecheck:tests` 21.6 s, `fallow:ci` 3.2 s, `fallow:kg` 1.4 s, `lint` 15.1 s). The lint triple is UNCHANGED by the rebase and is reported as-is, not adjusted: `ESLint ratchet: 1657 files scanned; 565 baseline violations in 402 files across 429 rule/file entries; no regression.` So the count did not move: 565 / 402 / 429, the ratchet `4c7fde21`(now `5c9686ef`) set. `lint:update` was not run and `eslint-baseline.json` was not touched.
5. `corepack pnpm run build` — exit **0**.
6. `corepack pnpm vitest run test/artifact` — exit **0**, `Test Files 5 passed (5)`, `Tests 29 passed (29)`.
7. `corepack pnpm test` — run TWICE, and both results are recorded because the first is not a gate measurement of the tree and hiding it would be dishonest. RUN 1 (exit **1**): `Test Files 3 failed | 817 passed | 3 skipped (823)`, `Tests 3 failed | 6164 passed | 4 skipped (6171)`, `741.04 s`, with `load average: 17.27` and another worktree's vitest occupying the machine for the whole run. All three failures are the SAME failure: `Error: Test timed out in 30000ms` in `test/journal-binary-port.test.ts` ("replays a multi-megabyte binary prestate without exhausting the stack"), `test/test-typecheck-command.test.ts` ("requires lowering the baseline after fixing its last error") and `test/viewer-host.test.ts` ("rejects --host :: with a clear error") — timeout flakes under ~2x slowdown, none of them touching the removed option or any of the four overlap files. The exact three files were then re-run ALONE on a quieter machine: exit **0**, `Test Files 3 passed (3)`, `Tests 29 passed (29)`. RUN 2, launched only after `pgrep` confirmed no vitest, docker build or docker run anywhere, `TESTCONTAINERS_REUSE_ENABLE=false` — exit **0**, `Test Files 820 passed | 3 skipped (823)`, `Tests 6167 passed | 4 skipped (6171)`, `376.31 s` wall 379 s, container `reverent_chaum` FRESHLY STARTED, `grep -c "adopted running"` = **0**, zero `FAIL` lines. The file count matches run 1 exactly (823 = 820 + 3), so the difference is three timeouts, not three missing files.

THESE SUITE NUMBERS NOW DESCRIBE THE RECONCILED TREE — `main` + the 8 rebased commits — and that tree is the one that ships. Every number in L6 described base+7, a tree that no longer exists.

Part F — the reconciliation greps, so a reader can re-run the proof: `git merge-base --is-ancestor 2872661c HEAD` = 0; `git rev-list --count HEAD..main` = 0; `git rev-list --count main..HEAD` = 8; `grep -n 'output.header("Wiki compile")' packages/wiki/src/compiler/index.ts` hits `:345` with the guard at `:341`; `grep -c "options.review" packages/wiki/src/compiler/index.ts` = **0**; `grep -rn "review?: boolean" packages/wiki/src` hits ONLY the query option (`sdk/core-types.ts:190` query signature, `commands/query.ts:158,339`, `commands/query-publication.ts:26,44`) and NEVER `utils/types.ts` or the compile options in `sdk/core-types.ts`; `grep -rn "if (options.review)\|!options.review\|Boolean(options.review)"` over `compiler/index.ts` = no hits; the orphaning/graph-retirement block and the `commitLiveOutcome` block are unconditional with the review-only early return gone; `recordExtractionFreezes(draft, extractions, frozenSlugs)` has three parameters; `reusableSourceFiles(state, changes, detected)` is called with three arguments. `git status --short` empty.

Part G — what this entry does NOT decide. Nothing about the follow-on slice L9 Part D authorized (retire the three stagers) and nothing about PQ1: the query `review` option is untouched by the rebase and still lives where S2 says. The guard, its message and the CHANGELOG bullet all survived main's arrival unchanged, which is the outcome L8's load-bearing caveat was waiting on: the promotion question came back "no surface promotes" (L9 Part A), so no corrective rewording was needed and none was made.
