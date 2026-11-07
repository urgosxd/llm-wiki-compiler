# fallow-kg-gate — package-scoped fallow gate for `packages/llmwiki-kg`

Closes the repo-wide `fallow` hole that let four KG deliveries ship with a
disclaimed health result, without importing KG's ~240 dead-code findings into
the root gate. Manager decision (C): a separate, package-scoped fallow config.

## Specs

- S1: "`packages/llmwiki-kg/ts/.fallowrc.json` with `"extends"` pointing at the root config (`../../../.fallowrc.json`)."
- S2: "the root config's `ignorePatterns` contains `"packages/llmwiki-kg/**"`. If that glob still matches when analysis is rooted at the package, the child config inherits its own erasure and reports 0 issues / exit 0 … Acceptance: the finished config must report **~350 files and ~246 dead-code findings**, maintainability ~90.3. If inheritance blanks it, neutralize it deliberately (`sealed: true`, or an explicit `ignorePatterns` override with the KG line removed) and say which you chose and why."
- S3: "An npm script `fallow:kg` invoking the pinned binary (`./node_modules/.bin/fallow`, never bare `npx fallow`) rooted at `packages/llmwiki-kg/ts`, wired to `fallow audit --gate new-only` with the three per-analysis baselines. **Per-analysis, never one global baseline**."
- S4: "The three baseline files committed beside the config: `dead-code`, `health`, `dupes`. Size them and record the entry counts."
- S5: "A one-line comment … stating that KG is excluded from the **repo-wide** gate on purpose and that its own gate lives at `packages/llmwiki-kg/ts/.fallowrc.json` via `npm run fallow:kg`. A reader who finds the ignore line must find its counterpart in the same breath." (Root config is strict JSON — see Step 4.)
- S6: "`npm run fallow:kg` → exit 0 on a clean tree, with the baseline applied and the file/finding counts above."
- S7: "**The gate must bite.** Introduce one new unused export in a scratch file inside the package … re-run, and require **exit 1** naming only that new finding."
- S8: "`npx tsc --noEmit`, `npm run typecheck:kg`, `npm run build` — with literal exits."
- S9: "record, in the feature document and the commit message, that the historical cause in `odd/tasks/kg-dimension.md:148-162` (the `drizzle` plugin) is **wrong at HEAD** and that the real mechanism is `packages/llmwiki-kg/ts/vitest.config.ts:3-7` hijacking repo-wide entry-point discovery (probe e2: ignoring only that file drops dead code 1084 → 247 and restores entry points to 1073)."

## Tasks

One work unit; every task ships in the single `chore(fallow):` commit named at
the bottom of this file.

- T1 · S1-S9 · route: inline · feature document (`odd/tasks/fallow-kg-gate.md`) · done
- T2 · S2, S9 · route: inline · empirical probes P0/P1/P2/P3 + repo-wide mechanism probe (all scratch state in `mktemp -d`) · done — results below
- T3 · S1, S2 · route: inline · child config `packages/llmwiki-kg/ts/.fallowrc.json` (`extends` only; P1 did not fire) · done
- T4 · S3, S4 · route: inline · `package.json` `fallow:kg` + three per-analysis baselines in `packages/llmwiki-kg/ts/baselines/` · done
- T5 · S5, S9 · route: inline · `docs/fallow-gates.md` counterpart note + one line in `docs/README.md` (root config is strict JSON and out of the edit surface) · done
- T6 · S6-S8 · route: inline · acceptance probes with literal exits, gate-bite proof, typecheck/build, repo-wide non-regression · done

## Results

### Probes

- **P0 (spec as written cannot run).** `extends` rejects absolute paths:
  `failed to load config '…/cfg.json': extends paths must be relative, got absolute path: …/.fallowrc.json (in …/cfg.json)`, exit 2. The probe was re-run with a relative `extends` path.
- **P1 (the trap did not fire).** Scratch config extending the root config, run
  with `--root packages/llmwiki-kg/ts`: 350 files analyzed, 239 total issues
  (236 dead code: 199 unused exports, 32 unused types, 1 unused file,
  4 duplicate exports; plus 1 unresolved import, 1 unlisted dependency,
  1 circular dependency), maintainability 90.4, 142 entry points, exit 0.
  The 239 was measured on an unbuilt tree; with the root `dist/` present the same
  run reports **238 total / 0 unresolved imports** (that one finding resolves
  through `dist/`), which is the CI figure — see `docs/fallow-gates.md`.
  Not 0 issues → no erasure, so no `sealed` and no `ignorePatterns` override.
  The delta from the 246 reference figure is explained by inheritance: the root
  `ignoreExports` entries and the `unused-class-members: off` override for
  `src/providers/*.ts` also apply here.
- **P2 (not needed).** P1 not firing means the plain `extends` config is the
  shipped config.
- **P3 (committable).** `git check-ignore -v packages/llmwiki-kg/ts/baselines/dead-code-baseline.json`
  prints nothing, exit 1 → not ignored. Packaged `.gitignore` ignores only
  `ts/node_modules/`, `ts/dist/`, `ts/coverage/`, `*.tsbuildinfo`.
- **Repo-wide mechanism probe (S9).** With the KG ignore removed and nothing
  else changed: total 1084, dead code 1075, entry points 303, 1829 files. Adding
  only `packages/llmwiki-kg/ts/vitest.config.ts` to `ignorePatterns`: total 247,
  dead code 238, entry points 1073, 1828 files. The `drizzle` plugin plays no
  part in either run; the vitest config's `test.include` hijacks repo-wide
  entry-point discovery.

### Shipped invocation

```
./node_modules/.bin/fallow --root packages/llmwiki-kg/ts -c packages/llmwiki-kg/ts/.fallowrc.json audit --format json --gate new-only --dead-code-baseline baselines/dead-code-baseline.json --health-baseline baselines/health-baseline.json --dupes-baseline baselines/dupes-baseline.json -q
```

Channel chosen: the S3 `audit --gate new-only` form. The mid-flight fallback to
a per-analysis `&&`-chain was **not** needed — `new-only` bites on an untracked
probe file (exit 1, `dead_code_introduced: 1`), so no `git add -N` was needed
either. Known limitation and the verified whole-tree alternative are recorded in
`docs/fallow-gates.md` under "What this gate does and does not cover".

Acceptance: clean tree → exit 0 (verdict `pass`, all attribution counters 0);
`src/__fallow_probe__.ts` containing `export const fallowGateProbe = 42;` →
exit 1 (verdict `fail`), the only finding being
`unused_files[0].path = "src/__fallow_probe__.ts"` with `"introduced": true`.

Baselines: `dead-code` 12,977 bytes / 239 entries; `health` 2,285 bytes /
19 findings across 13 files (17 file+severity keys) and 16 target keys;
`dupes` 22,201 bytes / 184 clone groups.

### Checks

- `npm run fallow:kg` (clean) → exit 0 · (probe present) → exit 1
- `npx tsc --noEmit` → exit 0 · `npm run typecheck:kg` → exit 0, "349 files checked; 0 diagnostics … no regression" · `npm run build` → exit 0
- `npm run test:affected` → exit 0, escalated to "full unit tier — package-lock.json affects the whole suite": 825 files passed, 3 skipped; 6236 tests passed, 4 skipped
- `./node_modules/.bin/fallow --root . --format json` → exit 0, `check.total_issues` 0, maintainability 91.1, 1479 files. The expected 6 `unresolved_imports` for unbuilt `dist/` are absent because `npm run build` had just run; the root gate still ignores KG (1829 files with KG vs 1479 without).

## Log

- L1 (manager decision, verbatim): "DECISION: (C) — a separate, package-scoped fallow configuration for KG. Implement it." plus: "Those are separate deliveries and I want them named in your close so they cannot be mistaken for solved" and the out-of-scope list: `scripts/check-fallow-report.mjs:18` baseline-blind `functions_above_threshold`; its ignored `coverage_unavailable`/`unknown` verdicts; the 6 unbuilt-`dist/` findings; `.husky/pre-commit` not being a gate.
- L2 (mid-flight constraint from the manager, verbatim key lines): "`git status` currently contains ` M .github/workflows/ci.yml` — a different writer's verified change, deliberately uncommitted. It is NOT yours." · "**Never `git add -A` / `git add .`**" · "`new-only` attributes findings against a **changeset** (git base ref vs working tree). An *untracked* probe file is invisible to `git diff`, so `npm run fallow:kg` may return **exit 0 even with the probe present**." · "If `new-only` still cannot bite locally, switch to a per-analysis gated invocation that needs **no changeset**" · "**Hard requirement either way:** clean tree → **exit 0**; probe present → **exit 1 naming only the probe finding**; **per-analysis baselines, never one global `--baseline`**." Outcome: `new-only` does bite on an untracked file, so the S3 form shipped unchanged; the whole-tree `fallow dead-code --baseline` form was measured as well (clean 0, probe 1) and documented as the stronger alternative.
- L3 (decision record): docs note placed at `docs/fallow-gates.md` plus one line in `docs/README.md`, because the root `.fallowrc.json` is strict JSON (`additionalProperties: false`, no comment or `$comment`) and is outside this work unit's edit surface.
- L4 (evidence, commit shas): the gate work unit shipped in `c04205c`
  (`chore(fallow): add package-scoped gate for llmwiki-kg`) — the package config,
  the three per-analysis baselines, the `fallow:kg` script, and the docs note. The
  CI wiring (`- run: npm run fallow:kg`, immediately after the `typecheck:kg` step
  in `build-and-test`) shipped in `3a7415d`
  (`ci(fallow): run the KG fallow gate in build-and-test`). Both shas are
  **post-replay reissues** of the same two work units, which were first committed
  as `2687084` and `4332412`; the content is identical apart from the
  `C1`-`C5` doc-accuracy corrections.
- L5 (replay, evidence): both work units were replayed onto
  `819f51e4a1da4367aa6187fb12f624c0c807ea69` (`docs(odd): record the follow-ups
  from the contributing removal`). The replay was **clean, with no conflict**: the
  base's new 13-line verified comment block above the `codebase-health` job and
  this delivery's single `- run: npm run fallow:kg` line inside `build-and-test`
  do not textually overlap. The comment block survives byte-identical
  (`.github/workflows/ci.yml:103-115`) and the only diff against the base in that
  file is the one added line (`+      - run: npm run fallow:kg`, at `:90`), with
  zero deletions anywhere in the workflow.
- L6 (decision, verbatim intent): doc-accuracy corrections `C1`-`C5` from an
  independent verification pass — the state-dependent KG issue count (238 total /
  0 unresolved with `dist/` built, 239/1 unbuilt), the approximate comparative
  table totals and entry points, two misquoted error strings and their channels,
  the new `dead_code_inherited: 0` false-positive risk, and the decision below.
- L7 (decision, C5): **no durable test was added.** The verifier proposed
  `test/fallow/kg-gate.test.ts` shelling out to `npm run fallow:kg`. Rejected
  because `fallow:kg` runs `audit --gate new-only`, which resolves a git base ref
  (`base_ref` in its JSON report); `npm test` runs in CI checkouts where that ref
  may not resolve, and `audit` then exits 2, which would make the suite flaky on
  infrastructure rather than on code. Follow-up, not in scope here: if a durable
  gate test is ever wanted, put it at `test/fallow/kg-gate.test.ts` against the
  whole-tree `fallow dead-code --baseline …` form, which needs no git base ref and
  was already verified to exit 0 clean / 1 on a single introduced unused export.
