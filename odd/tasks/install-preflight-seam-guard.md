# install-preflight-seam-guard

Branch `test/install-preflight-seam-guard`, base `main` = `c5f0c0b7df1ef2b072439709afab4a0b0bb7d74a`.
Make the two seams that `fix/loud-not-installed-refusal` left unguarded executable: a spawned child runs the REAL
`test/global-setup.ts` against a temp tree, so a regression in the deferred imports or the `teardown()` gate turns a
committed test red instead of silently restoring the misleading `Cannot find package` error.

## Specs

S1. **Broken temp root → the refusal, and nothing else.** "broken temp root → the refusal text appears and `Startup Error` / `ERR_MODULE_NOT_FOUND` appear zero times, and the `Cannot find package` occurrences equal exactly the ones quoted inside the refusal". The spawned child must exit non-zero, print the refusal, and the count of the literal `Cannot find package` across ALL of its output must equal the count inside the refusal text itself. Derive that number from `test/fixtures/install-preflight.ts` by reading every message builder the broken tree can reach — do not remember it. Today every variant embeds it exactly once, so the assertion is `1`, and it is the assertion that actually subsumes a `Startup Error` banner rather than merely looking for one.

S2. **The healthy tree still passes.** "healthy temp root → **no** refusal, setup proceeds"; "non-zero exit for the broken root, zero for the healthy one". "Setup proceeds" is proven by `SETUP-OK` in the child's own output, not by the absence of a refusal — a child that exited before `setup()` would also print no refusal.

S3. **The probe's root is the working directory — no production surface added.** "Make the probe's root injectable, and exercise the real path in a child process. Do not pin `await import(` or any other text in `global-setup.ts`"; "Do not write a committed test that moves `node_modules/@repo/kg`". As revised in `L3`: the injection point already exists and is `process.cwd()` — `presentInstallPaths()` computes `const root = path.resolve(".")` and resolves every repo-relative probe path against it — so a child spawned with a temporary `cwd` probes that temporary tree. `test/global-setup.ts` therefore stays byte-identical to HEAD: no environment variable, no docblock edit, no conditional that could only ever be false in production.

S4. **The guard is a test, not a source-shape assertion.** "A guard that was never seen failing is a guard you are hoping about." The child must be a *spawned process* running the real setup module, and no assertion may match characters in `test/global-setup.ts`: the `pnpm-migration-wiring` idiom passes while a seam moves one line down.

S5. **Mutation proof is part of the deliverable, and it belongs to the follow-up.** 1. Hoist a workspace-reaching import to top level → the child test must go **red**; restore, confirm green. 2. Remove the `teardown()` gate → the guard must go **red**; restore, confirm green. Recorded here; performed under `T5`, not in this slice.

S6. **Housekeeping this change owes.** The published censuses were measured at HEAD before this slice: lint `1659 files scanned; 558 baseline violations in 396 files across 423 rule/file entries`, typecheck:tests `1590 files checked; 238 baseline diagnostics in 86 files` (evidence in `L2`). "Never assume" — the post-change numbers are measured by the follow-up (`T6`) in the same commit as any regeneration, and any doc that describes the preflight must name this guard.

S7. **Scope.** Five files total: the four written here plus `docs/turborepo.md`, which belongs to the follow-up. Stop and report on a fifth *new* file. The seven `""`-context harnesses stay untouched (`confinement-roots.ts:36`, `command-project.ts:9`, `compile-project.ts:67`, `lint-temp-root.ts:74`, `okf-temp-dir.ts:29`, `seed-pages-harness.ts:29`, `temp-root.ts:93`), and no temp root may leak — a spawned-child test that leaves a directory behind is the same defect class as no test.

S8. **The guard protects THE CLASS, not the three modules that exist today.** What is guarded is a top-level import of a workspace-provided package **anywhere in the setup's module graph**, because any such edge is evaluated before `setup()` can speak. `test/fixtures/testcontainers-postgres.js` is merely the only live member of that class right now: `scripts/build-stamp.ts` and `scripts/tsup-command.ts` reach `tsup` through `createRequire` *inside a function* and their top-level imports are builtins-only, so hoisting either of them is behaviourally inert. A future top-level `import … from "@repo/…"` in that graph goes red the day it lands — which is why no spec, task, comment or test may say "any of the three".

## Tasks

- T1 — author this document (S1-S8) — done when written — commit `pending` — **done**
- T2 — `test/fixtures/deny-uninstalled-packages.mjs` (in-process resolve hook) and `test/fixtures/install-preflight-child.mjs` (the spawned child driver) (S1, S3, S4) — commit `pending` — **done**
- T3 — `test/install-preflight-seam-guard.test.ts`: broken root, healthy root, cleanup in `finally` (S1, S2, S4, S8) — commit `pending` — **done**
- T4 — injectable probe root as `LLMWIKI_INSTALL_PROBE_ROOT` inside `test/global-setup.ts` — **dropped** by `L3`: the working directory already is the injection point, so the variable would be production surface only our child could make true (S3 as revised) — commit `pending`
- T5 — mutation proof: hoisted workspace import, then ungated `teardown()`, each observed red and restored green (S5) — commit `pending` — **done**, measurements in `L5`
- T6 — re-measure both censuses, regenerate `docs/turborepo.md` if a number moved, name the guard in every doc that describes the preflight, and run the gates (S6, S7) — commit `pending` — **done**, measurements in `L7`

## Log

L1 — the Manager's project brief, verbatim in its requirements (framing prose compressed, quoted requirements untouched):

> Guard the two seams whose regression silently restores a misleading error the feature exists to remove.
>
> Repo: llm-wiki-compiler, base `main` = **`c5f0c0b7df1ef2b072439709afab4a0b0bb7d74a`**. Read `AGENTS.md`, then read `odd/tasks/loud-not-installed-refusal.md` **in full** — it is the immediately preceding slice and its `L4`/`L6` record why this gap was deliberately left open.
>
> ## The gap, precisely
>
> `test/global-setup.ts` now runs an install preflight first, defers three project imports to `await import()`, and gates `teardown()`. Two seams make that work, and **nothing committed goes red if either is undone**: the deferred imports (hoist one back to top level and an uninstalled tree dies with `Cannot find package '@repo/kg/testing/per-run-database'` *before* the preflight can speak) and the `teardown()` gate (ungate it and teardown runs against state that was never set up). The previous slice proved this by hand. **Your job is to make that proof executable.**
>
> ## Design constraint, decided — do not substitute a source-shape assertion
>
> **Make the probe's root injectable, and exercise the real path in a child process.** Do **not** pin `await import(` or any other text in `global-setup.ts`: the `pnpm-migration-wiring` idiom matches characters and would pass while a seam moved one line down. Do **not** write a committed test that moves `node_modules/@repo/kg`: a crashed or interrupted test would leave a broken install, which is worse than the gap.
>
> Then assert, on the child's real output: **broken temp root** → the refusal text appears **and** `Startup Error` / `ERR_MODULE_NOT_FOUND` appear **zero** times, and the `Cannot find package` occurrences equal exactly the ones quoted inside the refusal; **healthy temp root** → **no** refusal, setup proceeds; non-zero exit for the broken root, zero for the healthy one.
>
> ## Prove the guard bites, by mutation, and report each
> 1. Hoist one deferred import to top level → the child test must go **red**. Restore, confirm green.
> 2. Remove the `teardown()` gate → the guard must go **red**. Restore, confirm green.
> "A guard that was never seen failing is a guard you are hoping about." Report each mutation with its observed failure line.
>
> ## Housekeeping a change like this owes
> Both published censuses move with a new test file. Measure them; if a number changes, regenerate `docs/turborepo.md` **in the same commit**. "Never assume" — a previous slice's numbers are not evidence that yours hold. Update any doc that describes the preflight so it names the guard.
>
> ## Scope
> Report the file set before writing; **stop above ~6 files**. Do not touch the seven `""`-context harnesses — recorded latent hazard, separate task.
>
> ## Hard prohibitions
> No history rewriting, no `--amend`, no `--no-verify`, no `HUSKY=0`, no hook bypass, no `cp -a`, no push. `odd/tasks/**` append-only. Leave `/tmp` scratch in place. **Never mutate `node_modules` in a committed test.**
>
> ## Report
> The file set; the injectable-root mechanism and how the child gets its root; the three child assertions with their observed output; **both mutations with their observed red and restored green**; the census numbers measured before and after; every gate exit literal with the lint triple and the suite exit code plus load; full 40-character SHAs; `git status --short`; and a `Risk:` line — **item 6**, because a guard that cannot be seen failing is the same defect as no guard, and a spawned-child test that leaks a temp root is item 1.

L2 — environment and reconnaissance evidence, recorded before any source write.

Measured, not assumed:
- Node `v24.21.0` lives at `$HOME/.nvm/versions/node/v24.21.0/bin`; the default `node -v` on this host is `v22.23.2`, so every command needs the explicit `PATH` prefix. Bare `pnpm` exits `127`; `corepack pnpm` reaches the launcher.
- `node_modules` IS installed: `node_modules/.pnpm` exists and `node_modules/@repo/{api,foundation,kg,wiki}` are links (`kg -> ../../packages/llmwiki-kg/ts`). `@repo/kg`'s `exports` maps `./testing/per-run-database` to `./src/testing/per-run-database.ts`.
- HEAD is `c5f0c0b7df1ef2b072439709afab4a0b0bb7d74a` with a clean tree; `dist/` and `.llmwiki/build-stamp.json` do not exist yet (both are git-ignored and produced by `test/global-setup.ts` itself), and `.llmwiki/test-database.json` records `"source": "unavailable"` with `"LLMWIKI_TEST_ALLOW_NO_DATABASE=1, so no container was started`.
- The `.js`-specifier remap gap is real on Node 24: `node -e 'import("./test/global-setup.ts")'` → `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/test/fixtures/install-preflight.js' imported from '…/test/global-setup.ts'`. `test/` writes `.js` specifiers under `moduleResolution: "bundler"` and type stripping does not remap them, while `scripts/` is node-native and uses `.ts`. That is why the denial hook needs the `.js` → `.ts` retry; it is not a nicety.
- Pre-change censuses at HEAD: lint `1659 files scanned; 558 baseline violations in 396 files across 423 rule/file entries`; typecheck:tests `1590 files checked; 238 baseline diagnostics in 86 files`.
- Class-level reconnaissance for `S8`: `scripts/tsup-command.ts` top-level imports are `node:fs`, `node:module`, `node:path` with `createRequire(import.meta.url)` at module scope but the `tsup` resolution *inside* a function; `scripts/build-stamp.ts` imports only `node:crypto`, `node:fs`, `node:path`. Neither reaches the workspace at load, so hoisting either is behaviourally inert and `test/fixtures/testcontainers-postgres.js` (via `container-server-primitives.ts:38 from "@repo/kg/testing/per-run-database"`) is the class's only live member.

L3 — the Manager's design change to Steps 3 and 4, applied before any write. Verbatim in its decisions:

> ## 1. Step 4 is CANCELLED. `test/global-setup.ts` must end byte-identical to HEAD.
> Do **not** add `LLMWIKI_INSTALL_PROBE_ROOT` or any other env var, and do not modify the docblock. Reason: cwd is already the injection point (`presentInstallPaths()` already does `const root = path.resolve(".")`, and the probe resolves every relative path against it), so an env var only our child sets is production surface added to satisfy a shape the Manager fixed in a sentence — a conditional that can only be false in production. The broken child gets its broken state from a **temp cwd** (the directory-presence check then sees no `node_modules/.pnpm` and no `node_modules/@repo/*`) **plus** the resolve hook (so any *attempted* workspace import still reproduces `Cannot find package` exactly). That pair is sufficient.
>
> ## 2. Consequence: there is no artificial RED step. Do not manufacture one.
> With no production change, the guard is pure test addition, so a "RED before the fix" would be theatre. Run the guard test as written and report its literal output as GREEN (or its failure, if it fails). Say plainly in your report that this guard's RED is delivered by the mutation proof in the follow-up assignment (T5). Do not weaken or reshape an assertion to obtain a pre-fix failure.
>
> ## 3. File set is now FIVE, and `test/global-setup.ts` is NOT one of them.
>
> ## 4. Two wording/content changes in the feature document.
> The census numbers measured at HEAD are `1659 / 558 / 396 / 423` and `1590 / 238 / 86`; the post-change numbers are measured by the follow-up. Add a class-level statement to the Specs: the guard protects **the class** — a top-level import of a workspace-provided package anywhere in the setup's module graph — not the three files that exist today, because `scripts/build-stamp.ts` and `scripts/tsup-command.ts` reach `tsup` through `createRequire` *inside a function* and their top-level imports are builtins-only, so hoisting either is behaviourally inert. Never write "any of the three".
>
> ## 5. Keep exactly as instructed.
> The three child assertions on real output; the healthy-root recipe (four `@repo/*` dirs + `node_modules/.pnpm`, symlinks of `src`, `packages`, `scripts`, `tsup.config.ts`, `tsconfig.json`, `package.json`, a byte copy of `.llmwiki/build-stamp.json`); if `isBuildFresh(<root>)` does not accept the symlinked tree, **STOP and report with the measured value**. Cleanup in `finally`; nothing written under the repo; no commit; no mutation edits; no census regeneration.

L4 — one deviation from `L3`'s letter, taken to keep `S2` satisfiable and stated rather than absorbed: the resolve hook denies a `@repo/…` or `@testcontainers/…` specifier only when that package is ABSENT from the probed tree's `node_modules`. An unconditional denial makes every workspace import fail in the healthy child too, so `setup()` could never print `SETUP-OK` and `S2` would be impossible — the hook would be asserting that the tree is broken rather than simulating a tree that is. The conditional form is the same simulation in the direction that matters: in the broken child every `@repo/…` specifier dies with the canonical `Cannot find package` text, so a hoisted workspace import still goes red under `T5`, and the healthy child resolves the real links it was given. The healthy root therefore also carries a link for `@testcontainers`, which the same rule protects.

L5 — the four mutation measurements, performed with `test/global-setup.ts` as the only mutated file and reverted after each, the guard run each time with
`corepack pnpm exec vitest run test/install-preflight-seam-guard.test.ts`. Note on the prescribed command form: its trailing `echo "exit=$?"` reports `tail`'s status, not vitest's, so each verdict below is the reporter's own `Test Files … / Tests …` line.

1. **Hoisted workspace import — RED, as required.** Mutation (additive only; the deferred imports stayed):
   `+import "./fixtures/testcontainers-postgres.js";` after the `install-preflight.js` import. Observed:
   `× install preflight, through the real setup in a child process > refuses a tree with no install, and prints nothing else 123ms`,
   `AssertionError: expected 'LOAD-FAILED: Cannot find package \'@t…' to contain 'Found no node_modules/.pnpm'`, at
   `test/install-preflight-seam-guard.test.ts:238:28` — the child's whole output was
   `LOAD-FAILED: Cannot find package '@testcontainers/postgresql' imported from file:///…/test/fixtures/testcontainers-postgres.ts`.
   The observable that moved is the refusal fragment: absent, because the setup module died while LOADING, before `setup()` could speak. `Test Files 1 failed (1)` / `Tests 1 failed | 1 passed (2)`. Restored with `git restore test/global-setup.ts`; `git diff --numstat test/global-setup.ts` printed nothing; rerun `Test Files 1 passed (1)` / `Tests 2 passed (2)`.
2. **The inert pair — GREEN, proven rather than asserted.** `+import "../scripts/build-stamp.js";` → `Test Files 1 passed (1)` / `Tests 2 passed (2)`, diff empty after restore. `+import "../scripts/tsup-command.js";` → `Test Files 1 passed (1)` / `Tests 2 passed (2)`, diff empty after restore. Both hoists are behaviourally inert because their top-level imports are builtins-only and `tsup` is reached through `createRequire(import.meta.url)` inside a function, so neither reaches the workspace at load — which is exactly why nothing may describe the guarded class as "any of the three".
3. **Ungated `teardown()` — RED, the predicted count.** Mutation: deleted `if (!installPreflightPassed) return;` from `teardown()`. Observed:
   `× … > refuses a tree with no install, and prints nothing else 135ms`, `AssertionError: expected 2 to be 1 // Object.is equality`, at
   `test/install-preflight-seam-guard.test.ts:244:62` — the `Cannot find package` count assertion. The child's real output, reproduced with the mutation in place, was the refusal line
   `SETUP-FAILED: Found no node_modules/.pnpm, … Run `corepack pnpm install --frozen-lockfile` …` followed by the second banner
   `TEARDOWN-FAILED: Cannot find package '@testcontainers/postgresql' imported from file:///…/test/fixtures/testcontainers-postgres.ts`, and `grep -o "Cannot find package" | wc -l` → `2`. `Tests 1 failed | 1 passed (2)`: the HEALTHY case stayed green, because a correct tree resolves what an ungated teardown imports. Restored; diff empty; rerun `Tests 2 passed (2)`.

What the four measurements establish, at class level: the guard protects **a top-level import of a workspace-provided package anywhere in the setup's module graph**, of which `test/fixtures/testcontainers-postgres.js` is the only live member today — `scripts/build-stamp.js` and `scripts/tsup-command.js` are inert when hoisted, measured above, not assumed. And the ungated-`teardown()` detector is the BROKEN-ROOT child, never the healthy one: a correct tree resolves the import that a gate-less teardown makes, so only the refused child can show the second banner. `test/global-setup.ts` is byte-identical to HEAD after the measurements.

L6 — the gate measurements after `T5`, taken one at a time, with `test/global-setup.ts` restored and absent from `git status --short`.

Censuses. Before this slice: lint `1659 files scanned; 558 baseline violations in 396 files across 423 rule/file entries`; typecheck:tests `1590 files checked; 238 baseline diagnostics in 86 files`. After: typecheck:tests `Test type-check: 1591 files checked; 238 baseline diagnostics in 86 files; no regression.` exit 0 — the one added `.test.ts` moves the file count by exactly one and the baseline is untouched. The lint triple is NOT yet measurable: `npm run lint` exits 1 on one NEW violation and prints no triple, so no lint number may be written into a published census until that violation is gone.

Gate exits. `npx tsc --noEmit` exit 0. `npm run typecheck:tests` exit 0. `npm run lint` exit 1, one new violation:
`test/fixtures/install-preflight-child.mjs:65 local/dimension-boundary dimension boundary: the import specifier is not a string literal, so the gate cannot verify which dimension it reaches; replace it with a string literal specifier that the boundary check can read. (… : 1 exceeds baseline 0; no frozen allowance for local/dimension-boundary in this file)` — the driver's `await import(pathToFileURL(path.resolve(setupModulePath)).href)` is a computed specifier, which the boundary gate reports by design and will not resolve. `npm run fallow:ci` exit 1: `Fallow CI: 2 dead-code, 2 complexity, 0 duplication introduced since main (verdict fail; 0 dead-code, 0 complexity, 0 duplication inherited, not counted)`, located as unused files `test/fixtures/deny-uninstalled-packages.mjs` and `test/fixtures/install-preflight-child.mjs` (reachable only by string path, invisible to a static graph) plus high-complexity functions `resolve` (6 cyclomatic / 42 CRAP) and `main` (5 cyclomatic / 30 CRAP). `npm run test:affected` exit 78 — the documented full-tier decline — followed by `npm test` exit 0: `Test Files 823 passed | 3 skipped (826)`, `Tests 6132 passed | 4 skipped (6136)`, 330.88 s, load average `[1.76, 1.41, 1.79]` before and `[6.39, 5.64, 3.64]` after (the previous slice recorded 822 files / 6130 tests, so this slice adds exactly its own file and its two cases).

Why this entry stops here: every remaining fix — the literal specifier, the two function splits, and registering the two path-referenced fixtures in `.fallowrc.json` `entry` where `test/fixtures/mock-embeddings.mjs`, `track-dotenv-read.mjs` and `sigterm-at-ready.cjs` already live — lands in files outside the edit surfaces this assignment granted, and the lint census cannot be measured before the violation is gone. `docs/turborepo.md` is therefore NOT edited yet: publishing a derived number nobody measured is the failure the "never assume" rule names.

L5 (re-proof, appended — the entry above stays as written because it was measured against the pre-refactor driver). The driver was then changed to name the setup module with a literal specifier and to split `main`, so both mutations were re-run against the final artifacts. Same commands, same restores.

1. Hoisted `./fixtures/testcontainers-postgres.js` (diff `@@ -77,0 +78 @@ … +import "./fixtures/testcontainers-postgres.js";`): RED —
   `× install preflight, through the real setup in a child process > refuses a tree with no install, and prints nothing else 128ms`,
   `→ expected 'LOAD-FAILED: Cannot find package \'@t…' to contain 'Found no node_modules/.pnpm'`,
   `+ LOAD-FAILED: Cannot find package '@testcontainers/postgresql' imported from file:///…/test/fixtures/testcontainers-postgres.ts`,
   `Test Files 1 failed (1)` / `Tests 1 failed | 1 passed (2)`. Restored; `git diff --numstat test/global-setup.ts` empty.
2. Ungated `teardown()` (diff `@@ -153 +152,0 @@ … -  if (!installPreflightPassed) return;`): RED on the broken case —
   `→ expected 2 to be 1 // Object.is equality`, `Tests 1 failed | 1 passed (2)`, the healthy case still green; the child's own second banner was
   `TEARDOWN-FAILED: Cannot find package '@testcontainers/postgresql'` and `grep -c "Cannot find package"` → `2`. Restored; numstat empty.
3. Two consecutive green runs after the last restore: `Test Files 1 passed (1)` / `Tests 2 passed (2)` (542 ms), then `(533 ms)`.

L7 — `Option 1` of the `L6` blocker, authorised with its exact path list, and the settled-tree gates. Six files: this document, `test/fixtures/install-preflight-child.mjs`, `test/fixtures/deny-uninstalled-packages.mjs`, `test/install-preflight-seam-guard.test.ts`, `.fallowrc.json`, `docs/turborepo.md` — the cap, not above it. No suppression was used, no threshold changed, no `lint:update`, no hook bypass.

What the two red gates cost, and why the fixes are structural rather than silenced. The driver now names the setup module with a literal module-relative specifier (`await import("../global-setup.ts")`) instead of `process.argv[2]`, so the boundary rule can VERIFY the specifier it used to report as computed, and a literal resolves against the driver's own file while the temp cwd still governs the probe; `process.argv[2]`, `node:url` and `node:path` are gone, and `main` was split into `loadSetupModule`/`runSetup`/`runTeardown` with `teardown()` still called unconditionally after a throwing `setup()`. The hook's `.js`→`.ts` retry moved into `resolveWithRetry`/`retryOrRethrow` behind the `canRetryAsTypeScript` predicate, still running only after a real failure and still rethrowing the ORIGINAL error. Both fixtures are now registered in `.fallowrc.json` `entry` exactly where `test/fixtures/mock-embeddings.mjs`, `track-dotenv-read.mjs` and `sigterm-at-ready.cjs` already are — the repository's existing mechanism for a fixture reached by path, not a new one.

Re-proof after the refactor (the `L5` re-proof entry above): hoisted workspace import RED at `test/install-preflight-seam-guard.test.ts:238`, `LOAD-FAILED: Cannot find package '@testcontainers/postgresql' …`, restored with an empty numstat; ungated `teardown()` RED at `:244` with `expected 2 to be 1` and the child's `TEARDOWN-FAILED: Cannot find package '@testcontainers/postgresql'`, count `2`, restored with an empty numstat; then two consecutive green runs, `Tests 2 passed (2)` at 542 ms and 533 ms.

Censuses, measured on the settled tree. lint: `ESLint ratchet: 1662 files scanned; 558 baseline violations in 396 files across 423 rule/file entries; no regression.` — files scanned `1659 → 1662` (the guard test and its two `.mjs` fixtures), the ceiling triple `558 / 396 / 423` unchanged, so no `lint:update` was needed and none was run. typecheck:tests: `Test type-check: 1591 files checked; 238 baseline diagnostics in 86 files; no regression.` — files checked `1590 → 1591` (the guard test alone; `.mjs` is not in that program), baseline `238 / 86` unchanged.

Gates, one at a time, on the settled tree: `npx tsc --noEmit` exit **0**; `npm run typecheck:tests` exit **0**; `npm run lint` exit **0** with the triple above; `npm run fallow:ci` exit **0** (`Fallow CI: 0 dead-code, 0 complexity, 0 duplication introduced since main (verdict pass; … not counted)`); `npm run test:affected` exit **78** (the documented full-tier decline, `.fallowrc.json` has suite-wide reach); `npm test` exit **0** with `Test Files 823 passed | 3 skipped (826)`, `Tests 6132 passed | 4 skipped (6136)`, 331.62 s, load average `[2, 3.48, 3.18]` before and `[6.04, 5.4, 4.15]` after. Tier check: `node scripts/test-partition.ts integration` lists `test/install-preflight-seam-guard.test.ts` (1 match), so the guard is integration by the repository's own classifier, as the brief predicted.

`docs/turborepo.md`, every number moved: `1659 files scanned` → `1662 files scanned` (the `@repo/kg#lint` row, and `the root 1659 / 558 / 423` → `1662 / 558 / 423`); `Test type-check: 1590 files checked` → `1591` in both the `typecheck:tests` row and the quoted block; the census-prose paragraph now names the guard test as the one file this slice adds to that program and its two `.mjs` fixtures as the three that moved the lint scan; and the session-install-preflight paragraph gained four lines naming `test/install-preflight-seam-guard.test.ts` as the child-driven guard over the broken and healthy temp roots. No section was added or restructured.

L7 (correction, appended rather than edited into the entry above, which stays as written). Two assertion line numbers in `L7` were carried over from the pre-refactor run and are wrong by one: the hoisted-import red fails at `test/install-preflight-seam-guard.test.ts:239:28` (the `toContain(NO_PNPM_FRAGMENT)` assertion; `L7` said `:238`), and the ungated-`teardown()` red fails at `:245:62` (the `occurrences(child.output, CANNOT_FIND_PACKAGE)` assertion, `expected 2 to be 1`; `L7` said `:244`). Re-measured by re-running both mutations against the final driver: red at those sites, `git diff --numstat test/global-setup.ts` empty after each restore, and the guard green again afterwards (`Test Files 1 passed (1)`, `Tests 2 passed (2)`).
