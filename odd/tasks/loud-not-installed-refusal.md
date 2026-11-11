# loud-not-installed-refusal

Branch `fix/loud-not-installed-refusal`, base `main` = `fa9c1f5856a031a2eac4ba3805a2e75ef5dd18f6`.
Turn a confusing downstream test failure into a loud, named refusal that tells the reader the exact command to run.

## Specs

S1. A checkout that was not installed with pnpm must refuse at session start, before the first confusing failure. Today such a checkout fails collection with `Cannot find package '@repo/kg/testing/per-run-database'` — a message that names an internal workspace export and tells the reader nothing about the real problem.

S2. The refusal detects exactly two states, both cheap and both inside the project: (a) **not a pnpm tree** — `node_modules/.package-lock.json` exists (an npm-created tree), or `node_modules/.pnpm` is absent; (b) **workspace links missing** — any of `node_modules/@repo/api`, `node_modules/@repo/foundation`, `node_modules/@repo/kg`, `node_modules/@repo/wiki` is absent.

S3. The refusal message must name **what was found**, **what it means**, and **the command**: `corepack pnpm install --frozen-lockfile`.

S4. The message must not tell the reader to delete `node_modules`. Verbatim: "Do not tell the reader to delete `node_modules` — a fix that begins with destruction is not a fix."

S5. Detection is a pure function in its own module — input: the set of paths/links present; output: a verdict plus the message — and `test/global-setup.ts` calls it. The check runs before the first confusing failure, and `test/global-setup.ts` is the seam because that is where the suite already prepares global state.

S6. A healthy tree — all four `@repo/*` links present, `.pnpm` present, no `.package-lock.json` — must **not** refuse. Verbatim: "a check that fires on a correct tree makes every session red."

S7. Test-first, one RED per requested rule, asserted through the public function and never by rendering the hook:
- not-a-pnpm-tree (`.package-lock.json` present) refuses, and the message contains the command;
- workspace links missing (one of the four absent) refuses, and the message names the missing one;
- a healthy tree does not refuse. Verbatim: "This one matters most".
`Assert the exact message content, not merely that it throws.`

S8. Do not regress the correct tree. After the change, run the suite's affected scope on a correctly installed tree and confirm no new failure. Verbatim: "If any global-state-dependent test changes behaviour, that is a regression to fix, not to explain."

S9. Housekeeping: update the docs and `AGENTS.md` that describe session setup so the command appears where a new reader will look. If a file addition moves any census or inventory count, regenerate it in the same commit.

S10. Scope: the file set is reported before writing, and the work stops and reports above ~8 files. The seven harnesses with `""`-initialised context fields are out of scope — `confinement-roots.ts:36`, `command-project.ts:9`, `compile-project.ts:67`, `lint-temp-root.ts:74`, `okf-temp-dir.ts:29`, `seed-pages-harness.ts:29`, `temp-root.ts:93` — a recorded latent hazard and a separate task.

## Tasks

- T1 — author this feature document (S1-S10) — done when written
- T2 — pure detector module `test/fixtures/install-preflight.ts` plus its RED tests `test/install-preflight.test.ts` (S2, S5, S6, S7)
- T3 — wire the refusal into `test/global-setup.ts` as the first statement of `setup()`, deferring the workspace-reaching imports (S1, S5)
- T4 — docs: `AGENTS.md` and `docs/turborepo.md` session-setup text (S3, S9)
- T5 — gates and the correct-tree differential (S8) — verifier

## Log

L1 — the Manager's assignment, verbatim:

> Project assignment for branch fix/loud-not-installed-refusal:
>
> Turn a confusing downstream test failure into a loud, named refusal that tells the reader the exact command to run.
>
> Repo: llm-wiki-compiler, base `main` = **`fa9c1f5856a031a2eac4ba3805a2e75ef5dd18f6`**. Read `AGENTS.md`. Node 24 ONLY: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>`. pnpm; bare `pnpm` exits 127, use `corepack pnpm`. `maxWorkers` 4.
>
> ## The measured symptom
>
> A checkout that was not installed with pnpm fails the test suite with:
>
> ```
> Cannot find package '@repo/kg/testing/per-run-database'
> ```
>
> That message names an internal workspace export and tells the reader nothing about the real problem. Root cause, measured: `/home/urgosxd/Desktop/ofk/llm-wiki-compiler` carried `node_modules/.package-lock.json` — an **npm-installed tree from Nov 5** — so `node_modules/@repo/{api,foundation,kg,wiki}` never existed. `corepack pnpm install --frozen-lockfile` fixed it in 1.6 s (`Packages: +3 -73`), lockfile sha256 unchanged.
>
> **This will recur.** Five worktrees plus `/tmp` clones still have no `node_modules` or a stale one, so every future session meets the same misleading error.
>
> ## What to build
>
> A session-start refusal with a diagnosis and the fix in the message, instead of an error naming an internal export. Two detectable states, both cheap and both inside the project:
>
> 1. **Not a pnpm tree**: `node_modules/.package-lock.json` exists (npm-created tree) or `node_modules/.pnpm` is absent.
> 2. **Workspace links missing**: any of `node_modules/@repo/{api,foundation,kg,wiki}` unresolvable.
>
> The message must name **what was found**, **what it means**, and **the command**: `corepack pnpm install --frozen-lockfile`. Do not tell the reader to delete `node_modules` — a fix that begins with destruction is not a fix.
>
> Place the check so it runs **before** the first confusing failure — `test/global-setup.ts` is the natural seam, since that is where the suite already prepares global state.
>
> ## Testability is a design constraint, not an afterthought
>
> A `globalSetup` hook cannot be observed RED by a normal test. So **extract the detection into a pure function in its own module** — input: the set of paths/links present; output: a verdict plus the message — and have `global-setup.ts` call it. Then the rule is testable through a public function with no filesystem invention.
>
> Test-first, one RED per requested rule:
> - not-a-pnpm-tree (`.package-lock.json` present) → refuses, message contains the command;
> - workspace links missing (one of the four absent) → refuses, names the missing one;
> - a healthy tree (all four links, `.pnpm` present, no `.package-lock.json`) → **does not refuse**. This one matters most: a check that fires on a correct tree makes every session red.
>
> Assert the exact message content, not merely that it throws. Assert through the public function, never by rendering the hook.
>
> ## Do not regress the correct tree
> After the change, run the suite's affected scope on a **correctly installed** tree and confirm no new failure: `npm run test:affected`, and `npx vitest related test/global-setup.ts` first. If any global-state-dependent test changes behaviour, that is a regression to fix, not to explain.
>
> ## Housekeeping a change like this owes
> - Update the docs/`AGENTS.md` that describe session setup so the command appears where a new reader will look — the help/doc text must describe what the code now does.
> - If you add a file such that any census or inventory count moves, regenerate it **in the same commit**. A derived number must never describe a tree that no longer exists.
>
> ## Scope
> Report the file set before writing; **stop and report above ~8 files**. Do not touch any of the seven harnesses with `""`-initialised context fields (`confinement-roots.ts:36`, `command-project.ts:9`, `compile-project.ts:67`, `lint-temp-root.ts:74`, `okf-temp-dir.ts:29`, `seed-pages-harness.ts:29`, `temp-root.ts:93`) — they are a recorded latent hazard and a separate task.
>
> ## Gates
> `npx tsc --noEmit` · `npm run typecheck:tests` · `npm run lint` (ceiling **`558 baseline violations in 396 files across 423 rule/file entries`**; a decrease needs `npm run lint:update`, an increase is forbidden) · `npm run fallow:ci` · `npm run test:affected` (report its literal exit; **78 is the documented full-tier decline**, not a failure) · `npm test` if your change reaches suite-wide state, with its **literal exit code** and the load average. Database freshly provisioned, `TESTCONTAINERS_REUSE_ENABLE=false`, `LLMWIKI_TEST_ALLOW_NO_DATABASE` never set.
>
> ## Hard prohibitions
> No history rewriting, no `--amend`, no `--no-verify`, no `HUSKY=0`, no hook bypass of any kind, no `cp -a` of this worktree, no push. `odd/tasks/**` append-only. Leave `/tmp` scratch in place.
>
> ## Report
> The file set; the RED you observed for each rule and the healthy-tree green; the exact refusal message verbatim; the differential result on a correct tree; every gate exit literal with the lint triple and the suite exit code plus load; full 40-character SHAs; `git status --short`; and a `Risk:` line — **item 6** is the live one, because a session-start check that fires on a healthy tree converts a confusing failure into a universal one.

L2 — reconnaissance evidence, recorded before any source write. `test/global-setup.ts` is a vitest `globalSetup` module exporting `setup()` and `teardown()`; it statically imports `./fixtures/testcontainers-postgres.js`, whose chain reaches `test/fixtures/container-server-primitives.ts:38` `from "@repo/kg/testing/per-run-database"` — the exact specifier in the misleading error. That import chain fails at module load, before `setup()` runs, so the refusal module must be dependency-free (Node builtins only) and the workspace-reaching imports must become `await import()` inside `setup()`/`teardown()`. Registration is `vitest.config.ts` `globalSetup: "./test/global-setup.ts"`.

L3 — measured baseline on a correctly installed tree at base `fa9c1f5856a031a2eac4ba3805a2e75ef5dd18f6`, after `corepack pnpm install --frozen-lockfile` (exit 0, lockfile sha256 `cdde09c8290ceb0ae187a56b781ef6d212c3e4bf6d8b791bd51eac50200b1996` unchanged): `npx tsc --noEmit` exit 0; `npm run typecheck:tests` exit 0 (`1588 files checked; 238 baseline diagnostics in 86 files; no regression.`); `npm run lint` exit 0 (`ESLint ratchet: 1657 files scanned; 558 baseline violations in 396 files across 423 rule/file entries; no regression.`); `npm run fallow:ci` exit 0; `npm run test:affected` exit 78 (documented full-tier decline); `npx vitest related test/global-setup.ts --run` exit 0 with **zero test files selected**, so that command is a null differential and the S8 proof must rest on the healthy-tree unit test plus a broader run. This worktree's own starting state was an absent `node_modules` (no `.pnpm`, no `.package-lock.json`, no `@repo/*`), so the `.package-lock.json` branch is proven by synthetic function input rather than by the environment.

L4 — independent verification round on the settled tree, before the work-unit commit. Two defects were found and closed: `teardown()` is now gated on the preflight verdict (`installPreflightPassed`), because vitest awaits the matching `teardown()` even when `setup()` throws, and its `await import("./fixtures/testcontainers-postgres.js")` re-raised `Cannot find package '@repo/kg/testing/per-run-database'` in a second banner beneath the refusal, restoring the exact confusion the preflight replaced; and the two published censuses in `docs/turborepo.md` were regenerated (`1657` -> `1659` files scanned, `1588` -> `1590` files checked), with the install-preflight pair's two extra files accounted for in the surrounding prose. Measured gates on the settled tree: `npx tsc --noEmit` exit 0; `npm run typecheck:tests` exit 0 with `Test type-check: 1590 files checked; 238 baseline diagnostics in 86 files; no regression.`; `npm run lint` exit 0 with `ESLint ratchet: 1659 files scanned; 558 baseline violations in 396 files across 423 rule/file entries; no regression.`; `npm run fallow:ci` exit 0 (`0 dead-code, 0 complexity, 0 duplication introduced since main`); `npx vitest run test/install-preflight.test.ts --maxWorkers=1` exit 0, 5 passed; `npm run test:affected` exit 78 (the documented full-tier decline, not a failure); `npm test` exit 0 with `Test Files 822 passed | 3 skipped (825)` and `Tests 6130 passed | 4 skipped (6134)` in 341.6 s at load average 7.76. Behavioural proof with `node_modules/@repo/kg` held aside: exit 1, `Startup Error` 0 occurrences, `Cannot find package` exactly once and quoted inside the refusal itself, and no `ERR_MODULE_NOT_FOUND` or vite-node stack.
