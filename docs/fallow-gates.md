# fallow gates: repo-wide vs. the KG package

Maintainer reference. This page is repo-facing (plain `.md`, not published on the
Mintlify site) and exists because the root `.fallowrc.json` is strict JSON that
cannot carry a comment.

## The counterpart of the ignore line

The root `.fallowrc.json` lists `packages/llmwiki-kg/**` under `ignorePatterns`.

**That exclusion is deliberate.** `packages/llmwiki-kg/ts` is a vendored
TypeScript port (`aks-reference-server`) whose HTTP handlers and helpers are
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
`main` being the checkout's real reference, and that is deliberate: on this clone
`origin/main` is `8203862`, a ref far behind local `main` (how far is itself a
moving counter — measure it with the command below), so a remote-based base hands
a long stretch of history to the current changeset and turns the gate red on an
untouched tree for reasons nobody can fix.

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
`attribution.gate` other than `new-only`. The gate goes red on an unverifiable
report, never silently green.

### A developer-machine gate; CI is the pinned action

`scripts/fallow-ci.sh` has no CI role: it is a developer-machine gate. The
`codebase-health` job in `.github/workflows/ci.yml` runs the pinned
`fallow-rs/fallow` action with `fail-on-issues: true` and never calls the script.
Measured: `git grep -n 'fallow-ci\|fallow:ci' -- .github/ scripts/ package.json`
returns no hit under `.github/`, and the only callers of
`scripts/check-fallow-report.mjs` are `scripts/fallow-ci.sh` and
`test/ci/fallow-report-gate.test.ts`. This is written down so nobody "restores CI
parity" by reintroducing a path the script no longer needs — there is no CI role
to keep parity with. One nuance, so the grep is not misread:
`.github/workflows/ci.yml:90` does run `pnpm run fallow:kg`, but that is the
different, KG-scoped gate with its own baselines (see "Baselines" above) and it
shares no code with this one — "CI runs a `fallow:*` script" is true of the KG
gate and false of the root gate.

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
  (it does not change an exit code), and CI's `fail-on-issues` does not gate on it
  either.
- The pre-existing repo-wide findings that come from unbuilt `dist/` imports are
  not this gate's concern any more, because it only counts findings it attributes
  to the changeset; `pnpm run build` is still what removes them from a full-tree
  run.
- `.husky/pre-commit` does not run fallow, so nothing forces either gate locally
  before a commit.
