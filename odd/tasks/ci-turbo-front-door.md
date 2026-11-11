# CI front door: `turbo run build` + `turbo run test`

Branch `feat/ci-turbo-front-door`, base `main` = `98c879e89fba7fa38e654e0d37abdcb442ea7830`. Objective: the two build/test invocations inside CI's **existing** `build-and-test` job become Turborepo invocations, so the front door is the graph instead of the root scripts — with no new job, no rename and no matrix change.

Measured before any write: `turbo.json` declares no `build` task, so **both** `turbo run build` forms exit `1` with ``Could not find task `build` in project`` (L3). Once declared, the task resolves to exactly **two** tasks writing **two distinct** directories (L4), so the two-writers stop condition does not fire.

## Specs

**S1 — the two CI invocations, verbatim, inside the existing `build-and-test` job, in the form the job's own pnpm setup guarantees.**

```yaml
- run: pnpm exec turbo run build
- run: pnpm exec turbo run test --filter=//
```

Both substitutions are turbo's own vocabulary, approved at `L6`: the filter is `//` (turbo's
identifier for the root project) rather than the impossible `--filter=llm-wiki-compiler`, and
`turbo.json` registers the root tasks with the `//#` prefix. `corepack pnpm` is a fact about
the reference host (bare `pnpm` exits `127` there), not about CI: the job provisions pnpm
through `pnpm/action-setup@v4` (`.github/workflows/ci.yml:66`), which resolves
`packageManager` from `package.json:4` — the same pnpm that ran
`pnpm install --frozen-lockfile`. `corepack pnpm` must not appear in the workflow (`L2`). It
stays only in this host's local measurement commands and, as the local workaround, in
`docs/turborepo.md`.

**S2 — the `--filter` is not optional, and the reason is counts.** "The `--filter` is not optional: `@repo/kg#test` is a derived subset of the root suite (bucket 549), so unfiltered `turbo run test` would run those files twice; a per-package-only model would miss the `meta` + `orphan` files that belong to no package. CI's gate of record stays the full suite, expressed as the root project's (`llm-wiki-compiler`) `test` task." The sentence in `docs/turborepo.md` cites the counts, never the principle (`L2`): **549** of the root suite's **827** collected files are `@repo/kg`'s derived selection, and **99** (`meta=70` + `orphan=29`, `uncovered=0`) belong to no package. The stale figure **96** must not appear (`L6`).

**S3 — `turbo.json` gains `build`, `//#build` and `//#test`, each with `"cache": false` and `"dependsOn": []`, consistent with every other verdict task. Caching is enabled nowhere, for any task.** "Add a `build` task with `"cache": false` and `"dependsOn": []`, consistent with every other verdict task. Do not enable caching anywhere, for any task." "A dependency edge in a cache-less graph where nothing consumes the artefact is unauthorized. Do not add one." The two `//#` entries are approved at `L6`: they are turbo's only mechanism for a root task.

**S4 — the trailing comment in `turbo.json` must record the truth after the change.** "`build` exists because CI's front door is now `turbo run build`; it resolves only to the projects that actually declare a `build` script (name them with their count, from Step 1.3); the non-emitting packages still declare no `build` script, so the task resolves to nothing for them rather than to a false success; there is still no `^build` edge unless Step 1.4 proved one is needed. Keep the cache-less rationale comment intact and extend it to cover `build`."

**S5 — the redundant `@repo/kg` build step is measured, then removed.** "MEASURE first whether the new `turbo run build` now covers it — i.e. whether `@repo/kg#build` is among the tasks `turbo run build` executes and produces the same artefact in the same location the Docker build consumes. Then decide: if turbo covers it, REMOVE the step; if it does not, KEEP it." Measured at `L7`: covered, so removed — the ruling is recorded at `L6`.

**S11 — the CI build invocation is unfiltered because it is extensional, and the rejected candidates are named with their measurements.** Unfiltered `turbo run build` is deliberate: any package that later declares a `build` script joins the front door **by existing**, whereas `--filter=// --filter=@repo/kg` would **enumerate** the artefact set and silently stop building a new one — an item-6 defect introduced by the fix for an item-6 defect. This must be written in `docs/turborepo.md`, not only reported, "because the next reader will otherwise 'optimise' the invocation back into a filter list".

**S12 — the frozen-root-scripts guard is cited as EVIDENCE, and the ratchet red is reported, not fixed.** The `:207` assertion's passing is the *empirical* proof of the ruling that `//#test` does not wire the front door through a root script. The two other assertions in `test/package-task-selection.test.ts` that this change makes red are a separate slice under explicit consent; that file is forbidden here — "Do not fix it, do not skip it silently — report its literal failures as the pending item."

**S6 — the required check names survive.** "`test-typecheck`, `codebase-health` and `build-and-test (24)` must all still exist." "NO new job, nothing renamed, no matrix change."

**S7 — the frozen-root-scripts guard must stay green, and if it fires the slice stops.** A test freezes the root scripts by asserting none mentions `turbo`; CI is `.github/`, not `package.json`, so it must be unaffected. "if it fires, stop and report — that would mean the front door got wired through a root script. Do not 'fix' the guard and do not touch `test/` or `package.json` to make it pass."

**S8 — the honest limits, documented in `docs/turborepo.md`, each verified rather than assumed.** "Document the honest limits, each verified rather than assumed:"

- the observed `turbo run build --filter=@repo/kg` behaviour with its literal exit code and message;
- `build` has no per-package selection because there is ONE build producing ONE artefact;
- the local per-package path is `--filter=@repo/<pkg>` and the CI gate of record is the full suite (root project `test`);
- the `build` task row in the file's task table alongside `test`/`lint`/`typecheck`/`fallow`.

Plus two facts added at `L6`/`L7`: **turbo names the root project `//`, not by its `package.json` name**, cited with the `//#` declaration rule from the turbo package's own docs; and the resolved-but-nonexistent ids (`@repo/api#build`, `@repo/foundation#build`, `@repo/wiki#build`) named **beside the literal exit code**, because a `<NONEXISTENT>` id that resolves in a run is a documented defect, not a footnote.

**S9 — censuses are regenerated from the file's own census command, in the same edit.** "Regenerate any census this change moves, in the same edit: re-run the census command the file itself documents and paste the fresh numbers. The `meta` census is in dispute between sources (67 vs 70) — measure it, do not copy either. If nothing moved, say so explicitly instead of editing numbers."

**S10 — the stop conditions, and the prohibition surface.** Stop and report if two `turbo run build` tasks write the same output directory; if unfiltered `turbo run build` needs a `dependsOn`/`^build` edge, or its task count is more than 3, or cannot be stated exactly; or if it fails for a reason outside the allowed edit surfaces. No commit, no push, no caching; `odd/tasks/**` append-only.

## Tasks

- [x] T1 — base-state measurements before any write: RED for the CI change, both pre-change `turbo run build` failure modes, workspace build inventory, whether the root tsup build reads `@repo/kg`'s dist, and the job's pnpm setup — Spec: S1, S4, S5, S10 — route: inline (measurement only) — commit: 7e5cccf2d8fb4f01b06a64c7a464e722094c6f9e
- [x] T2 — create this ODD feature document — Spec: S1-S10 — route: inline — commit: 7e5cccf2d8fb4f01b06a64c7a464e722094c6f9e
- [x] T3 — `turbo.json`: declare the `build` task (`cache: false`, `dependsOn: []`) and rewrite the trailing comment to the post-change truth; then, under Option A, the root tasks `//#build` and `//#test` — Spec: S3-S4 — route: inline — commit: 7e5cccf2d8fb4f01b06a64c7a464e722094c6f9e
- [x] T4 — `.github/workflows/ci.yml`: the two invocations of S1, and the redundant-step decision of S5 (removed) — Spec: S1-S2, S5-S6 — route: inline — commit: 7e5cccf2d8fb4f01b06a64c7a464e722094c6f9e
- [x] T5 — post-change measurements: both turbo invocations with exit codes, task counts, names and wall times; both artefacts; the guard;; the `--filter=@repo/kg` behaviour — Spec: S2, S5, S7, S10 — route: inline — commit: 7e5cccf2d8fb4f01b06a64c7a464e722094c6f9e
- [x] T6 — `docs/turborepo.md`: the honest limits, the `build` task row, the roadmap row, the superseded decline, the `//` naming, the extensionality table — Spec: S8-S9, S11 — route: inline — commit: 7e5cccf2d8fb4f01b06a64c7a464e722094c6f9e
- [x] T7 — the gates, each with its literal exit code — **green at `L9`**: `corepack pnpm test` EXIT=0 (824 passed, 6144 tests, load 7.11), and tsc/typecheck:tests/lint/fallow:ci all EXIT=0 — Spec: S10 — route: inline — commit: 7e5cccf2d8fb4f01b06a64c7a464e722094c6f9e
- [x] T8 — amend `test/package-task-selection.test.ts` (`DECLARED_TASKS` + the rewritten build-surface assertion) and prove the rewritten assertion bites — Spec: S12 — route: inline — commit: 7e5cccf2d8fb4f01b06a64c7a464e722094c6f9e
- [x] T9 — amend `test/control-gates.test.ts` under the granted consent: turbo literals, ordering kept and strengthened, fail-closed env accounting, with three bite proofs — Spec: S10, S12 — route: inline — commit: 7e5cccf2d8fb4f01b06a64c7a464e722094c6f9e
- [x] T10 — the prose slice: `README.md`, `AGENTS.md`, `scripts/test-affected.ts` (comment-only) — Spec: S1, S11 — route: inline — commit: f0732a22d37066cce8e7de3cb26567b3b952c9b3

## Log

### L1

The assignment's requirement text, verbatim:

```
## The owner's decided shape (verbatim, do not redesign it)
CI's two invocations inside the EXISTING `build-and-test` job become exactly:
```yaml
- run: corepack pnpm exec turbo run build
- run: corepack pnpm exec turbo run test --filter=llm-wiki-compiler
```
The `--filter` is not optional: `@repo/kg#test` is a derived subset of the root suite (bucket 549), so unfiltered `turbo run test` would run those files twice; a per-package-only model would miss the `meta` + `orphan` files that belong to no package. CI's gate of record stays the full suite, expressed as the root project's (`llm-wiki-compiler`) `test` task.
```

and the three documentation limits, verbatim:

```
- the observed `turbo run build --filter=@repo/kg` behaviour with its literal exit code and message;
- `build` has no per-package selection because there is ONE build producing ONE artefact;
- the local per-package path is `--filter=@repo/<pkg>` and the CI gate of record is the full suite (root project `test`);
```

plus the fourth bullet the same assignment names:

```
- the `build` task row in the file's task table alongside `test`/`lint`/`typecheck`/`fallow`.
```

### L2

The Manager's material corrections, verbatim, which supersede the `corepack pnpm` form in `L1`:

```
1. **The CI invocation must NOT use `corepack`.** `corepack pnpm` is a fact about this reference host (bare `pnpm` exits 127 here), not a fact about CI. If the job provisions pnpm via `pnpm/action-setup` (or any equivalent pin), writing `corepack pnpm exec turbo …` would reach a *second* package manager resolved by a different rule, possibly at a different version than the one that ran `pnpm install --frozen-lockfile`. So:
   - Inspect exactly how the `build-and-test` job provides pnpm, and write both invocations **in the form that setup guarantees** — `pnpm exec turbo run build` and `pnpm exec turbo run test --filter=llm-wiki-compiler` if the job pins pnpm through `pnpm/action-setup`.
   - In your report, say which form you wrote and quote the setup step (with line number) that makes it guaranteed.
   - If the job declares no pnpm setup at all, that is a finding: report it and **stop** rather than inventing a toolchain.
   - `corepack pnpm` stays only in the local measurement commands you run on this host, and may appear in `docs/turborepo.md` as the local workaround. It must not appear in `.github/workflows/ci.yml`.
   - If you already wrote `corepack pnpm exec turbo …` into the workflow, replace it.

2. **Censuses: regenerate from the file's own census command and use the freshly generated values, not mine and not either number in dispute.** Expected live values are `meta=70`, `orphan=29`, `collected=827` (the earlier `67` was stale, predating the selection slice that took `meta 69→70` and `collected 826→827`). If your regenerated value disagrees with all of these, report the disagreement and use the file's own generated value.

3. **The doc's rationale sentence must rest on counts, not on principle.** The sentence explaining why CI filters must cite the numbers: `@repo/kg`'s derived selection (549) is a strict subset of the root suite (827), so unfiltered `turbo run test` would run those 549 file-runs twice, and 96 files (70 `meta` + 29 `orphan`, minus overlap as the census states — use the file's own arithmetic, do not invent a sum if the census reports `uncovered`) belong to no package at all, which is why CI stays on the root project's `test`. You do not need to run unfiltered `turbo run test` to prove it; the counts are the evidence.

4. **`dependsOn: []`, no `^build` edge, `cache: false` — confirmed and non-negotiable.** A dependency edge in a cache-less graph where nothing consumes the artefact is unauthorized. Do not add one. Two `turbo run build` tasks writing one directory remains a stop-and-report condition.

5. **The frozen-root-scripts guard: if it fires, stop and report** — that would mean the front door got wired through a root script. Do not "fix" the guard and do not touch `test/` or `package.json` to make it pass.

6. Still no commit. Report every measurement literally; if a gate did not run or did not pass, say exactly that.
```

### L3

Base-state RED, measured on the untouched base commit `98c879e89fba7fa38e654e0d37abdcb442ea7830`, each with its literal exit code:

```
$ grep -c 'turbo run' .github/workflows/ci.yml
0
EXIT=1

$ git diff --quiet 98c879e89fba7fa38e654e0d37abdcb442ea7830 -- .github/workflows/ci.yml; echo $?
0

$ corepack pnpm exec turbo run build --filter=@repo/kg
  x Missing tasks in project
  `->   x Could not find task `build` in project
EXIT=1

$ corepack pnpm exec turbo run build
  x Missing tasks in project
  `->   x Could not find task `build` in project
EXIT=1
```

The owner's expected failure message is confirmed verbatim, for the filtered **and** the unfiltered form.

### L4

Build inventory, measured before the write. Every workspace member (`pnpm-workspace.yaml:5-8`: `packages/api`, `packages/foundation`, `packages/llmwiki-kg/ts`, `packages/wiki`) plus the root project, and what each declares:

| project | name | `build` script | outDir |
| --- | --- | --- | --- |
| root | `llm-wiki-compiler` | `tsup` (`package.json:27`) | `dist` — `tsup.config.ts:22` and `tsconfig.json:9` |
| `packages/llmwiki-kg/ts` | `@repo/kg` | `tsc -p tsconfig.build.json` | `packages/llmwiki-kg/ts/dist` — `packages/llmwiki-kg/ts/tsconfig.json:10` |
| `packages/foundation` | `@repo/foundation` | **none** | — |
| `packages/wiki` | `@repo/wiki` | **none** | — |
| `packages/api` | `@repo/api` | **none** | — |

`packages/llmwiki-kg` itself is **not** a workspace member and has no `package.json`; `find packages -maxdepth 3 -name package.json` returns exactly the four member manifests. So `turbo run build` resolves to exactly **two** tasks, `llm-wiki-compiler#build` and `@repo/kg#build`, writing **two distinct** directories: the repository root `dist/` and `packages/llmwiki-kg/ts/dist/`. Two writers, two directories — the two-writers stop condition does not fire.

The root `tsup` build does **not** consume `@repo/kg`'s emitted dist; it bundles `@repo/*` from source. `tsup.config.ts:123-128` states it and sets `noExternal: [/^@repo\//]` on the `api` entry, whose comment reads "Every `@repo/*` workspace package is BUNDLED, not externalized. They publish raw TypeScript paths"; `@repo/kg`'s `exports` all point at `./src/*.ts` (`packages/llmwiki-kg/ts/package.json`), and `grep -rn 'llmwiki-kg/ts/dist'` finds the path only in `test/kg-mcp-e2e/kg-api-child.ts:41`, `test/kg-mcp-e2e/kg-mcp-child.ts:42` and `packages/llmwiki-kg/Dockerfile:113,123` — never in `tsup.config.ts`. So the two build tasks are order-independent and **no `^build` edge is required or added**.

The job's pnpm is provisioned by `pnpm/action-setup@v4` (`.github/workflows/ci.yml:66`) with no `version:` input, so the action resolves `packageManager` from `package.json:4` (`"packageManager": "pnpm@11.5.0"`); `actions/setup-node@v4` follows at `:67-70` with `cache: pnpm`. The same `packageManager` field is what `corepack` reads on this host, so the two agree — but the workflow writes the form its own setup guarantees.

### L5

STOPPED at the Step 2 stop conditions, before `.github/workflows/ci.yml` was touched. The decided shape is not expressible on turbo 2.11.10, and the measurement is the reason. Every command below was run on this host with `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"` and a `corepack enable --install-directory /tmp/corepack-shim` shim (bare `pnpm` exits `127` here), never as a `--dry` guess alone.

**F1 — turbo 2 does not know the root project by its `package.json` name, and does not run its tasks unless they are declared `//#`.**

```
$ turbo run build --dry=json
packages: ['@repo/api', '@repo/foundation', '@repo/kg', '@repo/wiki']   # root ABSENT
tasks:    @repo/api#build        -> command '<NONEXISTENT>'
          @repo/foundation#build -> command '<NONEXISTENT>'
          @repo/kg#build         -> command 'tsc -p tsconfig.build.json'
          @repo/wiki#build       -> command '<NONEXISTENT>'
```

A real, unfiltered run after the `build` task was declared:

```
$ corepack pnpm exec turbo run build
   • Packages in scope: @repo/api, @repo/foundation, @repo/kg, @repo/wiki
   • Running build in 4 packages
@repo/kg:build: $ tsc -p tsconfig.build.json

 Tasks:    1 successful, 1 total
 Time:     3.635s
EXIT=0
WALL=4.09 s
```

**Turbo exits 0 while the root `tsup` build — the entire published distribution — does not run.** The three `<NONEXISTENT>` entries are the three non-emitting members; turbo drops them from the run rather than failing. This is the "reports success without an artefact" class the file's own comment exists to prevent, and the decided S4 wording ("it resolves only to the projects that actually declare a `build` script") is **falsified by measurement**: it resolves the task in all four packages regardless.

**F2 — `--filter=llm-wiki-compiler` hard-errors, with and without root tasks declared.**

```
$ corepack pnpm exec turbo run test --filter=llm-wiki-compiler
  x No package found with name 'llm-wiki-compiler' in workspace
EXIT=1
```

The root project's identifier in turbo's model is `//`. The documented mechanism for root tasks is the `//#` prefix (`node_modules/turbo/docs/messages/missing-root-task-in-turbo-json.mdx`: `"//#build": {}`). Verified by temporary experiment, reverted immediately:

```
# with "//#build" and "//#test" declared:
packages: ['//', '@repo/api', '@repo/foundation', '@repo/kg', '@repo/wiki']
turbo run build --dry=json            -> [('//#build', 'tsup')]                 # one task
turbo run test  --filter=// --dry=json -> [('//#test', 'vitest run')]            # one task
turbo run test  --filter=llm-wiki-compiler -> x No package found with name 'llm-wiki-compiler' in workspace, EXIT=1
```

So `--filter=//` is the only spelling that reaches the root project's tasks, and the decided CI line would be red on the first push.

**Stop conditions that fired (Step 2):** `turbo run build` resolves 4 tasks (3 of them `<NONEXISTENT>`) — more than 3; and it does not build the distribution, which cannot be fixed while keeping the decided invocation, because the fix is a root-task declaration plus `//`-filter — a redesign of the decided shape, and therefore the owner's call.

**Stop conditions that did NOT fire:** the two-writers defect does not exist (root `dist/` vs `packages/llmwiki-kg/ts/dist/`, two distinct directories); and no `^build` edge is needed (root `tsup` bundles `@repo/*` from source — `tsup.config.ts:123-128`, `noExternal: [/^@repo\//]`; `grep -rn 'llmwiki-kg/ts/dist'` finds the path only in the two `test/kg-mcp-e2e` children and `packages/llmwiki-kg/Dockerfile:113,123`).

**Census, regenerated from the file's own command** (`vitest run test/package-selection-union.test.ts`, exit `0`):

```
selection buckets: @repo/foundation=405 @repo/wiki=565 @repo/kg=549 @repo/api=13 meta=70 orphan=29 uncovered=0 collected=827 distinct=827 multiPackage=409
```

That matches the values already printed in `docs/turborepo.md`, so **nothing moved** and no number in that file needs editing.

**State of the tree at the stop:** `turbo.json` carries the `build` task (`"cache": false`, `"dependsOn": []`, caching still enabled nowhere) and a foot comment rewritten to the measured truth above — it declares no `//#` entry and no `^build` edge. `odd/tasks/ci-turbo-front-door.md` is new. `.github/workflows/ci.yml` and `docs/turborepo.md` are **unmodified**. No commit, no push.

**Task status:** T1 done (measurements in L3/L4/L5), T2 done (this document), T3 done (`turbo.json`), T4-T7 **not started**, blocked on the decision this slice's stop conditions require.

### L6

The Manager's approval of **Option A**, and the rulings it carries. Every one of them is
recorded here because each closes a question the stop at `L5` left open:

1. **Both substitutions approved, as turbo's own vocabulary.** The test invocation filters
   with `--filter=//` — turbo's identifier for the root project, not the impossible
   `--filter=llm-wiki-compiler` — and `turbo.json` registers the root tasks with the `//#`
   prefix (`"//#build"`, `"//#test"`). The rule is turbo's own, stated in the package's
   shipped docs at `node_modules/turbo/docs/messages/missing-root-task-in-turbo-json.mdx:41-49`,
   and there is no `--include-workspace-root` flag to fall back on (measured:
   `unexpected argument`, EXIT=1).
2. **`//#test` does not violate the frozen-root-scripts guard, and the guard passing is the
   EVIDENCE.** The ruling is pinned empirically, not argued: `test/package-task-selection.test.ts:207`
   — `it("keeps every root gate script byte-identical and free of turbo")` — **passes**, and
   `git diff --quiet 98c879e89fba7fa38e654e0d37abdcb442ea7830 -- package.json` returns `0`.
   The front door was wired through CI, not through a root script.
3. **`cache: false` and `dependsOn: []` on every new task, and no `^build` edge.** A
   dependency edge in a cache-less graph where nothing consumes the artefact is
   unauthorized. Caching is enabled nowhere.
4. **`--filter=//` stays on the test invocation.** Unfiltered `turbo run test` would run the
   KG bucket (549 files) on top of the full suite (827) — 549 file-runs twice.
5. **The redundant `pnpm --filter @repo/kg run build` step is REMOVED.** `turbo run build`
   now runs `@repo/kg#build`, so the step was the duplicate of a task on the line above it.
6. **Unfiltered `turbo run build` is chosen over the narrower forms, because it is
   extensional.** `--filter=// --filter=@repo/kg` enumerates the artefact set, so a package
   that later declares a `build` script would silently stop being built in CI — an item-6
   defect introduced by the fix for an item-6 defect. This must be written in
   `docs/turborepo.md`, not only reported.
7. **The census's own arithmetic is `70 + 29 = 99`.** The `96` in the earlier brief is
   stale and must not appear in the documentation.
8. **The ratchet test is RED by this change and is being amended under explicit consent.**
   `test/package-task-selection.test.ts` freezes the declared task list and asserts no
   `build` task exists; it is **not** mine to touch in this assignment. Its literal failures
   are reported as the pending item and never skipped silently.

### L7

The measurements Option A required, every command with its literal exit code. All of them:
`PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"` plus the `/tmp/corepack-shim` launcher
(bare `pnpm` exits `127` on this host).

**A1 — the build candidate matrix, after declaring `//#build` and `//#test`.**

| candidate | packages in scope | executed | exit | wall |
| --- | --- | --- | --- | --- |
| (a) `turbo run build` *(CHOSEN)* | `//, @repo/api, @repo/foundation, @repo/kg, @repo/wiki` | `@repo/kg#build` (tsc) + `//#build` (tsup) = `Tasks: 2 successful, 2 total` | `0` | 11.92 s |
| (b) `turbo run build --filter=// --filter=@repo/kg` | `//, @repo/kg` | 2 (`//#build`, `@repo/kg#build`) | `0` | 11.81 s |
| (c) `turbo run build --filter=//` | `//` | 1 (`//#build` = tsup) | `0` | 8.02 s |
| (d) `turbo run build --dry=json` | `//, @repo/api, @repo/foundation, @repo/kg, @repo/wiki` | resolved ids only | `0` | — |

(d)'s resolved ids: `//#build` → `tsup`; `@repo/kg#build` → `tsc -p tsconfig.build.json`;
`@repo/api#build`, `@repo/foundation#build`, `@repo/wiki#build` → `<NONEXISTENT>`.

Rejections: **(b)** enumerates the artefact set, so the next package to declare a `build`
script would silently stop being built in CI; **(c)** drops `@repo/kg#build`, so the artefact
the KG image ships (`packages/llmwiki-kg/Dockerfile:113`) stops being built. **(a)** is
extensional and is the shape the owner originally decided.

**Artefact proof for (a)** — both artefacts rewritten by one run, in two distinct directories:
`dist/api.js` mtime `15:26:48.394592097` → `15:36:57.733869943`; `dist/index.js` likewise;
`packages/llmwiki-kg/ts/dist/index.js` mtime `15:28:44.870981518` → `15:36:56.595900258`.
Both sha256 hashes were unchanged across the run (`dist/api.js`
`942e130551f931f7ac843e70863933dfcbe47f5513f07f9eef734231a08f109d`,
`packages/llmwiki-kg/ts/dist/index.js`
`6d0b3e506be50e615177e33b4d3d07743ada1c00497b002f76ac9291510f9df4`), which is what a
deterministic rebuild of unchanged sources should produce. The outDirs are distinct
(`tsup.config.ts:22` → `dist/`; `packages/llmwiki-kg/ts/tsconfig.json:10` →
`packages/llmwiki-kg/ts/dist/`), so no two-writers defect.

**A2 — the test invocation.**

```
$ corepack pnpm exec turbo run test --filter=//
   • Packages in scope: //
   • Running test in 1 package
//:test: $ vitest run
 EXIT=1
 Test Files  1 failed | 823 passed | 3 skipped (827)
      Tests  2 failed | 6141 passed | 4 skipped (6147)
   Duration  344.17s
 Tasks:    0 successful, 1 total
   Time:    5m45.075s
 WALL=345.55 s
 loadavg immediately after: 7.13 5.88 3.93 4/3160 3685631
```

The task list is exactly ONE task, `//#test` = `vitest run` — the full suite. **The only two
failures are the two assertions in the forbidden file** (`declares every turbo task
cache-less` → `expected [ Array(7) ] to deeply equal [ 'fallow', 'lint', 'test', …(1) ]`;
`declares no build task and gives no package a build-emitting surface` → `expected [ Array(7) ]
to not include 'build'`). Nothing else in 827 files fails.

`--filter=llm-wiki-compiler`, restated with its verbatim message and exit:
```
$ corepack pnpm exec turbo run test --filter=llm-wiki-compiler
  x No package found with name 'llm-wiki-compiler' in workspace
EXIT=1
```

Unfiltered `turbo run test` was **not** run for real; its dry count is the documented evidence
(`//#test` + the four package tasks = 5, with `@repo/kg=549` inside `collected=827`).

**A5 — the gates.**

| command | literal result |
| --- | --- |
| `corepack pnpm exec tsc --noEmit` | `EXIT=0` |
| `corepack pnpm run typecheck:tests` | `EXIT=0`; `Test type-check: 1592 files checked; 238 baseline diagnostics in 86 files; no regression.` |
| `corepack pnpm run lint` | `EXIT=0`; `ESLint ratchet: 1664 files scanned; 558 baseline violations in 396 files across 423 rule/file entries; no regression.` — the triple is exactly the `558 / 396 / 423` ceiling, no increase |
| `corepack pnpm run fallow:ci` | `EXIT=0`; `0 dead-code, 0 complexity, 0 duplication introduced since main` |
| `corepack pnpm run test:affected` | `EXIT=78`; `affected: scope resolves to the full unit tier; run `pnpm test` instead` — the documented full-tier decline, which `.github/` escalates |
| `corepack pnpm exec vitest run test/package-task-selection.test.ts` | `EXIT=1`; `Tests 2 failed | 7 passed (9)` — the two pending ratchet failures; the `:207` frozen-root-scripts assertion is among the 7 that pass |
| `corepack pnpm exec vitest run test/package-selection-union.test.ts` | `EXIT=0`; `Tests 12 passed (12)`; census `@repo/foundation=405 @repo/wiki=565 @repo/kg=549 @repo/api=13 meta=70 orphan=29 uncovered=0 collected=827 distinct=827 multiPackage=409` — unmoved |

**Deferred, and owed:** `corepack pnpm test` as a standalone command. The full suite DID run
under A2 (827 files, 345.55 s, `EXIT=1` on the two forbidden-file assertions only), so the
gate of record's behaviour is observed; the standalone re-run is deferred to the follow-up
slice that amends the ratchet test, because a 9-minute suite that fails on exactly one
forbidden-to-touch file proves nothing new until that file moves.

**Reported, not edited:** `typecheck:tests` now reads `1592` files where `docs/turborepo.md`
records `1591`, and `lint` scans `1664` where it records `1662`. Neither is caused by this
change — no `.ts` file was added or removed by it — so the numbers were left as the record of
the slice that measured them, and the discrepancy is reported instead of silently rewritten.

### L8

The follow-up slice. The Manager granted **explicit consent to amend
`test/package-task-selection.test.ts`**, with one condition: the rewritten assertion must be
**proven to bite** by observation, not asserted.

**1. The amendment.** `DECLARED_TASKS` gained the three new keys, in the sorted order the
test compares against:
`["//#build", "//#test", "build", "fallow", "lint", "test", "typecheck"]`. The old case
`declares no build task and gives no package a build-emitting surface` was **rewritten, not
deleted**, and its name now carries the clause that preserves its teeth:

> `declares the root and build tasks cache-less and still gives no non-emitting package a build script`

It asserts four things, in one 22-line test: (1) `build`, `//#build` and `//#test` ARE
declared; (2) every declared task is `cache: false`; (3) no `^build` edge exists anywhere in
`turbo.json`; (4) `@repo/api`, `@repo/wiki` and `@repo/foundation` still declare **no `build`
script** — read from their real manifests through the existing `SURFACES` + `manifestScripts`
helpers, so no path or script is hardcoded. Clause 4 is the invariant the original case
existed for. The file's `@file` header gained one paragraph stating that CI now calls the
graph while `FROZEN_ROOT_SCRIPTS` still pins the ROOT scripts, because those two facts must
not be confused for each other. File length 297 lines, the new test 22 — inside the
400/40 limits.

**2. The bite proof, by observation.** A temporary `build` script was added to
`packages/api/package.json` (`node ../../scripts/package-tasks.ts typecheck --package @repo/api`)
and the file re-run. Verbatim, uncoloured:

```
 FAIL  test/package-task-selection.test.ts > declares the root and build tasks cache-less and still gives no non-emitting package a build script
AssertionError: @repo/api build: expected 'node ../../scripts/package-tasks.ts t…' to be undefined
 ❯ test/package-task-selection.test.ts:240:79
 Test Files  1 failed (1)
      Tests  1 failed | 8 passed (9)
EXIT=1
```

**Clause 4 is the assertion that fired** — `1 failed | 8 passed`, so no other assertion
fired instead, and the `file:line` is `:240:79`, the `manifestScripts(...).build` expectation.
The temporary script was then removed, and the revert was verified rather than assumed:

```
$ git diff --quiet 98c879e89fba7fa38e654e0d37abdcb442ea7830 -- packages/api/package.json; echo $?
0
$ git status --short | grep packages/api/package.json
(no output — the manifest appears nowhere)
```

Re-run after the revert: `EXIT=0`, `Test Files 1 passed (1)`, `Tests 9 passed (9)`.

**3. The owed gate of record, standalone.**

```
$ corepack pnpm test
 Test Files  1 failed | 823 passed | 3 skipped (827)
      Tests  2 failed | 6141 passed | 4 skipped (6147)
   Duration  338.46s
EXIT=1
WALL=339.38 s
loadavg immediately after: 7.04 5.91 4.57 3/3124 3801775
```

**The amendment worked and a DIFFERENT file is now the only red.** The two remaining failures
are `test/control-gates.test.ts`, and they are caused by the front-door change, not by the
amendment:

```
 FAIL  test/control-gates.test.ts > control gates — CI wiring > runs the type-check, the lint ratchet and the full suite inside build-and-test
AssertionError: expected [ …(12) ] to deeply equal ArrayContaining{…}
-   "pnpm test",            # the CI run list no longer contains that literal

 FAIL  test/control-gates.test.ts > control gates — CI wiring > keeps the order: root type-check before the build, the suite after the schema steps
AssertionError: expected 4 to be less than -1
 ❯ test/control-gates.test.ts:116:50
```

`test/control-gates.test.ts` pins CI's **literal `run` strings** — `"pnpm run build"` at `:30`,
and `index("pnpm run build")` / `index("pnpm test")` at `:102`, `:116`, `:118`. Both are gone
from `.github/workflows/ci.yml` because the steps are now named turbo invocations, so
`index(...)` returns `-1` and the ordering assertion compares `4 < -1`. **That file is NOT in
this slice's allowed edit surfaces**, so it is reported as the pending item (`T9`) and was not
touched. It is the same class of coupling as the ratchet test: a frozen literal about CI
behaviour that the front-door change deliberately moved.

**4. The gates, re-observed after the test edit** (the edit changes file length, so these are
not carried over from `L7`):

| command | literal result |
| --- | --- |
| `corepack pnpm exec tsc --noEmit` | `EXIT=0` |
| `corepack pnpm run typecheck:tests` | `EXIT=0`; `Test type-check: 1592 files checked; 238 baseline diagnostics in 86 files; no regression.` |
| `corepack pnpm run lint` | `EXIT=0`; `ESLint ratchet: 1664 files scanned; 558 baseline violations in 396 files across 423 rule/file entries; no regression.` — exactly the ceiling, no increase, and `lint:update` was not run |
| `corepack pnpm run fallow:ci` | `EXIT=0`; `0 dead-code, 0 complexity, 0 duplication introduced since main` |

**5. What this slice did NOT reopen.** `turbo.json` and `.github/workflows/ci.yml` are
untouched by it: `git status --short` lists neither as modified in this slice, and the workflow
still carries exactly the two turbo invocations at `:92` and `:164`. No commit, no push, no
baseline file, no hook bypass, and `lint:update` was never run.

### L9

The third slice. The Manager granted consent for **every consumer under `test/` that freezes a
literal `run:` string this change legitimately removed** — independently established as exactly
`test/control-gates.test.ts` — and independent verification found a defect no local run could
see: **turbo 2's strict env mode strips the job's `env:` block from `//#test`, silently, exit 0.**

**1. The env blocker, measured both ways.** A probe task printing the three variables ran through
`turbo run test --filter=//` in an out-of-worktree copy (`/tmp/env-probe`: `git archive` of HEAD,
the branch's `turbo.json`, its own `--frozen-lockfile` install; no `cp -a`, no worktree writes):

```
# RED — globalPassThroughEnv absent
//:test: PROBE LLMWIKI=UNSET DATABASE_URL=UNSET AKS=UNSET
 Tasks:    1 successful, 1 total
exit=0

# the same variables OUTSIDE turbo, proving the shell was not the problem
PROBE LLMWIKI=postgresql://probe@127.0.0.1:1/nope DATABASE_URL=... AKS=...   (all three present)

# GREEN — after declaring the three names
//:test: PROBE LLMWIKI=postgresql://probe@127.0.0.1:1/nope DATABASE_URL=... AKS=...
 Tasks:    1 successful, 1 total
exit=0
```

`turbo.json` gained, as a top-level key beside `concurrency`:

```json
"globalPassThroughEnv": ["DATABASE_URL", "LLMWIKI_TEST_DATABASE_URL", "AKS_DATABASE_URL"],
```

Accepted by turbo 2.11.10 **by measurement, not memory**: `--dry=json` parses it (exit 0) and
reports the names under `globalCacheInputs.environmentVariables.specified.passThroughEnv`, and the
same probe then printed all three values. Pass-through rather than `env` (a database URL is not an
input to what the suite proves), and a declaration rather than `--env-mode=loose` (loose forwards
everything, and a CLI flag would make CI's graph differ from every local run). **CI was not
reopened:** no `--env-mode` flag, both invocations unchanged, `cache: false`, `dependsOn: []` and
the absence of `^build` all unchanged.

**2. `test/control-gates.test.ts` amended.** The frozen `"pnpm run build"` / `"pnpm test"` literals
became the two turbo invocations (`pnpm exec turbo run build`, `pnpm exec turbo run test
--filter=//`), held in named constants beside the two step labels. Every existing assertion was
kept. The ordering test stayed and got stronger: it proves both labels exist before comparing
them, so a renamed or unnamed step cannot make an ordering pass by accident, and it asserts the
build step precedes the container-image step. A new `describe("control gates — turbo env
pass-through")` asserts that **every** key of the job's `env:` block is either forwarded by
`turbo.json` or listed in `ENV_EXEMPT` with a reason — fail-closed on the job's env block, not on
a `_URL` name pattern.

**3. All three bite proofs, on the final file, with their `file:line`.**

```
# A — build step moved last in ci.yml
AssertionError: Build the distribution and the @repo/kg artefact through the task graph must
precede Build and smoke-test both container images: expected 14 to be less than 7
 ❯ test/control-gates.test.ts:174:64            (1 failed | 14 passed)

# B1 — one name dropped from globalPassThroughEnv
AssertionError: declare these in turbo.json globalPassThroughEnv, or exempt each in ENV_EXEMPT:
expected [ 'AKS_DATABASE_URL' ] to deeply equal []
 ❯ test/control-gates.test.ts:192:107           (1 failed | 14 passed)

# B2 — an unaccounted key ADDED to the job's env block
AssertionError: declare these in turbo.json globalPassThroughEnv, or exempt each in ENV_EXEMPT:
expected [ 'PROBE_UNACCOUNTED' ] to deeply equal []
 ❯ test/control-gates.test.ts:192:107           (1 failed | 14 passed)
```

B2 is the one that matters: it fires on the **accounting** path, so a variable whose name matches
no pattern is still refused. After each probe the file was restored and compared against the
pre-probe copy, never against base (base differs by design now): `ci.yml` sha256
`7bee8fb7d5ff3d12dde4bd1846c3d62862df3d253bf1b1ef8abb45860d57a297` before and after (`cmp` exit 0);
`turbo.json` sha256 `bbd8870ec33f4d17e3bc68e5c41a0fc3ab685db4a5caabde58a6db6215264092` before and
after (`cmp` exit 0). Final state of the file: `Tests 15 passed (15)`, exit 0, 271 lines.

**4. The gate of record, standalone, green.**

```
$ corepack pnpm test
 Test Files  824 passed | 3 skipped (827)
      Tests  6144 passed | 4 skipped (6148)
   Duration  325.10s
EXIT=0
WALL=325.85 s
loadavg immediately after: 7.11 5.67 4.36 3/3093 3942980
```

**5. Gates after the edit.** `tsc --noEmit` `EXIT=0`; `typecheck:tests` `EXIT=0`
(`Test type-check: 1592 files checked; 238 baseline diagnostics in 86 files; no regression.`);
`lint` `EXIT=0`, triple still exactly `558 baseline violations in 396 files across 423 rule/file
entries` over `1664 files scanned`; `fallow:ci` `EXIT=0`. An intermediate shape of the ordering
test was 1 line over `max-lines-per-function` and lint REFUSED it — rewritten data-driven rather
than rebaselined, because `lint:update` is forbidden and a decrease would have meant deletion.

**6. Documentation.** `docs/turborepo.md` corrected the two claims verification refuted (the gap-5
table row saying the KG compile was "now covered" by the removed step, and the gap-9 paragraph
describing it in the present tense — both marked SUPERSEDED with what replaced them), gained the
env-mode section with the measured strip and the declaration, and now states item 6 as a
**conditional naming both silent failure modes** beside the literal exit code. The pre-existing
stale job-map line (`codebase-health` `:132`) was corrected to the measured `:182`.

### L10

The slice is committed in three work units on `feat/ci-turbo-front-door`, and the gate of record was
green at the tree commit 1 holds.

- **Commit 1, the behavioural slice (6 files):** `7e5cccf2d8fb4f01b06a64c7a464e722094c6f9e` —
  `feat(ci): run the build and the full suite through the turbo task graph`. This is the tree the
  full suite passed on: `EXIT=0`, `Test Files 824 passed | 3 skipped (827)`,
  `Tests 6144 passed | 4 skipped (6148)`, load `7.69`, and `tsc`, `typecheck:tests`, `lint`
  (`558 / 396 / 423`) and `fallow:ci` all exit 0.
- **Commit 2, the prose slice (3 files):** `f0732a22d37066cce8e7de3cb26567b3b952c9b3` —
  `docs: state that CI reaches the full suite through turbo`. No test input and no source file
  changed, which is why no suite re-run was owed for it.
- **Commit 3, this evidence:** the commit holding this document's filled `## Tasks` column.

Two advisories from independent verification were closed before the commits, not carried: the
`ENV_EXEMPT` reason is now asserted non-empty (bite: `ENV_EXEMPT[PROBE_EXEMPT] must carry a
reason: expected '' not to be ''` at `test/control-gates.test.ts:196`, 1 failed | 14 passed, then
restored and byte-identical), and this page's green now names which tree each number belongs to.
