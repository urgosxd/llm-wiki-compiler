# `codebase-health` runs the gate, not the raw report

Branch `fix/codebase-health-uses-the-gate`, base `main` = `8955d0615c5b6f624ba59d4f3154764050103028`. Objective: the CI job named `codebase-health` runs `pnpm run fallow:ci`, the command `AGENTS.md` calls the gate, instead of the pinned `fallow-rs/fallow` action's raw full-tree report — which failed on inherited debt (`Fallow found 204 issues`, run `43140640639`).

## Specs

- **S1 — CI runs the project's gate, not the raw report.** The `codebase-health` job runs `pnpm run fallow:ci`, the same command `AGENTS.md` calls "the command that actually gates". No fallow invocation may appear in that job outside `scripts/fallow-ci.sh`; the pinned `fallow-rs/fallow` action is removed from the job.
- **S2 — the job provides what the gate needs, in exactly two steps.** `actions/checkout@v4` gains `fetch-depth: 0`; ONE `run:` step installs with `corepack pnpm install --frozen-lockfile`, establishes the base, and runs `corepack pnpm run fallow:ci`. No `pnpm/action-setup@v4` and no `actions/setup-node@v4` are added — Node 24 and pnpm come from `corepack`, on a runner whose Node is already 24. Reason: `scripts/fallow-ci.sh` runs `./node_modules/.bin/fallow`, and `AGENTS.md` says Node 24 only.
- **S3 — the base ref is the event's own, and a missing base is loud.** CI provisions a local `main` at `${{ github.event.pull_request.base.sha || github.event.before }}` — `push` → `github.event.before` (the pre-push tip of `main`), `pull_request` → `github.event.pull_request.base.sha`. There is NO `origin/main` fallback. HEAD is detached before `main` is repointed, because moving the checked-out branch moves HEAD with it and `fallow audit` would then compare HEAD against itself and pass while checking nothing. An unresolvable base must fail, never silently pass: `fallow` exits 2 and `scripts/check-fallow-report.mjs` fails closed with exit 2.
- **S4 — `codebase-health` stays the job name.** No job-level `name:`, no new job, no `workflow_dispatch`, the `node-version: [24]` matrix untouched, and every other job and step byte-identical.
- **S5 — the documentation stops asserting the old wiring.** `docs/fallow-gates.md` § "A developer-machine gate; CI is the pinned action" and the `ci.yml` scope-note comment about `--changed-since`/wrapper injection are rewritten to state the new decision with the measurements above (204 vs 46, the install requirement, the base-ref requirement).
- **S6 — no threshold, baseline or ignore-list change.** `scripts/fallow-ci.sh`'s gate invocation and thresholds, `scripts/check-fallow-report.mjs`'s counters, every `baselines/*`, and the gate's counters are untouched.
- **S7 — a base equal to HEAD is refused, not passed.** When the resolved base is the same commit as HEAD the gate compared nothing; the check refuses loudly with a non-zero exit and a message saying so, instead of printing a pass. Test-first: one test for base == HEAD (refuses), one for base ≠ HEAD (proceeds), one for a missing base (refuses as today).
- **S8 — an absent base fails loudly.** An empty or all-zeros base SHA (a branch's first push) fails the step with an error; there is no fallback to a base that would make the gate vacuous.
- **S9 — the vacuous-base refusal is strict in CI (`FALLOW_CI_REQUIRE_DISTINCT_BASE=1`) and a loud warning locally, because `.husky/pre-commit` and `gates:static` run `fallow:ci` and every branch's first commit has `HEAD == main`; `--no-verify` is forbidden, so an unconditional refusal would deadlock authoring**
- **S10 — the vacuous-base guard's subject is `merge-base(refs/heads/main, HEAD) == HEAD`, not SHA equality, and its messages describe that comparison, so `main` merely being ahead of HEAD is refused and warned about accurately, and the SHA they print is HEAD's own, never the commit `main` points at — a test pins that too**
- **S11 — `codebase-health` provisions pnpm and Node exactly as `build-and-test` does (`pnpm/action-setup@v4` + `actions/setup-node@v4`, `node-version: 24`, `cache: pnpm`) and runs the bare `pnpm run fallow:ci`; `corepack` is a property of a broken developer host, not of CI, and a required check must not depend on the runner image's preinstalled toolchain**

## Tasks

- [x] T1 — create this ODD feature document — Spec: S1-S8 — route: inline — commit: none (uncommitted by design)
- [x] T2 — `.github/workflows/ci.yml`: replace the `codebase-health` scope note and its two steps with exactly two steps — checkout at `fetch-depth: 0`, and one `run:` that installs, establishes the base, detaches HEAD, repoints `main`, and runs the gate — Spec: S1-S4, S8 — route: inline — commit: none (uncommitted by design)
- [x] T3 — `docs/fallow-gates.md`: rewrite § "A developer-machine gate; CI is the pinned action" as a superseded decision, extend § "Where `audit` gets its base" with the CI case, correct the false safety claim — Spec: S5, S7 — route: inline — commit: none (uncommitted by design)
- [x] T4 — proofs: local RED (raw report on a dependency-less tree), GREEN (`fallow:ci` with base ≠ HEAD), the base-provisioning block in a scratch clone, YAML parse proof, gates, greps — Spec: S1-S6, S8 — route: inline — commit: none (uncommitted by design)
- [x] T5 — the base==HEAD refusal in `scripts/fallow-ci.sh`, test-first: three tests in `test/ci/fallow-report-gate.test.ts` (base == HEAD refuses, base ≠ HEAD proceeds, missing base refuses as today) — Spec: S7 — route: inline — commit: none (uncommitted by design)
- [x] T6 — proofs for S7/S8: the refusal observed locally (base == HEAD), the audit document's shape showing `base_ref` is a ref NAME and `head_sha` abbreviated, RED then GREEN of the three tests, gates re-observed — Spec: S7-S8 — route: inline — commit: none (uncommitted by design)
- [x] T7 — round 2: make the refusal conditional on `FALLOW_CI_REQUIRE_DISTINCT_BASE` (S9), fix the four verification defects (the false `corepack` comment, the stale `fail-on-issues` mechanism, the present-tense `origin/main` claim, the false "pre-commit does not run fallow" claim), pin the job shape and the strictness declaration in `test/control-gates.test.ts` with mutation proofs — Spec: S5, S7, S9 — route: inline — commit: none (uncommitted by design)
- [x] T8 — round 3: make both guard messages describe the comparison instead of claiming the two commits are equal (`main` ahead of HEAD is the unaffected-before shape), pin it with two probe tests, and correct the quoted warning in the docs — Spec: S9, S10 — route: inline — commit: none (uncommitted by design)
- [x] T9 — round 5: provision pnpm and Node through `pnpm/action-setup@v4` + `actions/setup-node@v4` (bare `pnpm`, no `corepack`, no `corepack` env line), re-pin the four-step shape with mutation proofs, carry the ruling into the docs, and commit the slice in two work units — Spec: S11 — route: inline — commit: the two work units this round commits (L7)

## Log

### L1

The assignment's original requirement text, verbatim:

"`codebase-health` runs the **wrong fallow invocation** in CI and fails on inherited debt. Fix the wiring so CI runs the gate the project defines, not the raw full-tree report."

### L2

The measured diagnosis:

"204 = 197 dead-code + 6 dupes + 1 health in a tree with no node_modules; 46 with deps; CI and a laptop must run the same command; codebase-health must keep its name; no threshold, baseline or ignore-list change."

### L3

The scope correction, and what the measurements forced. Every number below was
observed on this worktree at `8955d061`, with
the repo's own pinned `fallow` 2.82.0.

**The audit document cannot prove "base equals HEAD", which decided where the
refusal lives.** Literal top-level keys of
`./node_modules/.bin/fallow --root . audit --format json --gate new-only -q`:
`schema_version, version, command, verdict, changed_files_count, base_ref, head_sha,
elapsed_ms, summary, attribution, dead_code, duplication, complexity`. The fields
that matter: `base_ref: "main"` — a ref **name**, not a commit — and
`head_sha: "8955d061"` — the **abbreviated** SHA. The tool's own contract says the
same (`node_modules/fallow/types/output-contract.d.ts`: `base_ref` is "Git ref used
as comparison base (explicit or auto-detected)", `head_sha` is "Short SHA of HEAD").
So there is no resolved base commit to compare against, and the refusal went into
`scripts/fallow-ci.sh` (B2's fallback), not `scripts/check-fallow-report.mjs` (B2's
preference).

**The silent-green shape, measured before the guard existed.** `main` = `HEAD` =
`8955d061` in this worktree, so `corepack pnpm run fallow:ci` printed
`Fallow CI: 0 dead-code, 0 complexity, 0 duplication introduced since main (verdict
pass; 0 … inherited, not counted)` and exited **0** — against itself. With the guard:
exit **2**, `Fallow CI: refusing to run — refs/heads/main is HEAD
(8955d0615c5b6f624ba59d4f3154764050103028), so the gate compared nothing…`. That is
the literal RED then GREEN of S7, and it is why the guard compares
`git merge-base refs/heads/main HEAD` with `git rev-parse HEAD`.

**The raw report, reproduced rather than cited.** `git archive HEAD` into a tree with
no `node_modules`, the workspace's own `fallow` binary: exit **1**,
`Failed: dead-code (197 issues), dupes (6 clone groups), health (1 above threshold)` =
**204**, and `fallow dead-code --format json` on the same tree reports
`total_issues=197, unresolved_imports=169` — the 158-item delta against an installed
tree is the unresolved-import count, exactly as diagnosed.

**Which base `audit` actually reads, measured in three clones** (this decides what the
CI step has to create). It names the base after the **remote's default branch** and
then reads the **local ref of that name**: a clone whose `origin/HEAD` names a branch
with no local counterpart dies with `could not determine changed files for base ref
'fix/codebase-health-uses-the-gate'. Verify the ref exists in this git repository`,
exit 2. So a local ref of the base's name must exist, which is what
`git update-ref refs/heads/main "$base"` provides in CI. In this worktree, and in any
checkout whose default branch is `main`, the auto-detected base is `main`.
### L4

Round 2. Numbered `L4` because `L3` above already records round 1's measurements; this is
the entry round 2's instructions call `L3`.

**The blocker, in the verifier's terms.** The unconditional refusal made the first commit of
every branch impossible: `.husky/pre-commit` runs
`node scripts/pnpm-invocation.ts run fallow:ci` (`.husky/pre-commit:25`), and
`pnpm run gates:static` lists `fallow:ci` as one of its six static gates
(`scripts/static-gates.ts:128`), while on a fresh branch with no commits `HEAD == main`. So
`bash scripts/fallow-ci.sh` exited 2 exactly when a developer needed it to pass, and
`AGENTS.md` forbids `--no-verify` — a deadlock of the authoring loop, not a safety property.
Measured at the time: base == HEAD == `8955d061` in this worktree → exit 2.

**Resolution (S9).** Strictness became a declaration CI makes about itself instead of a
property of the script: `FALLOW_CI_REQUIRE_DISTINCT_BASE=1` → exit 2 with the refusal;
unset → a warning on **stderr** naming `refs/heads/main`, HEAD's SHA and what was not
checked, then the analyzer's own verdict. `codebase-health` sets it and no other step in any
workflow does (`stepsDeclaringEnv` pins that, plus the exact value `"1"`, because deleting
that one line would silently return CI to warn-and-proceed).

**The four defects verification found, all fixed:**
`docs/fallow-gates.md` said "CI's `fail-on-issues` does not gate on it either" — a mechanism
the action took with it; the present-tense "on this clone `origin/main` is `8203862`" now
contradicted the section recording that `origin/main` is `8955d061` (put in the past tense,
pointing at the new section, command block untouched); the `corepack` comment in
`test/control-gates.test.ts:38-41` said it "must not appear in the workflow" while `ci.yml`
uses it in this very job; and "`.husky/pre-commit` does not run fallow" was false — it runs
the gate.

**Wording.** The refusal message said "refs/heads/main is HEAD" for a shape where `main`
could merely be ahead. Both messages now describe the comparison that is actually made —
`git merge-base refs/heads/main HEAD` == `git rev-parse HEAD`, i.e. "local main holds nothing
this checkout adds".

**Bite proofs** (mutation on the real file, restored and sha256-compared):
deleting the `env:` line → `expected [] to deeply equal [ Array(1) ]`; `"1"` → `"0"` →
`expected '0' to be '1'`; `fetch-depth: 0` → `1` → the shape pin fails to match; 19 passed
after each restore.

### L5

Round 3, the last advisory. The verifier's finding: with `refs/heads/main` **ahead** of HEAD
(`main = dff6a4f`, a detached HEAD at `40e3eeb`), the local WARNING printed `refs/heads/main
and HEAD are the same commit (40e3eeb…)`. Those two commits are not the same; the true
statement is that `main` already contains everything HEAD has, i.e. `merge-base(main, HEAD)`
is HEAD, so the gate compared nothing. The exit code and the "compared nothing" clause were
right — only the equality claim was false, and the same sentence was quoted in
`docs/fallow-gates.md`. It escaped round 2 because every probe there used the `HEAD == main`
shape, where the false sentence happens to be true.

**Resolution (S10).** Both messages now state the comparison and label the SHA as HEAD's:
`refs/heads/main already contains everything this checkout has (merge-base(refs/heads/main,
HEAD) is HEAD, <sha>), so the gate compared nothing…`. The guard's subject was already the
merge-base, so the ahead shape was refused correctly before this wording fix; what changed is
that the message no longer lies about why. Two probe tests pin it by construction:
`refuses when local main is AHEAD of HEAD, because merge-base(main, HEAD) is still HEAD`
(strict, exit 2) and `warns without claiming main and HEAD are the same commit when main is
ahead` (local, exit 0), which failed before the rewrite with
`AssertionError: expected 'fatal: …' not to contain 'are the same commit'`.

### L6

Round 4, the last declared gap. Nothing pinned WHICH sha the guard prints — the probes asserted
only the absence of the equality wording, so a message that printed `main`'s commit would have
passed. One test now closes it, in both modes at once:
`prints exactly one Fallow CI line naming HEAD's own SHA, never the commit main points at` — it
reads both refs with `git rev-parse`, asserts they differ in the ahead shape, then for the local
and strict runs asserts exactly one `Fallow CI:` line on stderr, that it contains
`(merge-base(refs/heads/main, HEAD) is HEAD, <HEAD's sha>)`, that it does NOT contain `main`'s
sha, and that the exit is 0 for local and 2 for strict.

Bite proof: both messages were temporarily changed to print
`$(git rev-parse refs/heads/main)`, and the test failed with
`AssertionError: expected 'Fallow CI: WARNING — refs/heads/main …' to contain
'(merge-base(refs/heads/main, HEAD) is…'`, then `scripts/fallow-ci.sh` was restored byte-identically
(sha256 compared) and the file went back to 19 passed.

### L7

Round 5, the Manager's final ruling: **`corepack` is out.** `corepack pnpm` is a fact about
this host (where bare `pnpm` exits 127), not a fact about CI, and a REQUIRED CHECK must not
depend on an assumption about a third-party runner image. So `codebase-health` now has
exactly four steps — `actions/checkout@v4` with `fetch-depth: 0`, `pnpm/action-setup@v4`,
`actions/setup-node@v4` with `node-version: 24` and `cache: pnpm`, then the single gate step —
matching `build-and-test` and `typecheck-tests.yml`. The gate step runs bare
`pnpm install --frozen-lockfile` and `pnpm run fallow:ci`; `COREPACK_ENABLE_DOWNLOAD_PROMPT`
is gone with it. Everything the step had is kept: `BASE_SHA` from the event, the
empty/all-zeros `::error::` + `exit 1` with no `origin/main` fallback, `git checkout --detach`
before `git update-ref refs/heads/main`, and `FALLOW_CI_REQUIRE_DISTINCT_BASE: "1"`.

The shape pin grew with the job: four steps, the two `uses:` actions in provisioning order,
`node-version: 24` and `cache: pnpm` as literals, one `run` containing bare
`pnpm run fallow:ci` and no `corepack`; the strictness-declaration pin is untouched (still
exactly one step in all workflows, value `"1"`). Mutation proofs: deleting the
`actions/setup-node@v4` step → `expected [ { …(2) }, …(2) ] to have a length of 4 but got 3`;
`node-version: 24` → `22` → `expected { uses: 'actions/setup-node@v4', …(1) } to match object
{ uses: 'actions/setup-node@v4', …(1) }`; restored and green at 20 tests.

Committed as two work units: the wiring and its guard first, the record second.
