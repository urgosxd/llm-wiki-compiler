# retire-candidate-stagers

Branch `fix/retire-candidate-stagers`, base `main` at `2872661ccab752a864f35dee709c3ae995848bb1`.

This slice retires three candidate stagers and what exists only to feed or read them; every code, test, docs and commit artifact in it is English.

## Specs

### S1 — Retirement, not softening

> "The human's ruling is explicit: **retire them, nothing of this is needed.** Staging records that no surface can promote is not a feature, and renaming it to sound nicer was rejected too."

### S2 — What must go

Remove the three stagers and what exists only to feed or read them, including the `review.hold` policy path, OKF candidate staging, saved-answer proposals, and the candidate record type/store as far as removal is clean.

The three stagers, as measured on this base:

- `persistReviewCandidate` — `packages/wiki/src/compiler/review-pipeline.ts:152`, NOT exported.
- `writeCandidate` — `packages/wiki/src/compiler/candidates.ts:192`, exported.
- `writeFreshCandidate` — `packages/wiki/src/compiler/candidates.ts:226`, exported.

The assignment located two of them by caller (`import/run.ts:57`, `commands/query-proposal.ts:43`) rather than by definition, and the re-derivation corrected this: those two `:line` figures are call sites, not definitions. The definition sites above are the ones removal targets.

### S3 — The dead import

`sdk/core.ts:51` imports `applyApprovedMutations` and never invokes it.

> "Decide it explicitly: remove it, or say why it stays. Do not inherit it."

### S4 — The query option

> "**`query ({ save, review })` is now orphaned and I am ruling it gone with its stager.** The human kept that option two slices ago on the premise that `writeFreshCandidate` survived; retiring the stager removes that premise, and an option whose implementation does not exist is the same lie in a different file. Remove it and its `"Query review requires save."` guard, or — if removal turns out to be entangled — make it refuse loudly and report. Say which you did and why."

### S5 — Candidates already on disk

> "Real repositories may hold `.llmwiki/candidates/*.json` and records carrying `manual-review-requested`. Decide and state: do existing files become ignored, or is there a read-only compatibility path? **Neither answer is wrong, but silence is** — a user whose staged records quietly stop being readable must find out from the CHANGELOG, not from an empty directory."

### S6 — Risk

> "**Item 3**: the `query` option and the candidate/result types are package surfaces; untyped callers fail silently while TS callers fail loudly. **Item 1**: stored candidate records are **data that stops being consumed**. Nothing is destroyed, but a directory of records becoming inert is a data-lifecycle change and it must be described in those terms. **Item 6**: any behaviour whose only test was the staging test you delete."

### S7 — CHANGELOG

> "The CHANGELOG entry must say **what stops happening** — holds no longer staged, OKF imports no longer produce candidates, query proposals gone, existing candidate files no longer read — not merely what was deleted. An entry that lists deletions without consequences is how a breaking change gets discovered by a user instead of by a reader."

### S8 — Scope stop

> "**Stop and report if the real set exceeds ~25 files.** This one is genuinely larger than the recent slices; that is acceptable given it retires a subsystem, but it must not become a refactor."

### S9 — Gates

> "`gates:static` · `tsc --noEmit` · `typecheck:tests` · `typecheck:kg` · `lint` (**zero headroom**: literal `566 baseline violations in 402 files across 429 rule/file entries`; **`lint:update` is forbidden except for a decrease-only rebaseline**, which then requires the new literal triple reported and the `eslint-baseline.json` diff shown verbatim) · `fallow:ci` · `fallow:kg` · `build` · **`vitest run test/artifact`** (`package.json` has no `test:artifact` script) · **`pnpm test` alone, capturing its literal exit code** with `set -o pipefail` or `PIPESTATUS` — never a bare `| tee`."

### S10 — Prohibitions

> "No history rewriting (no `git reset`, `git restore --staged`, `--amend`). **No hook bypass of any kind** — plain `git status` never runs hooks, so a hooks-path override has no legitimate use here. **No `cp -a` of this worktree** (`.git` is a pointer file; a copy is a second handle on the same gitdir). No push, no `--no-verify`, no `HUSKY=0`. `odd/tasks/**` append-only except the tracker line."

### S11 — Environment

Node 24 ONLY: every command is prefixed `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`, and the pre-commit hook refuses a wrong major. pnpm; a bare `pnpm` returning 127 means use `corepack pnpm`. `maxWorkers` 4. Database: freshly provisioned, `TESTCONTAINERS_REUSE_ENABLE=false`.

### S12 — Report

The re-derived list of what went and what stayed; the `query` option decision and its reason; the surviving-disk-records decision; whether the candidate type/store removal was clean or entangled; the explicit verdict on `sdk/core.ts:51`; the CHANGELOG's "what stops happening" sentences; every gate exit with the literal suite exit code and the lint triple; commit SHAs as full 40 characters; `git status --short`; and a `Risk:` line arguing items 1, 3 and 6 individually.

## Tasks

T0 | S9, S10 | worker | done — This feature document. No source changed.

T1 | S2, S3, S6 | — | resolved — SCOPE CHECKPOINT CLOSED by the supervisor (L4). Slice A (this branch) was authorised to proceed immediately. Slice B is BLOCKED ON A NAMED PREREQUISITE, not merely unstarted: branch `fix/remove-review-option` must land first, and Slice B rebases onto it, because this base still declares the compile option's `review` field and deleting the stager without it would leave `review: true` a silent no-op (S6 item 3). The measured set's ~30-35-file floor corrects S8's ~25 bound; the retired scope is the stagers and what only feeds or reads them, not the candidate data model.

T2 | S4 | worker | done — Remove the query `review` option, its JSDoc, its reads and its `"Query review requires save."` guard, together with `stageQueryProposal` and `writeFreshCandidate`. Held by `e313207e1efb8d317a7c2f313bfc8616a2cea23c` (post-rebase).

T3 | S3 | worker | done — Remove the dead `applyApprovedMutations` import at `packages/wiki/src/sdk/core.ts:51`. Held by `e313207e1efb8d317a7c2f313bfc8616a2cea23c` (post-rebase), the same commit as T2.

T4 | S5, S7 | worker | done — `CHANGELOG.md` entry stating what stops happening. The entry lands in `e313207e1efb8d317a7c2f313bfc8616a2cea23c`; its correction to the false TypeScript-caller claim, and the retirement of `QueryResult.candidateId` that the entry describes, land in `30a37ab32169e3ef8ed35cf3a17e2e2afa6b534a`.

T5 | S9 | verify | done — Independent verification of T2-T4, with the verdict, the four defects it found and their fixes recorded in L7. A verification is not a commit, so no SHA *is* T5; what it verified is the tree at `198b020c23a1c9fbfc32ed2bbad63f027cb78065`, which contains `e313207e1efb8d317a7c2f313bfc8616a2cea23c`, `30a37ab32169e3ef8ed35cf3a17e2e2afa6b534a`, `ff33e11c5c897f1f1e3f631d26b026dfa2721a6b` and `198b020c23a1c9fbfc32ed2bbad63f027cb78065`.

T6 | S2, S8 | — | recorded — The `persistReviewCandidate` / `writeCandidate` / OKF-staging / `review.hold` retirement (Slice B), parked and blocked on branch `fix/remove-review-option` landing, then rebasing onto it before any work starts.

## Log

### L1

Project assignment for branch fix/retire-candidate-stagers: Retire the three candidate stagers and the candidate data model. The human's ruling is explicit: **retire them, nothing of this is needed.** Staging records that no surface can promote is not a feature, and renaming it to sound nicer was rejected too.

The full assignment is quoted across S1-S12 above; this entry is its opening statement verbatim.

### L2

The re-derived census, as measured on this base:

- `persistReviewCandidate` — definition `packages/wiki/src/compiler/review-pipeline.ts:152`, not exported. Two call sites: `:92` (the `options.review` forced mode branch) and `:99` (the policy branch), both inside `generateMergedPage` (`:70`). The assignment said `:152` "not exported" and this holds; the two-caller fact is the load-bearing one.
- `writeCandidate` — definition `packages/wiki/src/compiler/candidates.ts:192`, exported. Callers: `packages/wiki/src/import/run.ts:57` (OKF `stageAll`) and `packages/wiki/src/compiler/review-pipeline.ts:162` (inside `persistReviewCandidate`). So it is chained behind the same removal, not independent of it.
- `writeFreshCandidate` — definition `packages/wiki/src/compiler/candidates.ts:226`, exported. Single caller `packages/wiki/src/commands/query-proposal.ts:43` inside `stageQueryProposal` (`:36`).
- `review.hold` policy path — `packages/wiki/src/review/config.ts:64` (`normalizeHoldModes`), `:73` (`readMode`), `packages/wiki/src/review/policy.ts:70` (`evaluatePolicy`), `packages/wiki/src/compiler/review-pipeline.ts:87-88` (`buildPolicySignals`, then `evaluatePolicy`).
- OKF staging — `packages/wiki/src/import/run.ts:55` (`stageAll`), call at `:57`.
- Saved-answer proposals — `packages/wiki/src/commands/query-proposal.ts:36` (`stageQueryProposal`), call at `:43`.
- Candidate store is a cluster, not a file: `packages/wiki/src/compiler/candidates.ts`, `candidate-read.ts`, `candidate-selection.ts`, `candidate-sanitize.ts`, plus `candidate-custody.ts`, `candidate-custody-snapshot.ts`, `candidate-custody-limits.ts`, `candidate-paths.ts`, `candidate-publication.ts`, `candidate-store-paths.ts`, and `packages/wiki/src/utils/candidate-store.ts`; the directory constants are `packages/wiki/src/utils/constants.ts:652` (`CANDIDATES_DIR`) and `:655` (`CANDIDATES_ARCHIVE_DIR`).
- The claim that no surface promotes a candidate re-derived as TRUE: `candidate.body` is read in exactly one place, a `typeof` guard at `packages/wiki/src/compiler/candidate-read.ts:332`; every reader is list/render/validate/select/delete; `packages/wiki/src/viewer/reviews.ts` makes zero I/O calls and says so in its header; the three page-write paths (`commands/query-save.ts:41`, `compiler/rule-candidates.ts:326`, `compiler/obsidian.ts`) take rendered content, never a candidate.
- The query `review` option is SDK-only: the MCP `query_wiki` input schema at `packages/wiki/src/mcp/wiki-read-tools.ts:81-91` declares `question`, `save`, `debug`, `stackId` and no `review`, and `test/query-publication-sdk-mcp.test.ts:177` asserts `.not.toHaveProperty("review")`. The declaration and reads are `packages/wiki/src/commands/query.ts:47` (JSDoc + field, whose own JSDoc names `review approve`, a command that does not exist), `:63` (`scopedOrReview`), `:355` (plumbing), `packages/wiki/src/commands/query-publication.ts:19-20` (field) and `:44-46` (`assertQuerySaveOptions`, message at `:45`), asserted by `test/query-publication-sdk-mcp.test.ts:112-114`.
- A SECOND candidate store exists over Postgres: `packages/wiki/src/dimensions/wiki/candidate-store.ts` over the `wiki.review_candidates` table defined in `packages/wiki/src/dimensions/wiki/migration_wiki_candidates.sql`, mapping 1:1 onto `ReviewCandidate` (`packages/wiki/src/utils/types.ts:330`) and covered by `test/dimensions/candidate-store.test.ts:18-20`. Dropping that table would destroy data, which S5 does not authorise.
- CHANGELOG structure for the entry: `## [Unreleased]` at `CHANGELOG.md:7`, `### Changed` at `:9`, `### Added` at `:226`, `### Fixed` at `:460`; existing breaking entries use a `- **BREAKING — ...**` bold lead paragraph.
- Documentation surface measured: `README.md:81,159,235`; `docs/configuration/review-policy.mdx:7,29,64`; `docs/configuration/schema.mdx:101`; `docs/configuration/environment-variables.mdx:19`; `docs/concepts/how-it-works.mdx:97,101`; `docs/concepts/wiki-model.mdx:22,56,62`; `docs/concepts/page-types.mdx:62,85,89,107`; `docs/introduction.mdx:53`; `docs/troubleshooting/stale-pages.mdx:69`; `docs/guides/mcp-agent-integration.mdx:118,170`; `docs/guides/sdk.mdx:178-186` (the query options table, which lists `save`, `review`, `debug`).

### L3

The checkpoint. The measured set for retiring all three stagers in one slice exceeds S8's ~25-file bound: the source side alone is nine modules plus a Postgres-backed second store, the docs side is twelve files, and the test side is at least six staging-focused files before any incidental ones. Two rulings are needed before source work: the file-set split, and sequencing behind `fix/remove-review-option`, whose seven unmerged commits off `8c8d86ff` already delete the `options.review` forced branch that is one of `persistReviewCandidate`'s two callers. No source has been changed while the checkpoint is open.

T0 done — this document created, no source changed.

### L4

The supervisor's ruling on the checkpoint (L3). All four of the slicing decisions recorded in the escalation were approved, and sequencing is ruled **(a)**: Slice B — the `persistReviewCandidate` / `writeCandidate` / OKF-staging / `review.hold` retirement — lands AFTER branch `fix/remove-review-option`, rebasing onto it, so the compile option's field is already gone when the stager deletion arrives. The two rejected alternatives carry their reasons in the record: **(b)** would duplicate a peer's work and guarantee a conflict; **(c)** would ship a `review: true` that silently no-ops, which is the precise lie this whole chain exists to kill.

Slice A was authorised to proceed immediately.

The supervisor corrected two of its own bounds in the same ruling. The ~25-file bound was too small — the measured floor is ~30-35 files — and the assignment's phrase "and the candidate data model" was wrong. The transferable distinction, recorded verbatim as the supervisor stated it: **"No surface promotes a candidate" is not "nothing reads a candidate"** — an absence proof about promotion says nothing about usage, and conflating the two would have turned a retirement into a refactor that S8 forbids.

Disk records: read-only compatibility confirmed for the candidate files already on disk, and `wiki.review_candidates` must NOT be dropped — dropping a table destroys data, which S5 never authorised. The supervisor's wording: rows go **inert, not away**, and the CHANGELOG says so in exactly those words.

`packages/wiki/src/sdk/core.ts:51`: removal approved. Live callers of `applyApprovedMutations` are `packages/wiki/src/categories/store.ts:313,316` and `packages/wiki/src/compiler/compile-write.ts:140`; none of them is the SDK — that import has no invocation anywhere in `sdk/`.

Query option: removal approved, and the strongest reason is that the option's own JSDoc says the operator "applies it via `review approve`", a command that does not exist — the option documents an impossible workflow in its own type. This reason goes in the commit body.

Two additions were folded into Slice A: `docs/guides/sdk.mdx:178-186` travels with it, since that table documents the option being removed, and the documented return shape needs checking — an option removed from the input but still promised in the output is the same defect one level down.

Line figures measured on this base (`2872661`) while recording this entry, because four of the figures quoted with the ruling do not land where stated — the ruled substance is unaffected, the locators are corrected so the worker does not edit the wrong line:

- The query option's JSDoc and field are at `packages/wiki/src/commands/query.ts:153-157` and `:158`, not `:47`; `:47` is the `loadSelectedPages` doc comment. The quoted wording ("applies it via `review approve`, which re-validates citations freshly") is exactly there, so the ruling's strongest reason holds as written.
- The option's reads are `:199` (`scopedOrReview`), `:236`, `:248` and `:356`, not `:63` and `:355`, plus `packages/wiki/src/sdk/core-types.ts:20-21` and `:192`.
- Of the three executor call sites, `categories/store.ts:313` and `compiler/compile-write.ts:140` are the lock-free `applyApprovedMutationsLocked`; the self-locking `applyApprovedMutations` live call is `categories/store.ts:316`. No SDK call site exists either way.
- `docs/guides/sdk.mdx:178-186` is the review-candidate prose paragraph at `:178` plus the `wiki.search` `ParamField` at `:182-186`. The lines that actually document the `query` option are `:140` (behavior and the `review`-without-`save` refusal), `:163` and `:165` (publication and refusal shape) and `:168` (the `{ save: true, review: true }` example). The return-shape check is confirmed live one level down: `packages/wiki/src/sdk/core-types.ts:192` still declares `query(question: string, opts?: { save?: boolean; review?: boolean; limit?: number })`, and `:20-21` still declares `review?: boolean` on `SdkCompileOptions` — the field Slice B depends on `fix/remove-review-option` having already removed.

### L5

Two census corrections received after L2 was written. L2 stays as written; this entry corrects it.

- A peer measured `main` directly and confirmed that `main` @ `2872661` still declares `review?: boolean` in `packages/wiki/src/utils/types.ts` and still has the `options.review` reads, and that `test/quickstart-shared-steps.test.ts:238` on this base still calls `compileAndReport(root, { review: true })`. This independently confirms the two-caller coupling that made sequencing (a) necessary: on this base, deleting `persistReviewCandidate` without the compile field would leave `review: true` a silent no-op. Re-checked on this branch while recording this entry: HEAD is `2872661ccab752a864f35dee709c3ae995848bb1`, byte-identical to `main`; the declaration is `packages/wiki/src/utils/types.ts:233`, and `test/quickstart-shared-steps.test.ts:238` reads exactly `await compileAndReport(root, { review: true });`.
- Correction to an earlier peer statement: `8fc553c3` is an ancestor of `main` and the stale-advert sweep already landed as `ab00dba3` ("fix(output): stop advertising commands the product does not ship"). Therefore this slice does NOT re-sweep `viewer/`, `mcp/okf-tools.ts`, `import/run.ts`, `context/pack-warnings.ts`, `project/recommendations.ts` or `commands/query.ts` for stale `llmwiki review` strings — that would be a second coat. Slice A touches `packages/wiki/src/commands/query.ts` for option removal only, which is a different edit from advert wording, and it is worth noting that the old `:47` / `:63` / `:355` locators quoted with that instruction do not point at the option at all (see L4's measured list).
- Note that the peer's branch records lint at `565 violations / 402 files / 429 rule/file entries` after an authorised decrease-only rebaseline, while this branch's base carries the literal `566 / 402 / 429`. Slice A must not use a lint decrease it did not cause.

### L6

Supervisor boundary rulings for Slice A, plus one standing rule this chain produced. No spec changes: these entries narrow where Slice A may write and record why.

**(1) `packages/wiki/src/sdk/core-types.ts` was narrowly added to Slice A's allowed surfaces, and the supervisor approved it.** The SDK `query(...)` signature at `:192` declares `review?: boolean`, and an option cannot survive on the type once its implementation is gone. The boundary, verbatim: only the `query(...)` signature area. `sdk/core-types.ts:19-21` (`SdkCompileOptions.review`) stays forbidden, because it is the peer branch's region.

**(2) That makes `core-types.ts` a fourth expected conflict site.** The peer branch `fix/remove-review-option` also edits `core-types.ts`, so the expected conflict set is now four sites: `compiler/review-pipeline.ts`, `compiler/index.ts`, and the same `core-types.ts` / `utils/types.ts` pair, which was previously assumed to be a two-way conflict on that pair alone. This strengthens the ordering decision (a) already taken in L4; it is not a new decision.

**(3) `packages/wiki/src/utils/types.ts` is allowed to Slice A only as far as TypeScript forces it, with a sharp boundary.** Verbatim: only what the compiler demands, each line named in the report with the `TS` code that demanded it. And the stop condition, verbatim: if the forced change would reach `ReviewCandidate` or anything the candidate store owns, stop and report — that is Slice B's territory.

**(4) The documentation locators were corrected and the supervisor accepted the correction.** The query option is documented at `docs/guides/sdk.mdx:140`, `:163`, `:165`, `:168`, and NOT at `:178-186` (`:178` is review-candidate prose, `:182-186` is a `wiki.search` ParamField). The file stays in Slice A; the lines change.

**(5) The census lesson, recorded as a standing rule.** Five locator figures were wrong across this chain, and every one came from this branch's own recon agents, not from the peer — including `commands/query.ts:47`, which is the `loadSelectedPages` doc comment and not the review option, a wrong number that would have had a worker delete the wrong function's documentation. The rule, verbatim: **a locator is not evidence until a worker has re-read it against the tree, and a worker should trust its own read over the number it was handed and report the difference.**

**(6) The posture that follows from (5), verbatim:** **trust its conclusions, verify its coordinates.** The same class of agent produced wrong line numbers on four different slices while its conclusions were mostly right, so the response is not to distrust recon but to separate what it concluded from where it pointed.

**(7) The five corrected figures, each as a `wrong -> measured` pair, so a later reader can see the shape of the error:**

1. `commands/query.ts:47` -> `:153-157` (JSDoc) and `:158` (field).
2. The option's reads `:63` / `:355` -> `:199`, `:236`, `:248`, `:356`.
3. `docs/guides/sdk.mdx:178-186` -> `:140`, `:163`, `:165`, `:168`.
4. `store.ts:313` described as `applyApprovedMutations` -> it is the `...Locked` variant.
5. `compile-write.ts:140` described as `applyApprovedMutations` -> it is the `...Locked` variant.

For figures 4 and 5 the self-locking call is at `store.ts:316`, and the "none is the SDK" conclusion is unaffected. All five were re-read against `2872661` while recording this entry and hold as stated.

**(8) Slice B's status did not change.** It remains blocked on a named prerequisite — branch `fix/remove-review-option` must land first, and Slice B rebases onto it — as T1 and T6 record.

### L7

Slice A landed, then rebased onto the peer, then gated on the rebased tree. This entry is the definitive evidence record for it.

**(1) Slice A's subject matter, as landed.** The query `review` option is gone with its JSDoc, its reads, the `scopedOrReview` selection it drove, the `assertQuerySaveOptions` helper and the `"Query review requires save."` guard it threw; `stageQueryProposal` (`packages/wiki/src/commands/query-proposal.ts`, file deleted) and `writeFreshCandidate` are gone with it. The dead `applyApprovedMutations` import at `packages/wiki/src/sdk/core.ts` is removed — approved in L4 with the measured evidence that its live callers are `categories/store.ts:316` (self-locking) and the `...Locked` variants at `categories/store.ts:313` / `compiler/compile-write.ts:140`, none of which is the SDK. `QueryResult.candidateId` is retired rather than left declared with no producer.

**(2) The independent verification ran, and it found four real defects.** Verdict on the tree it read: **A1-A5 confirmed, B1-B6 confirmed, C confirmed, E confirmed.** One of its own runs was invalid and is recorded as such rather than as a failure of this diff: its `pnpm test` executed under Node 22, and the single failing test in that run was the Node-24 enforcement test itself, which fails by design when the runtime major is wrong; re-run alone under Node 24 it passed green. The four defects it found, and the fixes that landed:

1. `QueryResult.candidateId` was still declared. An option removed from the input but still promised by the output type is the same defect one level down, so the field and its JSDoc are gone.
2. The CHANGELOG claimed that a TypeScript caller passing `review` stops compiling. That was false as written: the facade forwards options by spreading them — `generateAnswer(root, question, { ...opts, registrySource })` at `packages/wiki/src/sdk/core.ts:136` — and a spread source is not a fresh object literal, so excess-property checking never sees it. Only an inline literal is rejected by the type checker; a value passed through a typed variable still compiles, carries the `review` key and is ignored. The entry now states both shapes instead of overclaiming one.
3. Two durable absence probes were added to `test/query-review-option-retired.test.ts`, so a hand-maintained symbol list cannot let the option or the candidate identity return unnoticed: the surviving query surfaces must declare no `review` option, and the publication module must not name `candidateId`.
4. The tracker lines in this document were stale and are updated with it.

**(3) The rebase onto `e314382b`.** `git rev-parse main` was `e314382b86f2f5915ce0816e87e2e7a00eebfaa1` before anything was touched — the required target, not a substituted one. Pre-rebase HEAD was `edfe844b49fb88a371e08789a2897a2f1dd7b4dd` on `06eac8e713de858b1bbb32cd76cc6013a3622ceb`, and `git status --short` was exactly `?? odd/tasks/retire-candidate-stagers.md`.

`git rebase main` exited **0** and reported `Successfully rebased and updated refs/heads/fix/retire-candidate-stagers`. **No file conflicted.** The five expected conflict sites — `CHANGELOG.md`, `utils/types.ts`, `sdk/core-types.ts`, `docs/guides/sdk.mdx`, and the guarded pair `compiler/index.ts` / `compiler/review-pipeline.ts` — all auto-merged, which is precisely the case where a silent loss would go unnoticed, so each was proved present afterwards rather than assumed:

- `CHANGELOG.md`: both `- **BREAKING —**` entries survive in the same `## [Unreleased]` -> `### Changed` block, neither dropped nor merged into the other. This branch's is `- **BREAKING — the `query` review option is removed, and a saved answer is now always written as a `wiki/queries/` page.**` at `CHANGELOG.md:12`; the peer's is `- **BREAKING — the `review` compile option is removed, and `compile({ review: true })` now throws.**` at `:218`.
- The peer's removal is intact: `grep -rn "review?: boolean" packages/wiki/src/utils/types.ts packages/wiki/src/sdk/core-types.ts` has **no hits** (grep exit 1), and this branch's removal is intact with it: `grep -n "candidateId" packages/wiki/src/utils/types.ts` has **no hits** (grep exit 1). `grep -r "options.review" packages/wiki/src` returns **0** lines across **0** files.
- **The guard survived, and it is the single highest-risk region in this chain.** The first statements of `compileAndReport` (`packages/wiki/src/compiler/index.ts`, function at `:331`) are, verbatim: `:342` `  if ("review" in options) {`, `:343` `    throw new Error("The review compile option no longer exists: no surface promotes a held candidate, and the option will not come back. Remove it from your call.");`, `:344` `  }`, preceded by its rationale comment at `:335-341`. The banner is `:345` `  output.header("Wiki compile");`. The guard still **precedes** the banner, four lines above it, exactly as the peer wrote it. Measured note against the handed locator: the comment block begins at `:335` and the throwing statement itself is `:342`, so "around `:341`" was the comment's last line, not the statement — the conclusion was right, the coordinate was one off (L6 items 5-6).
- `persistReviewCandidate` is defined at `packages/wiki/src/compiler/review-pipeline.ts:144` and has exactly **one** caller, `:91`, inside the `reasons.length > 0` policy branch, passing `reviewMode: "policy"`. The forced call branch is gone. What deliberately remains for Slice B is the vocabulary, not a second path: the union member `reviewMode: "policy" | "forced"` at `:51` and the defensive `meta.reviewMode === "policy" ? "held" : "forced"` mapping at `:175` are now unreachable from a forced compile, because no caller can pass `"forced"` any more.
- `packages/wiki/src/commands/query-proposal.ts` is **absent**, and `writeFreshCandidate`, `stageQueryProposal` and `assertQuerySaveOptions` have **no hits** anywhere in `packages/wiki/src`.

**(4) Gates on the rebased tree, each run alone under Node 24** (`node -v` = `v24.21.0` proved inside the same shell invocation as each gate; no sibling vitest was running):

- `gates:static` — exit **0**, all 6 gates passed in 22.2 s. The lint triple is the literal `565 baseline violations in 402 files across 429 rule/file entries` — exactly the peer's authorised decrease-only ceiling, not above it, so no rebaseline of any kind was performed.
- `build` — exit **0**.
- `vitest run test/artifact` — exit **0**, `5 passed (5)` files, `29 passed (29)` tests, 19.55 s.
- `set -o pipefail; pnpm test` — `EXIT_SUITE=0`, `822 passed | 3 skipped (825)` files, `6171 passed | 4 skipped (6175)` tests, 313.40 s. No test timed out, so no load-attributed re-run was needed. Load average **before** 3.34 / 2.41 / 4.84, **after** 5.43 / 5.04 / 5.34 — well under the 17.27 that produced three timeout failures in a prior run.
- The gates did not dirty the tree: `dist/` is untracked build output, and `git status --short` afterwards shows only the intentional files.

**(5) The dead assertion cleanup, and why it changed no count.** `test/query-publication-sdk-mcp.test.ts:192` asserted `expect(result.candidateId).toBeUndefined();` against a field that no longer exists. That assertion could never prove anything: the file imports `type QueryResult` from `../packages/wiki/src/index.js`, and `packages/wiki/src/index.ts` does not export `QueryResult` at all, so `result` is effectively untyped and the assertion was type-legal but semantically empty. `typecheck:tests` reported `239 baseline diagnostics in 86 files` before removing it and `239` after — a dry-run re-baseline confirmed `Total errors: 239 -> 239` — so the count did not strictly decrease and **no `--update` was run and `test-typecheck-baseline.json` is unchanged**. (Operational note for the next worker: the `-- --update` form quoted in instructions is rejected by this script, whose `parseArgs` sees `--` and turns the flag into a positional; the sanctioned entry points are `typecheck:tests:update` and `typecheck:tests --rebaseline`.)

**(6) What this unblocks.** `main` is now `e314382b`, so the prerequisite T6 and L4 recorded is satisfied: branch `fix/remove-review-option` has landed, `SdkCompileOptions.review` and `CompileOptions.review` are already gone on the base, and `persistReviewCandidate` is down to its single policy caller. Slice B — `persistReviewCandidate` / `writeCandidate` / OKF staging / the `review.hold` policy path — is therefore unblocked and no longer needs the sequencing that (a) required.
