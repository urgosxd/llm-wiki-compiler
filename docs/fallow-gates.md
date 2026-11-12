# fallow gates: repo-wide vs. the KG package

Maintainer reference. This page is repo-facing (plain `.md`, not published on the
Mintlify site) and exists because the root `.fallowrc.json` is strict JSON that
cannot carry a comment.

## The counterpart of the ignore line

The root `.fallowrc.json` lists `packages/llmwiki-kg/**` under `ignorePatterns`.

**That exclusion is deliberate.** `packages/llmwiki-kg/ts` is a vendored
TypeScript port (`@repo/kg`) whose HTTP handlers and helpers are
exported for consumption by a server entry point that fallow cannot resolve, so
the repo-wide analysis reports roughly 240 dead-code findings that are upstream's
public surface rather than defects. Un-ignoring it repo-wide would bury the
root gate's real signal (currently 0 issues) under that noise and would also
collapse repo-wide entry-point discovery (see below).

**KG still has its own gate.** It lives at
`packages/llmwiki-kg/ts/.fallowrc.json` and runs via:

```bash
pnpm run fallow:kg
```

Clean tree → exit 0. A newly introduced finding inside the package → exit 1,
naming only the new finding.

## The ignored dependencies, and why `postgres` is one of them

`ignoreDependencies` is a flat list of names — the schema accepts strings only —
so this page is where the reasons for its entries live, for the same reason the
section above exists.

`postgres` is a **transitive runtime requirement that static import analysis
cannot follow**: the shipped `dist/index.js` imports `drizzle-orm/postgres-js`,
whose driver imports `postgres`, and no file in `src/` names it. fallow therefore
classifies it as a test-only production dependency and asks for it to be demoted
to `devDependencies` — which is precisely the change that breaks the published
artifact, because a packed install receives only the root `dependencies` block.
The claim is measured, not argued: with `postgres` in `devDependencies`,
`pnpm run test:pack` fails installing its tarball into a throwaway fixture with

```
ERR_MODULE_NOT_FOUND: Cannot find package 'postgres' imported from …/node_modules/drizzle-orm/postgres-js/driver.js
```

and that failure reproduces at `a2c001f`, before the package split, so it is a
property of the published manifest and not of this tree's layout. The dependency
stays in `dependencies`; the `ignoreDependencies` entry records that decision
rather than hiding an unused package.

## Why a package-scoped config instead of the historical explanation

`odd/tasks/kg-dimension.md:148-162` attributes the phantom repo-wide findings to
fallow activating its `drizzle` plugin because the package depends on
`drizzle-orm`. **That cause is wrong at HEAD.** Measured with the pinned
`fallow` 2.82.0, with the KG ignore removed and nothing else changed:

| run (repo-wide, `--root .`) | dead code | files | total issues (measured once) | entry points (measured once) |
| --- | --- | --- | --- | --- |
| KG un-ignored | 1075 | 1829 | 1084 | 303 |
| KG un-ignored, plus `packages/llmwiki-kg/ts/vitest.config.ts` ignored | 238 | 1828 | 247 | 1073 |

The **dead code** and **files** columns are exact and reproduce on every run: the
probe was re-measured and returns 1075/1829 and 238/1828 unchanged. The **total
issues** and **entry points** columns were measured once, on a tree without a
built `dist/`, and are build-state dependent rather than exact — re-measured on a
tree with `dist/` present the same two runs report 1077/309 and 240/1079. The
drift is `dist/` resolution state (see the unresolved-import note below), not a
config difference, so read those two columns as magnitudes, not values.

One ignored file — `packages/llmwiki-kg/ts/vitest.config.ts:3-7`, whose
`test.include: ["src/**/*.test.ts"]` makes fallow treat the vitest config as a
repo-wide entry-point declaration — accounts for the whole difference. No
drizzle exclusion or plugin switch is involved in either run. The real mechanism
is the vitest config, not the dependency.

## The package-scoped config

`packages/llmwiki-kg/ts/.fallowrc.json` extends `../../../.fallowrc.json`, so it
inherits the root's `ignoreExports`, `overrides`, and `ignoreDependencies`
without duplicating them. `extends` accepts only **relative** paths; an absolute
path fails with exit 2 and
`failed to load config '<cfg>': extends paths must be relative, got absolute path: <path> (in '<cfg>')`,
emitted as JSON on **stdout** (`{"error": true, "message": …, "exit_code": 2}`)
with an empty stderr — not on stderr, so a script that only captures stderr sees
nothing.

Under a package root, the inherited `"packages/llmwiki-kg/**"` ignore pattern
matches nothing (patterns are resolved relative to the analysis root), so the
config is not self-erasing and does not need `sealed` or an `ignorePatterns`
override. Measured at `--root packages/llmwiki-kg/ts`:

- 350 files analyzed
- average maintainability 90.4
- 142 entry points
- **238 total issues with `dist/` built — the CI reality**, because
  `pnpm run build` runs before this gate in the `build-and-test` job: 236 dead
  code (199 unused exports, 32 unused types, 1 unused file, 4 duplicate exports),
  1 unlisted dependency, 1 circular dependency, **0 unresolved imports**
- **239 total issues on an unbuilt tree**: the same findings plus **1 unresolved
  import**. Both numbers are correct; neither is a defect, and the difference is
  purely build state.

The unresolved-import delta comes from
`packages/llmwiki-kg/ts/src/testing/per-run-database.ts:75`:
`new URL("../../../../..", import.meta.url)` points at the repository root, so it
only resolves once the root `dist/` exists. That is why an unbuilt tree reports
239 (238 + 1) and a built tree reports 238 (238 + 0). Quote whichever number
matches your tree: the gate's own CI number is **238 total / 0 unresolved**.

## Baselines

Three per-analysis baselines live next to the config:

| file | shape | entries |
| --- | --- | --- |
| `baselines/dead-code-baseline.json` | one array per finding category (`unused_files`, `unused_exports`, …) | 239 (238 stable findings plus the `dist`-dependent unresolved import above) |
| `baselines/health-baseline.json` | `finding_counts` per file, plus `target_keys` | 19 findings across 13 files (17 file+severity keys), 16 target keys |
| `baselines/dupes-baseline.json` | `clone_groups` | 184 |

fallow rejects one global `--baseline` on `audit`, so each analysis keeps its own
file. Literal stderr, exit 2:

```text
Error: audit uses per-analysis baselines. Use --dead-code-baseline, --health-baseline, or --dupes-baseline (or save them with `fallow dead-code|health|dupes --save-baseline <file>`)
```

Regenerate them after an intentional cleanup:

```bash
R=packages/llmwiki-kg/ts
./node_modules/.bin/fallow dead-code --root $R -c $R/.fallowrc.json --save-baseline packages/llmwiki-kg/ts/baselines/dead-code-baseline.json
./node_modules/.bin/fallow health    --root $R -c $R/.fallowrc.json --save-baseline packages/llmwiki-kg/ts/baselines/health-baseline.json
./node_modules/.bin/fallow dupes     --root $R -c $R/.fallowrc.json --save-baseline packages/llmwiki-kg/ts/baselines/dupes-baseline.json
```

Baseline paths resolve differently by command, which is a real trap:
`fallow audit` resolves `--dead-code-baseline`/`--health-baseline`/
`--dupes-baseline` relative to `--root`, while the standalone subcommands
resolve `--baseline` relative to the current working directory. The `fallow:kg`
script therefore passes `baselines/<name>-baseline.json`, which is
root-relative.

## What this gate does and does not cover

`pnpm run fallow:kg` is
`fallow audit --gate new-only` scoped to the package, with the three baselines
applied.

### What "new" means under the shipped invocation

**"New" means "absent from the matching per-analysis baseline".** It does *not*
mean "present in a file the changeset touched", and it does not mean "written by
this diff". The three baselines are the authority on what is pre-existing debt,
and they are live during `audit`.

That matters the moment the gate goes red for you: the thing to check is not
whether you edited the file, it is whether the finding is in
`packages/llmwiki-kg/ts/baselines/<analysis>-baseline.json`. If it is, the gate
stays quiet even when your diff strips and rewrites the line it sits on. If it is
not, you either fix it or accept it deliberately by regenerating the baseline
(the "Regenerate them" block above) — and that regeneration is the only way debt
enters the baseline, so it is the point where a reviewer has to look.

- **Covers:** a new, unbaselined finding in any file the changeset touches inside
  the package. A newly added file (even untracked) is part of the changeset and
  is attributed as `introduced`. Adding one new unused export to a file that
  already carries five baselined unused exports fails the gate naming *only* the
  new one.
- **Pre-existing findings in a touched file do not fail the gate.** Measured, not
  assumed — see "Measured attribution" below. The earlier wording on this page
  warned the opposite (`dead_code_inherited` is "always 0", so every finding in a
  touched file would be attributed `introduced`); that prediction was wrong at
  HEAD and is retracted.
- **The three baseline files are not inert in `audit` mode.** An earlier revision
  of this page claimed they "match zero current issues during an audit run". They
  do match, and they are exactly what keeps pre-existing findings inside touched
  files quiet. `dead_code_inherited: 0` in a passing run means "no *unbaselined*
  finding exists in any changed file", not "attribution is not comparing against
  the base ref".
- **Does not cover:** dead code created *without* touching its own file — for
  example, deleting the last consumer of an export in another file leaves that
  export dead in an unchanged file, and `audit` only analyzes changed files.
  This is the residual hole; the measurements below do not cover it.
- The stronger whole-tree form was verified but is not wired in: for
  `fallow dead-code --baseline packages/llmwiki-kg/ts/baselines/dead-code-baseline.json`
  a clean tree exits 0 and a single new unused export exits 1 naming only that
  finding. Unlike `audit`, it needs no git base ref and sees the whole package.
  `health` and `dupes` do not fail on remaining findings from `--baseline`
  alone — they gate through `--min-score` and `--threshold` — so a chain of
  three would need per-analysis thresholds.

## Measured attribution

Five runs, pinned `fallow` 2.82.0, `--root packages/llmwiki-kg/ts`, all with
`--gate new-only`. The file under test is
`packages/llmwiki-kg/ts/src/core/page/json-dumps.ts`, which carries five
pre-existing `unused_exports` findings and they are all in the dead-code
baseline:

```text
JsonNumberSource:21  pythonJsonString:61  isPythonFalsy:74
emitPythonJson:126   numberSourceReviver:164
```

| run | diff on that file | exit | verdict | attribution |
| --- | --- | --- | --- | --- |
| 1 | clean tree, file untouched | 0 | `pass` | all counters 0, `changed_files_count: 9` |
| 2 | comment line added (nothing new introduced) | **0** | `pass` | all counters 0, `changed_files_count: 10` |
| 3 | same diff, `--dead-code-baseline` removed | 0 | `pass` | `dead_code_inherited: 5`, `dead_code_introduced: 0` — the five come back with `introduced: false` |
| 4 | export declaration line of `JsonNumberSource` reformatted, baseline applied | 0 | `pass` | all counters 0 — baselined findings match by `path:exportName`, not by line |
| 5 | one new unused export added to that same file, baseline applied | **1** | `fail` | `dead_code_introduced: 1`, naming only `jsonDumpsAttributionProbe` (line 218) |

Run 2 is the decisive one: a file that carries five pre-existing findings and is
in the changeset still exits 0. Run 3 shows why — attribution compares against the
base ref, so pre-existing findings are `inherited`, not `introduced`. Run 5 shows
the two rules do not blur together: the baseline suppresses the five old findings
and the one new finding still bites, alone.

The temporary edit for runs 2-5 was restored byte-identically (`sha256sum`
unchanged, `git diff --stat` and `git status --short` both empty).

## The repo-wide gate: what "new" means

`pnpm run fallow:ci` (`scripts/fallow-ci.sh` into `scripts/check-fallow-report.mjs`)
runs `./node_modules/.bin/fallow --root . audit --format json --gate new-only -q`
and decides the exit code from the `attribution` block alone:
`dead_code_introduced`, `complexity_introduced` and `duplication_introduced` must
all be `0`, and `verdict` must not be `fail`. The `*_inherited` counters are
printed and never counted. What keeps the gate quiet about the old noise is that
rule together with the numbers in "The touched-file residual" below, not a
promise. It is also what makes `AGENTS.md` pre-commit gate 5 satisfiable for the
first time: while the local contract summed the raw `check.total_issues`,
`dupes.stats.clone_groups` and `health.summary.functions_above_threshold`, it went
red on a clean `main` with nothing but 20 below-threshold clone groups to blame,
so the rule was effectively dead and readers learned to ignore it.

### Where `audit` gets its base

**"New" means "absent from the pre-existing state relative to the base ref the
audit attributes against", and that base is the merge-base of the current branch
and the local default branch (`main`)** — not "present in a file the diff
touched", and not "written by this diff". So the gate's verdict depends on local
`main` being the checkout's real reference, and that is deliberate. When this note
was first written, `origin/main` was `8203862`, a ref far behind local `main` (how
far is itself a moving counter — measure it with the command below), so a
remote-based base handed a long stretch of history to the current changeset and
turned the gate red on an untouched tree for reasons nobody can fix. **That is no
longer the state, and the reason it changed is recorded below:** `origin/main` now
reads `8955d061`, identical to local `main`, which is exactly what expired the
decision that CI could not have a role — see "A developer-machine gate that CI now
runs too". The rule itself has not moved: the base is still the local default
branch, in CI and on a laptop alike.

The commands below are reproducible; their countable output is not. Anything that
counts commits (`8203862..HEAD`, `8203862..main`) or changed files
(`changed_files_count`) grows every time a commit lands — writing a value here
advances it, so any figure baked into this page is stale the moment it is
committed. **Re-run the commands rather than trusting a number written here.** On
an unmodified tree, with `dist/` built, what does hold is the pair of properties
that are not counters: `duplication_introduced: 20` (the pre-existing clone
groups) and `verdict: "warn"`.

```bash
git rev-list --count 8203862..HEAD   # moving counter — re-run it, never quote it
git rev-list --count 8203862..main   # moving counter — re-run it, never quote it
./node_modules/.bin/fallow --root . audit --gate new-only --base 8203862 --format json -q
# → {"changed_files_count": <moves with every commit>, "verdict": "warn", "duplication_introduced": 20}
```

Twenty introduced clone groups with no source change at all: that is the whole
failure mode of a stale base, and it is why the base is the local default branch.
If local `main` drifts, fix the checkout rather than the gate. When the gate goes
red for you, the finding is inside your changeset: fix it, or justify it in
review.

Safety is measured, not promised. A missing, undetectable or bogus base ref makes
`fallow` itself exit 2 — literal stdout,
`{"error": true, "message": "could not determine changed files for base ref
'refs/heads/definitely-not-a-branch'. Verify the ref exists in this git
repository", "exit_code": 2}` — and `scripts/check-fallow-report.mjs` additionally
fails closed with exit 2 when the document cannot prove new-only attribution: a
wrong `command`, a missing `verdict`, an empty `base_ref`, or an
`attribution.gate` other than `new-only`.

**That last sentence used to read "the gate goes red on an unverifiable report,
never silently green", and for one shape it was false.** What the checker
validated was that `base_ref` was *non-empty*; it could not tell "compared
nothing" from "compared and found nothing", because the audit document names its
base with a ref (`base_ref: "main"` here) and carries an abbreviated `head_sha` —
never the resolved base commit. That is the tool's own contract, not an inference:
`node_modules/fallow/types/output-contract.d.ts` documents `base_ref` as "Git ref
used as comparison base (explicit or auto-detected)" and `head_sha` as "Short SHA
of HEAD. Omitted when git is unavailable". So when the base this section describes
equals HEAD — a branch checked out at `main`'s tip — the run compares HEAD against
HEAD and reports `verdict: pass`, every introduced counter `0`, `changed_files_count: 0`,
exit `0`. Measured on this tree (`main` = `HEAD` = `8955d061`) before the guard
below existed, and indistinguishable from a clean changeset.

**`scripts/fallow-ci.sh` now handles that shape in two modes, before the analyzer
runs.** The guard's subject is the COMPARISON, not SHA equality: it asks whether
`git merge-base refs/heads/main HEAD` is `git rev-parse HEAD`, and yes means local
`main` already contains everything this checkout has — so the audit would attribute
every finding against itself. That is what makes the guard catch the shape where
`main` is merely **ahead** of HEAD too (a detached HEAD checked out at an older
commit than `main`): the two commits there are not equal, and the gate has still
compared nothing. Measured in a scratch clone with `main` one commit ahead of a detached
HEAD: refused, not passed — and pinned by the test that names that shape.

- With `FALLOW_CI_REQUIRE_DISTINCT_BASE=1` it is **fatal**, exit 2 — the same code
the checker uses for a report it cannot verify. CI sets that variable in the
`codebase-health` step and nowhere else, so a CI run can never be green having
compared nothing:

```text
Fallow CI: refusing to run — refs/heads/main already contains everything this checkout has (merge-base(refs/heads/main, HEAD) is HEAD, 8955d0615c5b6f624ba59d4f3154764050103028), so the gate compared nothing and a pass would be a statement about nothing. Move local main to the real comparison base, or check out the branch you meant to gate.
```

- With it unset — the local default — it prints a warning on **stderr** and runs
the gate anyway, so the verdict is still the analyzer's. Note what the sentence
claims: the comparison that was made, and HEAD's own SHA. It must never say the two
commits are the same, because in the ahead case they are not:

```text
Fallow CI: WARNING — refs/heads/main already contains everything this checkout has (merge-base(refs/heads/main, HEAD) is HEAD, 8955d0615c5b6f624ba59d4f3154764050103028), so the gate compared nothing. Committing your work is what makes it comparable; CI sets FALLOW_CI_REQUIRE_DISTINCT_BASE=1 and refuses this shape instead.
```

**Why the local mode is permissive rather than strict.** `.husky/pre-commit` runs
`node scripts/pnpm-invocation.ts run fallow:ci`, and `pnpm run gates:static` runs
the same gate as one of its six steps, while on a branch whose first commit has not
landed yet `HEAD == main` by definition. A fatal check there would make every
branch's first commit impossible, and `AGENTS.md` forbids `--no-verify` — that is a
deadlock of the authoring loop, not a safety property. So the strictness is a
**declaration CI makes about itself**, not a property of the script: dropping that
one `env:` line would silently return CI to warn-and-proceed, which is why
`test/control-gates.test.ts` pins that this variable is set on exactly one step in
the whole of `.github/workflows/`, and to exactly `"1"`. The warning is emitted by
the script on stderr, so fallow's own `-q` cannot suppress it, and a developer still
learns that a pass over nothing was not a check.

The comparison lives in the shell script rather than the checker for the reason
above: the document cannot prove it. Four tests pin the four behaviours — base equal
to HEAD refuses with the variable set, base equal to HEAD warns and proceeds without
it, base older than HEAD proceeds, a report that names no base still fails closed —
in `test/ci/fallow-report-gate.test.ts`, each running the real script against a stub
analyzer in a scratch repository, so they do not depend on the git state of the
checkout running them.

**CI supplies that same local `main`, at the event's own base.** A CI checkout has
no local default branch, which is why this page once concluded the script had no CI
role. It now manufactures one: `actions/checkout@v4` with `fetch-depth: 0`, then one
step that installs, takes `BASE_SHA` from `github.event.before` on a `push` (the tip
of `main` before the push) or `pull_request.base.sha` on a pull request, detaches
HEAD, and runs `git update-ref refs/heads/main "$base"`. The detach comes first
because moving the checked-out branch moves HEAD with it, which produces exactly the
base-equals-HEAD shape refused above. An empty or all-zeros `BASE_SHA` — a branch's
first push — fails the step instead of falling back to `origin/main`: a base the
event did not name gates a changeset nobody asked about, and a red step is the honest
answer. So the base stays "the local default branch, and that is deliberate" in CI
too, with the local ref pointed at the commit the event itself named.

Creating that local ref is not belt-and-braces, it is the whole point, and the
failure it prevents was measured: `audit` names its base as the remote's default
branch and then reads the **local ref of that same name**, so a checkout whose
`refs/remotes/origin/HEAD` points at a branch with no local counterpart dies with
`could not determine changed files for base ref 'fix/…'. Verify the ref exists in
this git repository`, exit 2 — loud, which is the right failure, but it means the
gate cannot run at all until a local ref of the base's name exists. The step makes
sure `main` does, at the event's commit.

### A developer-machine gate that CI now runs too; the pinned action is gone

**This section used to say the opposite, and the earlier decision was right for its
premise.** It read: "`scripts/fallow-ci.sh` has no CI role: it is a developer-machine
gate. The `codebase-health` job in `.github/workflows/ci.yml` runs the pinned
`fallow-rs/fallow` action with `fail-on-issues: true` and never calls the script", and
its evidence was that `git grep -n 'fallow-ci\|fallow:ci' -- .github/ scripts/
package.json` returned no hit under `.github/`, while the only callers of
`scripts/check-fallow-report.mjs` were `scripts/fallow-ci.sh` and
`test/ci/fallow-report-gate.test.ts`.

That reasoning was sound, and it is kept here rather than deleted, because it is still
the reason the base is what it is. The script's comparison base is the **local**
`main`, and on this clone `origin/main` was `8203862`, far behind it — a remote-based
base hands a long stretch of history to the current changeset and reddens an untouched
tree with twenty introduced clone groups ("Where `audit` gets its base" above). A CI
checkout offered no local `main` and no cheap way to manufacture one, so a CI role for
the script was correctly declined. Nobody was being timid: the alternative on the table
really was a gate that compared against the wrong commit.

**The first push removed the premise.** `origin/main` now reads `8955d061`, identical
to local `main`, so the constraint that made a CI role impossible expired — and the
conclusion expired with it.

**What CI runs now.** `codebase-health` runs `pnpm run fallow:ci`: the same script a
laptop runs, so the two cannot drift into "similar but not the same", which is the whole
failure this change undoes. The grep that used to prove there was no CI role
now returns one — `git grep -n 'fallow:ci' -- .github/` hits the job's own step and its
rationale comment — and it is the only root-scope fallow invocation in a workflow. The raw command it used to run — the pinned
action's `fail-on-issues: true` over the full tree — failed on inherited debt: run
`43140640639`, "Fallow found 204 issues", measured back as **204 = 197 dead-code + 6
dupes + 1 health in a tree with no `node_modules`**, 169 of them `unresolved_imports`
because the job never installed and every workspace import resolved to nothing — against
**46** on the same tree with dependencies installed. Two things the script needs that
that job never provided: `node_modules` (`scripts/fallow-ci.sh` runs
`./node_modules/.bin/fallow`) and full history plus a local `main` (`fetch-depth: 0`, then
the `git update-ref` in the section above).

**Provisioned, not assumed.** The job sets up its own toolchain the way its sibling jobs
do — `pnpm/action-setup@v4` (which resolves `packageManager` from the root manifest), then
`actions/setup-node@v4` with `node-version: 24` and `cache: pnpm` — and only then runs
`pnpm install --frozen-lockfile` followed by `pnpm run fallow:ci`. That is deliberate
rather than ceremony: `corepack pnpm` would have depended on what the runner image happens
to ship, and a REQUIRED CHECK whose package manager is an assumption about a third-party
image is not a check you can reason about. With the two actions, the pnpm that installs is
the pnpm that gates, it is the one `package.json` pins, and `AGENTS.md`'s "Node 24 only"
rule is enforced by `setup-node` instead of hoped for.

One nuance, so the grep is not misread: `.github/workflows/ci.yml:146` also runs
`pnpm run fallow:kg`, but that is the different, KG-scoped gate with its own baselines
(see "Baselines" above) and it shares no code with this one. (That citation read `:90`,
then `:101`, and is corrected here again to the step's real line — recorded each time so
a moved step is not mistaken for a new gate.)

**The warning has inverted.** It is no longer "do not restore CI parity by accident";
parity is the design. The danger now is the opposite one: **CI running a gate whose base
it did not actually establish**, which reports a pass over nothing. Two guards stand
against that: the step fails when the event carries no usable base SHA, and under
CI's `FALLOW_CI_REQUIRE_DISTINCT_BASE=1`, `scripts/fallow-ci.sh` exits 2 when the base it
would attribute against already contains everything HEAD has — the `main` equal to HEAD
case and the `main` ahead of it case alike. The second guard exists because the first was
not enough.

**Honest limit, stated rather than papered over:** none of the CI side is verified from
here — `gh` is absent and the API returns 403 for logs — so this page claims no green
run. The first post-fix push is the real test of the wiring above.

### The touched-file residual

Root keeps **no** baselines, so a pre-existing finding **inside a file your diff
touches** is attributed as introduced, the same way it would be at KG scope with
its three baseline files removed — and with these numbers that residual is inert
today and becomes noisy the moment root-scope debt appears: root's
pre-existing surface is currently zero dead code (`check.total_issues = 0`), zero
above-threshold complexity (`health.summary.functions_above_threshold = 0`) and 20
dupe clone groups that fallow itself does not treat as above threshold
(`fallow config -r .` → `duplicates.threshold: 0.0`), so a baseline set mirroring
`packages/llmwiki-kg/ts/baselines/` is the separate delivery named in the
out-of-scope list below.

## Explicitly out of scope, and named so they cannot be read as solved

- The repo-wide gate reads `audit`'s attribution and nothing else, so root scope
  still has no dead-code, health or dupes baseline of its own — see the residual
  in the section above. Baselining the root scope is a separate delivery.
- Coverage verdicts are no longer counted locally: the old checker read them from
  the combined report's `health.runtime_coverage.findings`, which the `audit`
  document does not carry. Runtime coverage is licence-gated and informational
  (it does not change an exit code), and nothing in CI gates on it either: the
  pinned `fallow-rs/fallow` action and its `fail-on-issues` input are gone, and
  `codebase-health` now runs `pnpm run fallow:ci`, whose checker reads the
  `attribution` block only.
- The pre-existing repo-wide findings that come from unbuilt `dist/` imports are
  not this gate's concern any more, because it only counts findings it attributes
  to the changeset; `pnpm run build` is still what removes them from a full-tree
  run.
- `.husky/pre-commit` DOES run the root gate — `node scripts/pnpm-invocation.ts
  run fallow:ci`, the same script CI runs — so the root gate is not skippable
  locally. On a branch whose first commit has not landed yet it runs as the
  warning mode described above, because `HEAD == main` there by definition. It does
  not run `fallow:kg`, so the KG gate is still nobody's pre-commit obligation.
