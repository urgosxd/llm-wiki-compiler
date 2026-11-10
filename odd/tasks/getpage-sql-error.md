# getPage row-backend read error and status.sources counter

Branch: `fix/getpage-sql-error`

This document is the specification for this feature; below the tracker line it is append-only.

## Specs

- **S1** — Reported reproduction and error:
  > ingest one markdown source, then call `getPage`. It throws a Postgres `syntax error at or near "and"`
- **S2** —
  > **Capture the generated SQL verbatim** before changing anything. The message alone is not a diagnosis.
- **S3** —
  > **RED first**: a test asserting `getPage` returns the page that was just ingested. Then the fix. Then GREEN.
- **S4** —
  > **Cover the shape, not just the symptom**: if the defect is an empty predicate list, the test suite must pin the empty case *and* the non-empty case, because the bug existed precisely because only one was covered.
- **S5** —
  > **Reproduce first, on a fresh database.** Not on the shared `kind_kirch` container: it is schema-stale (missing `aliases` and `attribution_gaps` while HEAD's select requires them at `packages/wiki/src/dimensions/wiki/schema.sql:101,104`) and it fails reads for reasons unrelated to your bug. Use a Testcontainers-provisioned database, or read the port with `docker port <name> 5432/tcp` and never hardcode one.
- **S6** —
  > **Report whether `getPage` is published surface** — reachable through the packed `dist/index.js`/`createWiki` — because that decides `fix` versus `fix!` for the commit subject.
- **S7** — F3 report:
  > **F3 — `status.sources` reports `0` while `listSources()` returns `1`**
  >
  > A counter disagreeing with the list it summarises.
- **S8** —
  > **Determine whether F2 and F3 share a root cause** before deciding the commit shape. If they do, one commit with both explained; if they do not, **two commits**, because they are then two independent defects and must be revertable separately.
- **S9** —
  > Pin the invariant rather than the number: whatever assertion you write must fail if the count and the list ever disagree again, not merely assert `0`.
- **S10** —
  > If either bug turns out to be **not real** on a correct database — i.e. it was an artefact of the stale container — **say so plainly and stop.** A refuted bug is a valid outcome and the finding is still worth reporting; do not manufacture a fix to justify the slice.
  >
  > Do not fix anything else you find. Record it.
- **S11** — Gates:
  > `gates:static` · `tsc --noEmit` · `typecheck:tests` · `typecheck:kg` · `lint` (**zero headroom**: literal `566 baseline violations in 402 files across 429 rule/file entries`; new code must be violation-free and `lint:update` is forbidden) · `fallow:ci` · `build` · `test/artifact/*` · `pnpm test` alone, twice if the first run shows any flake.
- **S12** — Prohibitions:
  > No history rewriting (no `git reset`, `git restore --staged`, `--amend`), no hook bypass of any kind — `git -c core.hooksPath=/dev/null` is `--no-verify`. No push, no `--no-verify`, no `HUSKY=0`, no `cp -a` of this worktree.
  >
  > `odd/tasks/**` append-only except the tracker line.
- **S13** — Report fields:
  > the reproduced error and the emitted SQL that causes it; the root cause in one sentence; whether F2/F3 are one defect or two and why; whether `getPage` is published surface; the RED/GREEN for each; every gate exit with the literal lint triple; commit SHAs as full 40 characters; `git status --short`; and a `Risk:` line — item 3 applies if `getPage` is published, and item 6 if any of these behaviours had no test at all.
- **S14** — Node and gate environment:
  > `Node 24 ONLY: PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>` — a verifier without Node 24 reproduces a phantom failure in `scripts/pnpm-invocation.test.ts` and `maxWorkers` 4; suite ~302 s, 6,114 tests.

## Tasks
Tracker: T1 done · T2/T3 dropped (F2 unreproduced, no fix to implement) · T4/T5 done · facade env threading (parent-assigned work unit, L3; no S# of its own) done — `compile`/`status` forward `env`, `status` reads the page/source row seams: tsc --noEmit 0, typecheck:tests 0, lint 0 (566/402/429 baseline triple), fallow:ci 0, focused + narrow suites green, no commit · L4 correction (independent verifier FAILED the L2 unit on `status.sources`, result:verify-f3-env-units#1) done in `status/collect.ts`: the count now derives from `listSelectedSourceFiles(root)` — the same pipeline `listSources()` enumerates — while the row seams still drive `pages`/`pendingChanges`; tsc --noEmit 0, typecheck:tests 0 (240 baseline diagnostics, no regression), lint 0 (566/402/429 unchanged), fallow:ci 0, test/status + test/sdk green (19 files / 56 tests), new selection suite 4/4 green across 3 runs · OPEN→RESOLVED: `test/mcp/ambient-state-isolation.test.ts:226,252` and `test/mcp/retired-parity-payloads.test.ts:169` reconciled to `sources: 0` under Lead Option A (`test/mcp/` authorized for the `sources` literals only); `test/mcp` now green (20 files / 117 tests), goldens byte-identical · current task T6 (parent) · commits (full 40-char SHAs): T1 record `6d6454fed0e11965c932e4a4c27347ed7bae4d5f` · T4/T5 F3 `0e293763960065b0d2733ba339fbe2d5cd6799f8` · facade env unit `c0d4731dc8161ac630e3c9475f44a2cfa7d2e152`; T2/T3 dropped · earlier gates run: tsc --noEmit, typecheck:tests, lint, fallow:ci, test:unit — all exit 0; test:affected exit 78 (full unit tier declined, ran test:unit instead)
- [ ] T1 · S1,S2,S5 · route: gentle-ai-worker · commit: tbd
- [ ] T2 · S3,S4 · route: gentle-ai-worker · commit: tbd
- [ ] T3 · S1,S2,S4 · route: gentle-ai-worker · commit: tbd
- [ ] T4 · S7,S9 · route: gentle-ai-worker · commit: tbd
- [ ] T5 · S7,S8,S9 · route: gentle-ai-worker · commit: tbd
- [ ] T6 · S6,S8,S11,S12,S13,S14 · route: parent · commit: tbd

## Log

### L1

Project assignment for branch fix/getpage-sql-error:

Fix a broken public read API and a counter that disagrees with the list it summarises. Both are pre-existing product defects, reproduced identically against the packed tarball and the repo build, and both were found by accident during a packaging verification.

F2 — getPage throws `syntax error at or near "and"` — reported reproduction: ingest one markdown source, then call getPage. It throws a Postgres `syntax error at or near "and"` — a generated-SQL error, which means some predicate list is being joined with a trailing or leading `and` and no operand. The strongest hypothesis is an empty-filter path the test suite never exercises, but do not trust my hypothesis — find the emitted SQL and show it.

F3 — status.sources reports 0 while listSources() returns 1 — same report, same reproduction, both paths. A counter disagreeing with the list it summarises.

### L2
F2 (`getPage` throws a Postgres `syntax error at or near "and"`) is UNREPRODUCED WITH AN UNEXPLAINED ORIGINAL — not refuted. Twelve runs on fresh Testcontainers databases, across repo source and packed tarball, through both the SDK `getPage` and the MCP `read_page` surfaces, plus an 8-cell variation matrix, produced no error; the emitted SQL was captured verbatim and contains no dangling `and`; a repo-wide search finds no dynamic predicate-list join. That establishes only that the published read path as exercised cannot emit a dangling `and`. The original observation stands unexplained: an independent verifier saw `getPage → Error | syntax error at or near "and"` in a read-surface matrix where `listPages` failed with `column "aliases" does not exist` from the stale shared container, `listSources` and `status` succeeded. Distinguishing detail for whoever picks it up: that run ingested via `ingestText({title, text})`, producing a manual source identity (`manual:<hash>`), which no reproduction run used. The invocation that failed was not captured. T2 and T3 are dropped as unimplemented — there is nothing to fix once the error cannot be produced — and F2 stays open as an unexplained observation rather than a closed door.
F3 root cause: `status.sources` counts compile-state entries (`status/collect.ts:283,287`), not sources, so it reports 0 beside a 1-item `listSources()` before the first compile. Fix pins the invariant `status.sources === listSources().sources.length`.

### L3
Manager ruling: `status.sources` must count sources that EXIST, not compile-state entries (implemented in L2's unit); and the facade dropping `env` in `compile`/`status` (`sdk/core.ts:99-101`, `:139`) is the same defect the ingest slice fixed, left half-done — a status describing two Stacks at once is item 1, so it gets its own revertable commit. `lastCompiledAt` and the status shape are left alone.

### L4
Independent verification (see result:verify-f3-env-units#1) FAILED the L2 unit: `status.sources` counted `wiki.source_documents` ROWS whenever a `sourceDocuments` seam was present, while `listSources()` reads only the selected `sources/` listing. Measured divergences: hidden dot-file 1 vs 2; `sources.exclude` 1 vs 0 and deleted projection 1 vs 0, the last two having AGREED at baseline. Lead decision: agreement with the public list wins over "rows when a Stack is named", because the request names `status.sources === listSources().sources.length` twice and a count that includes a source nobody can list or read is the same class of lie. The count now derives from the same selected-listing pipeline `listSources()` enumerates, with durable tests pinning the selection cases.
The general lesson, worth more than the one file: the original F3 test drove the status side through `withSourceDocuments`, so it compared rows against files and measured them only after a successful projection — the single moment the two corpora coincide. A test that measures agreement only where agreement is guaranteed proves nothing. Durable tests must measure where the corpora separate: hidden dot-file, config `exclude`, deleted projection.
UNIT 2 CONTRACT CHANGE (release note, not a footnote): `status()` on a Stack-bound handle now requires a reachable database. Measured: an env naming a Stack with an unreachable URL went from `RESOLVED sources=0 stateStatus:"missing"` to `THREW connect ECONNREFUSED`. An embedder whose database is briefly down used to get a degraded status and now gets an exception. This belongs in the CHANGELOG and the PR description in its own sentence.
LARGER DEFECT, SHARED, NOT FIXED HERE: counting the selected listing makes `status` consistent with `listSources()`, which is the invariant and this fix. But a Stack-hosted deployment with no `sources/` tree has both surfaces agreeing on a number that describes nothing. That is a separate defect shared by both, and this fix must not be read as a claim that the file listing is the right corpus for Stack deployments.
RECORDED, NOT FIXED: `test/mcp/ambient-state-isolation.test.ts:220` passes at baseline and after, but for a coincidental `1` rather than the reason its comment claims — a test asserting a number where it should assert a relationship.
Reconciliation under Lead Option A (`test/mcp/` was added to this worker's edit surfaces for the `sources` literals and their comments ONLY): `ambient-state-isolation.test.ts:226,252` and `retired-parity-payloads.test.ts:169` now assert `sources: 0`, because both fixtures seed Stack ROWS and create no `sources/` tree while `status.sources` follows the selected `sources/` listing — a row is not a listing; row-derived meaning stays carried by `pages.total` (`:219`), `lastCompiledAt` (`:227`), `pendingChanges` (`:228`) and `pendingCandidates` (`:232`) in the ambient test and by the whole remaining payload at `retired-parity-payloads.test.ts:164-176`, each of which fails if the named Stack's rows were never read; Option B was rejected because projecting `sources/*.md` beside URL source identities would create a file-vs-row mismatch that moves `pendingChanges` and the whole-payload assertions this suite exists to freeze; `test/parity/__golden__/*` stayed byte-identical throughout.

### L5
Close-out record. The three work-unit commits on `fix/getpage-sql-error`, full 40-character SHAs with subjects: `6d6454fed0e11965c932e4a4c27347ed7bae4d5f` docs(odd): record the getpage-sql-error feature document (T1 record); `0e293763960065b0d2733ba339fbe2d5cd6799f8` fix(status): count the source listing so status.sources matches listSources() (T4/T5, F3); `c0d4731dc8161ac630e3c9475f44a2cfa7d2e152` fix(sdk): thread CreateWikiOptions.env through compile and status (facade env unit). They are recorded against their tasks on the tracker line above; T2/T3 stay dropped because F2 was never reproduced (see L2).
GATE EVIDENCE, all on Node v24.21.0, every exit 0: `gates:static` 0 (all 6 static gates); `build` 0; `test/artifact` 0 (4 files / 20 tests); `pnpm test` 0 (807 files passed / 3 skipped, 6119 tests passed / 4 skipped, 318.17 s, no flake — the known `test/main-subcommand-flags.test.ts:147` SIGTERM flake did not appear, so no second full run was needed); `lint` 0 at the unchanged `566 baseline violations in 402 files across 429 rule/file entries`, `lint:update` never run; `release:check-docs` 0.
TWO `Risk: item 3` DISCLOSURES. (1) `status.sources` now follows the selected `sources/` listing, so a Stack whose rows and `sources/` tree disagree reports what a caller can actually list and read instead of the row count. (2) `status()` on a Stack-bound handle now requires a reachable database, where it previously returned a degraded status — carried as its own sentence in the CHANGELOG and the commit body.
CLOSED DECISION, selection correction: Lead Option A — the `test/mcp` `sources` literals reconciled to `0` (`ambient-state-isolation.test.ts:226,252`, `retired-parity-payloads.test.ts:169`) because a row is not a listing, with `test/parity/__golden__/*` byte-identical throughout.
DISCLOSED: two intermediate runs — the Part-1 focused pair and the first artifact run — adopted the shared `kind_kirch` container through the repo's Testcontainers handoff before gate 3 was re-run pinned to `llmwiki-kg-db-1`; both were green, gate 3 was re-run clean against the pinned container, and gates 4 and 5 never touched that container.
This entry is committed as a fourth slice, `docs(odd): record the work-unit commits and gate evidence`, touching only this file.
