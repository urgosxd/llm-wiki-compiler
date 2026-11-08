# Control-gates feature — phase 0 of the monorepo control repair

Make the rules `AGENTS.md` already states actually enforced, in CI, from a fresh checkout. Scope is the **control layer**, not the install topology: no pnpm migration, no task orchestrator. Baseline commit `dc1ba78`; canonical rule file `AGENTS.md`.

## Specs

S1. `AGENTS.md:93` requires `npx tsc --noEmit`; no CI step runs it — `grep -rn 'tsc' .github/workflows/` matches comments only (`ci.yml:83-84`). CI must gain a root `npx tsc --noEmit` step.

S2. `AGENTS.md:96` requires `npm run test:affected`; no CI step runs it either. CI must gain a `npm run test:affected` step.

S3. No CI job may be renamed and no job may be added. Branch protection is keyed on job names `build-and-test (24)`, `codebase-health`, `test-typecheck`; a new job name is unprotected, so a red gate there could be merged past. Every new gate is a **step** inside an existing job. The job keys must be proven identical before and after (quote them, and show the parsed-key diff is empty).

S4. `AGENTS.md` becomes the single source of truth for the gate list. Three documents currently carry contradictory gate lists: `AGENTS.md:89-100` (5 gates), `CLAUDE.md:58-66` (4, omitting `typecheck:tests`), `README.md:442-445` (names `npm run fallow:ci`, which `docs/fallow-gates.md:262` says has no CI role).

S5. `CLAUDE.md` is removed. First read it in full and report anything it states that `AGENTS.md` does not. If there is unique content, move it into `AGENTS.md` first, then delete `CLAUDE.md` in a separate commit that names what was relocated. If nothing is unique, say so plainly and delete it. Removal is explicitly wanted by the human.

S6. `README.md`'s developer-facing pre-commit list must state the same gates as `AGENTS.md`, in the same order, and must not silently omit any of them. `docs/fallow-gates.md:260-265` defines `npm run fallow:ci` as a developer-machine gate with no CI role — the `codebase-health` job runs the pinned `fallow-rs/fallow` action instead — so naming `fallow:ci` in a local pre-commit list is correct; the defect at `README.md:442-445` was that it listed four commands and omitted `npm run typecheck:tests` and `npm run test:affected`.

S7. Introduce ESLint (flat config) enforcing the house rules the audit found unenforced — `AGENTS.md` requires files <400 lines and functions <40 lines, and no linter exists anywhere (no eslint/biome/prettier config, no `lint` script) — with at minimum: `max-lines` (400, comments excluded where the rule allows) for code files, `max-lines-per-function` (40), `@typescript-eslint/no-explicit-any`, and a dependency boundary rule: root `src/` must not import `packages/llmwiki-kg/**` internals except through the declared barrel `packages/llmwiki-kg/ts/src/core-index.ts`, and the KG package must not import root `src/`.

S8. The linter must be a **ratchet**, not a hard fail: this codebase has violations today, so a hard-fail linter would be red immediately and become the next permanently-red gate — the exact rot being fixed. It must run clean on `main` today and fail only on newly introduced violations. `npm run typecheck:tests` with its frozen baseline (`260 diagnostics in 94 files`) is the house precedent; follow the same shape (`scripts/typecheck-tests.ts`, `kg-typecheck-baseline.json`).

S9. State the baseline size honestly: how many violations are frozen, broken down by rule, and in how many files.

S10. RED first for the linter ratchet: introduce one violation of each rule (a 401st line, a 41-line function, `any`, a forbidden cross-boundary import), show each fails, then remove them.

S11. The CI wiring must be proven well-formed: YAML parses, job keys unchanged, step order sane. CI cannot be executed here — say exactly that and give the YAML added.

S12. These must be run with literal exit codes recorded: `npx tsc --noEmit`, `npm run build`, `npm run typecheck:tests`, `npm run typecheck:kg`, `npm run fallow:ci` (must be exit 0), `npm run test:affected`.

S13. ESLint packages are pinned to exact versions (no `^`/`~`), because a ratchet whose rules change under a caret bump is not a ratchet. The `package-lock.json` diff must be proven additions-only; if any existing dependency's version moves, stop and report.

S14. Hard prohibitions: no history rewriting, no `git push`, no `--no-verify`, no `rm -rf` of tracked paths, no job renames, and do not touch `.fallowrc.json`, `tsconfig*.json`, `package-lock.json` dependency versions, or `scripts/test-partition.ts` (a separate delivery owns those).

S15. Enforcement today is local-only and therefore advisory: the gates live in `.husky/pre-commit` (`npx fallow`, `npx tsc --noEmit`) and `.husky/pre-push` (`npm run build`, `npm run test:affected`), `npm ci` reconstitutes `.husky/_` through `prepare: husky`, and any `--no-verify` bypasses both. The hook set is also partial even when correctly installed: no pre-commit test type-check and no pre-commit `test:affected`. The CI step is what makes a local habit into a gate.

## Tasks

T0. Repair the git hook dispatch layer and repoint the pre-commit fallow gate at the baselined run. Spec: S1, S15. commit: 63b9280
T1. Create this feature document and its Engram mirror. Spec: S1-S15 (tracking artefact). commit: 63b9280 (same commit as T0 — see L7)
T2. Add the missing gate steps to CI without renaming any job. Spec: S1, S2, S3. commit: 7ffa259
T3. Make `AGENTS.md` canonical: relocate any unique `CLAUDE.md` content, then delete `CLAUDE.md` in its own commit. Spec: S4, S5. commit: 0feb290 (gate 5 correction), 6acf89e (CLAUDE.md deletion)
T4. Correct the `README.md` gate list so it no longer advertises `fallow:ci` as a gate. Spec: S6. commit: 846a129
T5. Add the ESLint ratchet: flat config, boundary rule, pinned devDependencies, additions-only lock proof, honest baseline census, RED/GREEN per rule. Spec: S7, S8, S9, S10, S13. commit: TBD
T6. Wire the lint ratchet into CI as a step in an existing job. Spec: S1, S3, S7, S10. commit: TBD
T7. Final gate sweep and delivery evidence. Spec: S11, S12. commit: TBD

## Log

L1 (human's original request, verbatim):

Project assignment for branch chore/control-gates-ci:

FASE 0 OF A MONOREPO CONTROL REPAIR, AUTHORIZED BY THE HUMAN. Your delivery is the **control layer**, not the topology: make the repository's stated rules actually enforced, in CI, from a fresh checkout. Do not migrate to pnpm or an orchestrator — that is a later phase.

Repo: llm-wiki-compiler. Read `AGENTS.md` at the repo root first.
Node 24 ONLY: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>`. Run `npm ci` in your worktree (lockfile pinned, `node_modules` gitignored) — hooks and tooling need it.

## Why this exists (measured, quoted from a read-only audit)
- `AGENTS.md:93` requires `npx tsc --noEmit`; **no CI step runs it** (`grep -rn 'tsc' .github/workflows/` → comments only, `ci.yml:83-84`). Its only home is `.husky/pre-commit:2`, and `.husky/_` does not exist, so hooks are inert in any worktree that did not run `npm ci`.
- `AGENTS.md:96` requires `npm run test:affected`; **no CI step runs it** either.
- `AGENTS.md` requires files <400 lines and functions <40 lines; **no linter exists anywhere** (no eslint/biome/prettier config, no `lint` script), so that rule is unenforced prose.
- Three documents carry contradictory gate lists: `AGENTS.md:89-100` (5 gates), `CLAUDE.md:58-66` (4, omitting `typecheck:tests`), `README.md:442-445` (names `npm run fallow:ci`, which `docs/fallow-gates.md:262` says has no CI role).

## Scope — exactly these four things
**1. CI gains the missing gates, without renaming any job.**
Add a root `npx tsc --noEmit` step and a `npm run test:affected` step to `.github/workflows/ci.yml` in a job whose name you do **not** change. Branch protection is keyed on job names (`build-and-test (24)`, `codebase-health`, `test-typecheck`) — renaming or adding a *job* risks silently un-gating `main`, so prefer adding **steps** to existing jobs. Quote the job keys before and after and show the parsed-key diff is empty.

**2. One source of truth for the gate list.**
`AGENTS.md` becomes canonical. The human explicitly wants `CLAUDE.md` **removed**, so: first read `CLAUDE.md` in full and report anything it states that `AGENTS.md` does not — if there is unique content, move it into `AGENTS.md` first, then delete `CLAUDE.md` in a separate commit that names what was relocated. If nothing is unique, say so and delete it. Then fix `README.md:442-445` so it no longer advertises `fallow:ci` as a gate.

**3. A linter that enforces the house rules the audit found unenforced.**
Introduce ESLint (flat config) with, at minimum:
- `max-lines` for code files (400, comments excluded where the rule allows) and `max-lines-per-function` (40);
- a **dependency boundary** rule: root `src/` must not import `packages/llmwiki-kg/**` internals except through the declared barrel (`packages/llmwiki-kg/ts/src/core-index.ts`), and the KG package must not import root `src/`;
- `@typescript-eslint/no-explicit-any` — the ported `AGENTS.md` rule.
**This codebase has violations today, so a hard-fail linter would be red immediately and become the next permanently-red gate — the exact rot we are fixing.** So it must be a **ratchet**: run clean on `main` today and fail only on newly introduced violations. `npm run typecheck:tests` with its frozen baseline (`260 diagnostics in 94 files`) is the house precedent — study it (`scripts/typecheck-tests.ts`, `kg-typecheck-baseline.json`) and follow the same shape. State the baseline size honestly: how many violations are frozen, by rule, and in how many files.

**4. Prove all of it bites.**
- RED first for the linter ratchet: introduce one violation of each rule (a 401st line, a 41-line function, `any`, a forbidden cross-boundary import), show each fails, then remove them.
- Prove the CI wiring is well-formed: YAML parses, job keys unchanged, step order sane. You cannot execute CI here — say exactly that and give the YAML you added.
- `npx tsc --noEmit`, `npm run build`, `npm run typecheck:tests`, `npm run typecheck:kg`, `npm run fallow:ci` (must be exit 0 — the local fallow gate was fixed today) and `npm run test:affected`. Literal exits.

## Hard prohibitions
No history rewriting, no `git push`, no `--no-verify`, no `rm -rf` of tracked paths, no job renames, do not touch `.fallowrc.json`, `tsconfig*.json`, `package-lock.json` dependency versions, or `scripts/test-partition.ts` (a separate delivery owns those). If a native prompt parks, name the pane and stop.

## Report
The audit claim you verified or refuted for each of the four items; what `CLAUDE.md` uniquely held and where it went; the exact YAML added with job keys before/after and the parsed-key diff; the full ESLint rule set with the frozen baseline counts by rule and file count; the RED evidence per rule then GREEN; every gate exit; commit SHAs; `git status --short`; and a `Risk:` line using item 1 data/irreversible, 2 security, 3 contracts others consume, 4 concurrency, 5 delivery/environment, 6 no test would catch a regression — or `Risk: none`. Item 5 applies: this changes delivery/CI surface and the gate semantics a whole team relies on.

L2 (Manager, on the additive devDependency reading): authorized, on three conditions — pin exact versions for `eslint` and `@typescript-eslint/*` and state them; prove the lock diff is additions-only (`git diff -U0 package-lock.json | grep -E '^[-+].*"version"'`, every `-` must be a package that does not exist); prove `npm ci` from a clean `node_modules` still succeeds. Note: `package-lock.json` is in `GLOBAL_SCOPE_PATHS` (`scripts/test-affected.ts:31-37`), so `test:affected` escalates to the full unit tier on this branch — correct behaviour, to be stated rather than treated as a surprise.

L3 (Manager, adopting the rephrased mechanism): the gates exist only as local hooks and a fresh checkout reproduces them on install; CI cannot see a violation that bypassed the hook. Two additions: even a correctly installed worktree has a partial hook set (no pre-commit test type-check, no pre-commit `test:affected`), and any `--no-verify` bypasses both — a local-only gate is advisory by construction; the CI step is what makes it a gate. Recorded as S15.

L4 (Manager, constraint): the linter must land in CI as a step inside an existing job, never as a new job, because branch protection is keyed on job names. Recorded in S3 and S7.

L5 (incident, recorded by the Lead after T1's first commit attempt). The Lead's environment probe ran `husky --version` to identify the binary. Husky v9's bin treats its first argument as the hook directory, so that call created a literal `--version/_` tree in the worktree and rewrote `core.hooksPath` from `.husky/_` to `--version/_` in the SHARED clone config — breaking `git commit` for every worktree of this clone for the duration (`sh: 0: Illegal option --`, dash exit 2) before any hook body ran. Repair: the artifact was relocated out of the tree to `/tmp/husky-version-artifact-1794100539` (not deleted) and `core.hooksPath` restored to `.husky/_`, verified from the primary checkout `/home/urgosxd/Desktop/ofk/llm-wiki-compiler` as well as from this worktree.

L6 (fifth control-layer defect, found while diagnosing L5; the audit missed it). `.husky/pre-commit` ran bare `npx fallow`, which exits 1 on pre-existing debt (`Failed: dead-code (6 issues), dupes (20 clone groups)`). In any correctly installed worktree that blocked every commit and made every other gate bypassable with `--no-verify`: this is the mechanism — not merely a red gate — by which the rest of the gate list turned advisory. The hook now calls `npm run fallow:ci` (exit 0, `verdict: pass`, `--gate new-only` against the local `main` ref, all `*_introduced` and `*_inherited` attribution counts 0) with a comment recording why it must never be "simplified" back to `npx fallow`. The 6 dead-code issues and 20 clone groups are deliberately left in place: repairing them is out of scope and `.fallowrc.json` is prohibited.

L7 (commit anomaly, accepted without rewrite). Commit `63b9280` carries both `.husky/pre-commit` and this document, because this document was already staged when the hook-repair commit ran and `git commit -m` commits the whole index; the message names only the hook fix. Separating them requires a history rewrite, which S14 prohibits, so the anomaly stands and T0/T1 share that SHA.

L8 (requirement correction, from T4's evidence). S6 as first written required `README.md` to stop advertising `npm run fallow:ci` as a gate. That premise is false: `docs/fallow-gates.md:260-265`, under the heading "A developer-machine gate; CI is the pinned action", states that `scripts/fallow-ci.sh` has no CI role and that the `codebase-health` job runs the pinned `fallow-rs/fallow` action instead — so `fallow:ci` is the developer-machine gate and belongs in README's local list, which `AGENTS.md` gate 5 also now names after commit `0feb290`. `grep -n 'fallow' .github/workflows/ci.yml` confirms CI never calls the script (`npm run fallow:kg` and the `fallow-rs/fallow@5cc7152` action only). The genuine README defect was the silent omission of `npm run typecheck:tests` and `npm run test:affected`; S6 was rewritten to that meaning and T4 (`846a129`) implemented it. Two further facts recorded here: `CLAUDE.md` held no unique content (a strict subset of `AGENTS.md`, proved by normalised-line-set diff; nothing was relocated, deletion commit `6acf89e`), and CI gained its two missing steps in `7ffa259` with the parsed `jobs:` key set byte-identical before and after (`['build-and-test','codebase-health']`, plus `['test-typecheck']` in `typecheck-tests.yml`), so no branch-protection check name moved.
