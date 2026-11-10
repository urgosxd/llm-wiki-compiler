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

T0 | S12 | worker | done (d1441ba32dca6b7dc2a04067b102c57500db16e7) — This feature document and its Engram mirror (no source changed).
T1 | S1, S3, S4 | worker | done (d1441ba32dca6b7dc2a04067b102c57500db16e7) — Delete the `review` field from `CompileOptions` and `SdkCompileOptions` with its JSDoc, and every read at the measured sites.
T2 | S5, S6, S7 | worker | done (d1441ba32dca6b7dc2a04067b102c57500db16e7) — Test-first runtime guard at first use on `compileAndReport`, rejecting the presence of the key.
T3 | S9, S10 | worker | done (d1441ba32dca6b7dc2a04067b102c57500db16e7) — Dead-code re-derivation recorded with a verdict; `manual-review-requested` kept with its reason; out-of-scope files untouched.
T4 | S11 | worker | done (d1441ba32dca6b7dc2a04067b102c57500db16e7) — The seven documentation sites; query's own option docs untouched.
T5 | S2, S8 | worker | done (d1441ba32dca6b7dc2a04067b102c57500db16e7) — Query's distinct `review` option and the trust machinery verified untouched.
T6 | S12, S13 | verify | done (d1441ba32dca6b7dc2a04067b102c57500db16e7) — Independent verification: executed proof of the guard, `vitest run test/artifact`, the full suite's literal exit code.
T7 | S12, S13 | worker | done (d1441ba32dca6b7dc2a04067b102c57500db16e7) — One work-unit commit on the feature branch, no hook bypass.
T8 | S14, S15 | — | recorded (43a02913) — The query `review` option recorded as NAMED OPEN PRODUCT QUESTION PQ1 (human ruled: the option stays; not a defect this slice declined), plus the false "already cleaned" doc-comment claim recorded for the Supervisor with both paths. No code, no decision taken, no writer.
T9 | S5, S6, S7 | worker | done (d1441ba32dca6b7dc2a04067b102c57500db16e7) — Durable entry coverage committed: `test/review-option-removal.test.ts` and `test/review-option-removal-entries.test.ts`, each asserting the S7 message literally and that no `.llmwiki/` is created for the refused path.
T10 | S11 | worker | done (d1441ba32dca6b7dc2a04067b102c57500db16e7) — `CHANGELOG.md` Unreleased/Changed entry for the removal and the throwing guard it leaves behind.
T11 | S12, S13 | verify | done (d1441ba32dca6b7dc2a04067b102c57500db16e7) — Final independent verification pass over the committed tree: full suite, every static gate, executed guard proof, docs census. Measurements in L6.
T12 | S14 | — | done — PQ1 recorded as an open product question in L7 with the ruling that keeps the query option.
T13 | S12, S13 | worker | done (4c7fde21 + c4cb0b70 + this docs(odd) commit) — Authorised lint-decrease rebaseline (`eslint-baseline.json`, one number, ratchet now 565), the `review.forced` CHANGELOG sentence, and the twelve-item census-error record in L8. The viewer advert was NOT edited here: `fix/stop-advertising-removed-surfaces` already rewrites the same lines to the same effect.
T14 | S5, S6, S9, S14 | verify | done — The promotion question measured (verdict B, absence proof in L9 Part A); guard message and CHANGELOG confirmed TRUE; the three stagers and the ruling to retire them recorded for the follow-on slice.

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
