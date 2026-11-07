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
npm run fallow:kg
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
  `npm run build` runs before this gate in the `build-and-test` job: 236 dead
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

`npm run fallow:kg` is
`fallow audit --gate new-only` scoped to the package, with the three baselines
applied.

- **Covers:** a new finding in any file the changeset touches inside the package.
  A newly added file (even untracked) is part of the changeset and is attributed
  as `introduced`.
- **Does not cover:** dead code created *without* touching its own file — for
  example, deleting the last consumer of an export in another file leaves that
  export dead in an unchanged file, and `audit` only analyzes changed files.
  `audit` is changeset-scoped by design, so the whole-tree baselines match zero
  current issues during an audit run (fallow warns about this on stderr; the
  script passes `-q`).
- **Untested false-positive risk: `dead_code_inherited` is always 0.** Because
  `audit` only analyzes changed files, it never sees the inherited whole-tree
  baselines, so *every* finding inside a touched file counts as `introduced`.
  A **pre-existing** KG finding that lives in a file the changeset happens to
  touch is therefore attributed `introduced` and fails the gate even though it
  is not new debt. Observed: every audit run so far reports
  `dead_code_inherited: 0` regardless of changed-file count. Not observed, and
  therefore genuinely untested: the false-positive itself — no test pins it, and
  reproducing it needs an edit to a file that already holds a baselined finding,
  so do not read this bullet as known-good behaviour. Expect it the first time
  someone edits a file holding a baselined unused export.
- The stronger whole-tree form was verified but is not wired in: for
  `fallow dead-code --baseline packages/llmwiki-kg/ts/baselines/dead-code-baseline.json`
  a clean tree exits 0 and a single new unused export exits 1 naming only that
  finding. Unlike `audit`, it needs no git base ref and sees the whole package.
  `health` and `dupes` do not fail on remaining findings from `--baseline`
  alone — they gate through `--min-score` and `--threshold` — so a chain of
  three would need per-analysis thresholds.

## Explicitly out of scope, and named so they cannot be read as solved

- `scripts/check-fallow-report.mjs:18` counts `functions_above_threshold`
  without consulting any baseline, so the repo-wide report gate is
  baseline-blind.
- That same checker tolerates `coverage_unavailable`/`unknown` verdicts.
- Six pre-existing repo-wide findings come from unbuilt `dist/` imports and are
  not this gate's concern; `npm run build` makes them disappear.
- `.husky/pre-commit` does not run fallow, so nothing forces either gate locally
  before a commit.
