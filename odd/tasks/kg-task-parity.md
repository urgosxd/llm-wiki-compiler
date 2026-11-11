# KG task parity with the wiki slice

Branch `refactor/kg-task-parity`. Objective: give `@repo/kg` the treatment the wiki slice gave `@repo/wiki` — every package task equal to the root gate it stands for — and state the measured step that brings Turborepo closer to being the front door instead of a weaker parallel path.

The slice's original premise was falsified by measurement before any write: `@repo/kg#typecheck` is **not** the weaker `tsc` sibling L1 describes; it already routes to the `scripts/kg-typecheck.ts` ratchet (L3). The slice therefore became measurement, one narrow behavioural guard, and a written proposal (L2).

## Specs

**S1 — duplication is measured, never assumed.** "**Do not assume KG has that shape.** Measure first and say plainly whether it does"; "If there is **no duplication**, say so in one sentence and move on. A symmetry that does not exist is not a finding to manufacture."

**S2 — two trees are untouchable.** "**Never delete `packages/llmwiki-kg/LICENSE.md` or anything under `packages/llmwiki-kg/ts/oracle/**`.**"

**S3 — a package task must be its gate, not a lookalike.** "A package task that is weaker than its root gate is exactly the defect class this project spent a week removing; the fix is to make them the same thing, not to add a note."

**S4 — every package task is measured against its root gate.** "For each package task, establish and report" what it runs today, "the root gate it should equal", and whether it is "equal?".

**S5 — a divergence is recorded, not papered over, and no runner is invented.** "**Make the package task the gate**, or say why it cannot be and record the divergence"; for `typecheck:tests`, "Record it as a gap with its measured coverage (1,587 files, 238 baseline diagnostics in 86 files) and do not invent a per-package runner in this slice."

**S6 — KG's derived test selection must match `vitest related`, and the union guard stays empty.** "`turbo run test --filter=@repo/kg` must run the same set `vitest related` would for KG's sources"; "`UNATTRIBUTABLE` is now `[]` and must stay `[]`" — the assertion is kept; the "contrary to your brief" framing is not.

**S7 — the orphaned KG workflow is reported and proposed, not silently moved.** "`packages/llmwiki-kg/.github/workflows/ci.yml` sits at a non-root path, so GitHub never runs it"; "**Do not move it inside this slice without saying what it would run.**" Rewiring CI onto `turbo run` is "my call and I am not taking it now".

**S8 — the roadmap table is the deliverable.** "Produce a table of which pairs are already equivalent, which you made equivalent, and which remain divergent with the reason"; it "is honest about the rest".

**S9 — no caching.** "**Do not enable caching.** `cache: false` stays on every verdict task until a cache key is proven complete, which is out of scope here."

**S10 — a `build` task that runs nothing is a named gap.** "`turbo run build --filter=@repo/kg` **exits 0 having run nothing**": "capture it as a named gap with the evidence and stop there", because what a package `build` means is "a design decision, and it is the user's".

**S11 — every gate exit is reported literally, and nothing existing breaks.** Include "**`pnpm test` alone with its literal exit code**", the lint ceiling "`558 baseline violations in 396 files across 423 rule/file entries`", load average with any timeout; "Every root script keeps working unchanged, `test:affected`'s 78/69/0 survive, and **no CI job may be renamed**".

**S12 — the prohibitions, and the stop rule.** "No history rewriting", "**No hook bypass of any kind.**", no `cp -a` of this worktree, no push, no `--no-verify`, no `HUSKY=0`; "`odd/tasks/**` append-only except the tracker line"; "Report the measured file set before writing; **stop and report above ~20 files**."

**S13 — the report shape.** Report "commit SHAs as **full 40 characters**; `git status --short`; and a `Risk:` line" — "**item 6** is the live one, because a package task that is weaker than its gate is a green that answered a different question."

**S14 — the guard asserts behaviour, never runner source text.** "the guard must assert through the public interface, not by matching the runner's source text"; "If the only expressible form is grepping the runner source, **skip the guard** and write the report." A pin that "matches text while the behaviour drifts" is the defect this project keeps finding.

## Tasks

- [x] T1 — create this ODD feature document — Spec: S12-S13 — route: gentle-ai-worker — commit: (this commit)
- [x] T2 — narrow behavioural guard test proving `node scripts/package-tasks.ts typecheck --package @repo/kg` executes `scripts/kg-typecheck.ts` (the two-direction ratchet) and not `tsc`, observed via the ratchet's own success sentence — Spec: S3-S4, S14 — route: gentle-ai-worker — commit: pending (verified by T4)
- [x] T3 — record the three named gaps in `docs/turborepo.md` following its existing "Named gap N" idiom: (a) no `build` task exists, so `turbo run build --filter=@repo/kg` exits 0 having run nothing; (b) root `typecheck:tests` has no per-package equivalent; (c) `packages/llmwiki-kg/.github/workflows/ci.yml` sits at a non-root path so GitHub never runs it — Spec: S3-S5, S7 — route: gentle-ai-worker — commit: pending (verified by T4)
- [x] T4 — independent verification: all gates, the task↔gate equivalence table, KG selection vs `UNATTRIBUTABLE == []`, roadmap table — Spec: S6-S13 — route: gentle-ai-verify — commit: pending (this slice's commit)
- [x] T5 — make CI compile the @repo/kg artefact and delete the never-run KG workflow — Spec: S5, S14 — route: gentle-ai-worker — commit: pending (this slice's commit)

## Log

### L1

The user's original request, verbatim:

```
Project assignment for branch refactor/kg-task-parity:

Same treatment for KG that wiki just got — and the measurable step toward Turborepo being a front door instead of a weaker parallel path.

Repo: llm-wiki-compiler, `main` at **`7631c0bd5343868a8f8b99cd966437faaee884aa`**. Read `AGENTS.md`. Node 24 ONLY: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>`. pnpm; bare `pnpm` 127 → `corepack pnpm`. `maxWorkers` 4; `pnpm test` alone ~823 files / ~6,127 tests / ~318 s.

## What "the same treatment" means here, and what it does not

The wiki collapse worked because `@atomicstrata/llmwiki-core` was a **second artefact built from wiki's own sources**. **Do not assume KG has that shape.** Measure first and say plainly whether it does:

- `packages/llmwiki-kg` (an app with a Dockerfile) and `packages/llmwiki-kg/ts` (`@repo/kg`) — is there any second artefact built from the same sources, or any duplicate package?
- `@repo/kg` builds `dist` via `tsc -p tsconfig.build.json`. Who consumes it, and is that consumption legitimate or a workaround?
- If there is **no duplication**, say so in one sentence and move on. A symmetry that does not exist is not a finding to manufacture.

**Never delete `packages/llmwiki-kg/LICENSE.md` or anything under `packages/llmwiki-kg/ts/oracle/**`.**

## The real work: a package task that is not the gate is a false green

This is the step the wiki slice surfaced and did not fix. **`@repo/kg#typecheck` is not the gate CI runs.** Root `typecheck:kg` is `scripts/kg-typecheck.ts`, a **two-direction ratchet** against `kg-typecheck-baseline.json`. The package's own `typecheck` script runs the weaker `tsc` sibling. So `turbo run typecheck --filter=@repo/kg` would report success while answering a different question — a turbo task that **looks** like coverage and is not.

For each package task, establish and report:

| package task | what it runs today | the root gate it should equal | equal? |
|---|---|---|---|
| `@repo/kg#typecheck` | reported `tsc` | `typecheck:kg` (`scripts/kg-typecheck.ts`, two-direction ratchet) | **no** |
| `@repo/kg#test` | `vitest` on `src/**/*.test.ts` (142 files) | is that the whole KG test set, or does the root suite cover more? | **measure** |
| `@repo/kg#build` | `tsc -p tsconfig.build.json` | — | n/a |
| `@repo/kg#lint` | ? | does it cover KG with the same rules as root `lint`? | **measure** |

**Make the package task the gate**, or say why it cannot be and record the divergence. A package task that is weaker than its root gate is exactly the defect class this project spent a week removing; the fix is to make them the same thing, not to add a note.

## Two more measured items

1. **`packages/llmwiki-kg/.github/workflows/ci.yml` sits at a non-root path**, so GitHub never runs it — the KG image has **zero CI enforcement**. Measure it, report what that workflow was supposed to do, and propose either a root-level job or its removal. **Do not move it inside this slice without saying what it would run.**
2. **The derived test selection for KG.** `turbo run test --filter=@repo/kg` must run the same set `vitest related` would for KG's sources. Verify against the union guard: `UNATTRIBUTABLE` is now `[]` and must stay `[]`.

## The gradual path to Turborepo, stated as a roadmap not a wish

The condition for Turborepo becoming the front door is that **every package task equals its root gate**. Produce a table of which pairs are already equivalent, which you made equivalent, and which remain divergent with the reason. That table is the deliverable that says how far along "poco a poco" actually is — and it is honest about the rest.

**Do not enable caching.** `cache: false` stays on every verdict task until a cache key is proven complete, which is out of scope here.

## Scope and gate
Report the measured file set before writing; **stop and report above ~20 files**. Every root script keeps working unchanged, `test:affected`'s 78/69/0 survive, and **no CI job may be renamed** — `test-typecheck`, `codebase-health` and `build-and-test (24)` are branch-protection requirements and the lint ratchet runs as a step inside `build-and-test`.

## Gates
`gates:static` · `tsc --noEmit` · `typecheck:tests` · `typecheck:kg` · `lint` (ceiling **`558 baseline violations in 396 files across 423 rule/file entries`**) · `fallow:ci` · `fallow:kg` · `build` · `vitest run test/artifact` · **`pnpm test` alone with its literal exit code** (`set -o pipefail`/`PIPESTATUS`) · `test:pack`. Database freshly provisioned, `TESTCONTAINERS_REUSE_ENABLE=false`, ports via `docker port`. Report **load average** with any timeout — a run under load 17 produced three false 30 s timeouts on this project.

## Hard prohibitions
No history rewriting (no `git reset`, `git restore --staged`, `--amend`). **No hook bypass of any kind.** **No `cp -a` of this worktree** (`.git` is a pointer file; a copy is a second handle on the same gitdir). No push, no `--no-verify`, no `HUSKY=0`. `odd/tasks/**` append-only except the tracker line.

## Report
Whether KG has core-style duplication, with the measurement; **the task↔gate equivalence table** with what each task runs today and what it must equal; the CI workflow finding and a proposal rather than a silent move; the KG selection verification against `UNATTRIBUTABLE == []`; the roadmap table of remaining divergences; every gate exit with the literal suite exit code and lint triple; commit SHAs as **full 40 characters**; `git status --short`; and a `Risk:` line — **item 6** is the live one, because a package task that is weaker than its gate is a green that answered a different question.
```

### L2

Manager correction, verbatim:

```
**Your correction stands, my table was wrong, and your Risk line names exactly how it would have gone wrong.** Do not write the "fix" the brief implied — there is nothing there to fix.

## How I got it wrong, because the mechanism matters for the record

The `@repo/kg#typecheck` = `tsc` claim came from the **Turborepo decline analysis**, which measured the tree **before** `refactor/package-task-selection` (`a9a21dfc`) built `scripts/package-tasks.ts` and its runners. That analysis legitimately found a weaker sibling; the commit immediately after it removed the sibling by routing the task to the ratchet itself. I then quoted a **pre-fix measurement as HEAD state** — the third stale premise I have put in front of you this session, after the core `src/` layout and `PACKAGE_DIRS`. The rule I keep applying to subagent reports ("a locator is not evidence until someone re-reads it against the tree") applies to **my briefs** and I did not apply it to mine. Record it against me in the feature doc.

One accuracy note so the doc does not carry a false contradiction: I wrote *"`UNATTRIBUTABLE` is now `[]` and must stay `[]`"* — that agrees with your finding, it does not oppose it. Keep the assertion; drop the "contrary to your brief" framing on that line only.

## Answer to your question: yes to a narrow guard, under one condition

The equivalence you measured is real **today and unpinned**. Someone adding `"typecheck": "tsc"` to the KG manifest — plausible, since every other package has no `scripts` at all — would silently return the package task to being weaker than its gate, and nothing would notice. That drift is worth one test.

**Condition: the guard must assert through the public interface, not by matching the runner's source text.** A `file:line`-style pin against `package-tasks-runners.ts` is the brittle shape that already bit this project twice, and `file:owner[literal]`'s advisory is on the record for the same reason. So:

- If you can express it by **invoking** `package-tasks.ts typecheck --package @repo/kg` in a mode that reports what it resolved — a small `--print-command`/`--dry-run` flag, with its help text and docs updated per project rule — write the guard. That flag is a legitimate part of this slice.
- If the only expressible form is grepping the runner source, **skip the guard** and write the report. An unexpressible assertion is the defect this project keeps finding, and I would rather have no pin than a pin that matches text while the behaviour drifts.

## Your three divergences, and which are mine

**`build` is the most valuable thing in your report, and it is a named gap, not a slice fix.** `turbo.json` deliberately has no `build` task, so `turbo run build --filter=@repo/kg` **exits 0 having run nothing**. A command that reports success while doing nothing is precisely the defect class this project has spent a week removing — capture it as a named gap with the evidence and stop there. Fixing it means deciding what a package `build` means when `@repo/kg`'s is `tsc -p tsconfig.build.json` for a Dockerfile artefact and root's is tsup over the tree. That is a design decision, and it is the user's.

**`typecheck:tests` with no package equivalent is a real hole** and also a roadmap item: a KG test's types are checked only by the root script. Record it as a gap with its measured coverage (1,587 files, 238 baseline diagnostics in 86 files) and do not invent a per-package runner in this slice.

**CI calling root scripts instead of `turbo run` is my call and I am not taking it now.** Rewiring a branch-protected job to a new front door is a separate, deliberate change with its own RED; doing it inside a slice whose premise just collapsed would be careless.

## So the slice becomes: measurement + one narrow guard + a written proposal

That is a real deliverable even though it is smaller than my brief imagined, and it is the honest one. Report the file set when you know it, then write. If the guard cannot go through the CLI, the slice is the report alone — and say so plainly rather than padding it.
```

### L3

**Measurement finding: there is no core-style duplication in KG.** `packages/llmwiki-kg/` contains no `package.json` at all — its contents are `CONTRIBUTING.md`, `DECISIONS.md`, `db/`, `docker-compose.yml`, `docker-compose.override.yml`, `Dockerfile`, `LICENSE.md`, `odd/`, `README.md` and `ts/`. It is a Dockerfile-only workspace app whose build context is the repository root: the Dockerfile copies `package.json pnpm-lock.yaml pnpm-workspace.yaml` from the root (`packages/llmwiki-kg/Dockerfile:49`, `:90`) and takes its artefact from `packages/llmwiki-kg/ts/`. There is no second package built from the same sources, and no duplicate workspace. The **only** consumer of `@repo/kg`'s `dist` is that Dockerfile: `COPY --from=build /code/packages/llmwiki-kg/ts/dist packages/llmwiki-kg/ts/dist` at `packages/llmwiki-kg/Dockerfile:113` and `CMD ["node", "packages/llmwiki-kg/ts/dist/index.js"]` at `:123`. That consumption is legitimate, not a workaround: it ships the image's runtime entry, and nothing outside the image reads `dist`.

**The L2 premise — `@repo/kg#typecheck` runs the weaker `tsc` — is falsified by reading the file.** `packages/llmwiki-kg/ts/package.json` declares `"typecheck": "node ../../../scripts/package-tasks.ts typecheck --package @repo/kg"`, and `scripts/package-tasks-runners.ts:98` defines `const KG_PACKAGE = "@repo/kg";` while `runTypecheck` (`:302-306`) routes that name to the ratchet:

```ts
function runTypecheck(context: TaskContext): number {
  if (context.surface.name !== KG_PACKAGE) return runGeneratedTypecheck(context);
  const ratchet = path.join(context.root, "scripts", "kg-typecheck.ts");
  return spawnInherit(process.execPath, [ratchet], context.root);
}
```

So `spawnInherit(process.execPath, [path.join(context.root, "scripts", "kg-typecheck.ts")], context.root)` is what `@repo/kg#typecheck` executes — the same two-direction ratchet root `typecheck:kg` runs, not `tsc`. The equivalence is real, and it is unpinned, which is what T2 exists for. The stale-measurement mechanism L2 describes — a pre-fix measurement quoted as HEAD state, which is the same failure mode as the core `src/` layout and `PACKAGE_DIRS` premises — is recorded here against the Manager, as L2 requested.

### L4

**Decision: the guard observes behaviour by RUNNING the CLI, so no `--print-command` flag is added.** `scripts/kg-typecheck.ts` already emits a recognisable success sentence on a clean run — `:257-262` prints `KG package type-check: ${checkedFiles} files checked; ${baselined} diagnostics baselined across ${entries} entries in ${CONFIG_FILE}; no regression.`, with `CONFIG_FILE = "packages/llmwiki-kg/ts/tsconfig.json"` (`:49`) — so the guard invokes `node scripts/package-tasks.ts typecheck --package @repo/kg` and asserts that sentence, which only the ratchet prints and `tsc` never does. L2's flag was the fallback for the case where the resolved behaviour could not be observed; it can be observed, so the flag would be extra surface with no assertion behind it.

**Scope note the guard inherits.** `test/package-task-selection.test.ts` already pins each package's manifest script through its `PER_PACKAGE_TASKS` loop (`:120` `const PER_PACKAGE_TASKS: readonly string[] = ["test", "lint", "typecheck"];`, asserted at `:218-221` as `node ${surface.scriptPath} ${task} --package ${surface.name}`), so a manifest that swapped `typecheck` back to `tsc` is already caught there. The guard's remaining scope is therefore only the **runner's destination** — that the CLI's `typecheck` for `@repo/kg` lands on the ratchet — and it must assert that by execution, never by matching `package-tasks-runners.ts` source text (S14).

### L5

**Correction: the `build` false green is withdrawn — a missing `build` task surfaces as an honest hard error.** The claim carried in the Manager's brief was that `turbo run build --filter=@repo/kg` **exits 0 having run nothing**, and that this is the **green that answered nothing** defect class S10 names. Measured on turbo 2.11.10 during T3, both `corepack pnpm turbo run build --filter=@repo/kg --dry=json` and the real `corepack pnpm turbo run build --filter=@repo/kg` fail with exit code **1** and print `x Missing tasks in project` / ``x Could not find task `build` in project``. A command that fails loudly is not a false green, so the false-green framing is withdrawn rather than repaired: the absence of a `build` task surfaces as an honest hard error. What remains is a smaller and real gap, recorded as Named gap 3 in `docs/turborepo.md` (`:249`): a package `build` is not reachable through turbo at all, and the only place the Docker artefact is built is `packages/llmwiki-kg/Dockerfile:65` (`RUN pnpm --filter @repo/kg run build`), with nothing under `.github/`, `scripts/`, `package.json` or `turbo.json` referencing `tsconfig.build`. @repo/kg's `dist` is consumed only by the image (`packages/llmwiki-kg/Dockerfile:113` COPY, `:123` CMD), as L3 already established.

### L6

**Correction: `typecheck:tests` is not a hole in the direction the brief claimed; the residual hole runs the other way.** The claim carried in the Manager's brief was that a KG test file's types are checked only by root `typecheck:tests` and that no package task covers them. Measured during T3: FALSE, and the truth is the reverse. `packages/llmwiki-kg/ts/tsconfig.json` declares `include: ["src/**/*.ts"]` and excludes only `dist`/`node_modules`; `tsconfig.build.json` drops `*.test.ts` but is NOT the ratchet's config (`scripts/kg-typecheck.ts:49` names `CONFIG_FILE`). So all 142 KG test files are inside the KG ratchet's program. Measured literal summary lines: KG ratchet → `KG package type-check: 357 files checked; 0 diagnostics baselined across 0 entries in packages/llmwiki-kg/ts/tsconfig.json; no regression.` (exit 0); root ratchet → `Test type-check: 1587 files checked; 238 baseline diagnostics in 86 files; no regression.` (exit 0), with 0 of the 86 baselined entries under the KG package. The same 142 files sit in BOTH programs, compiled under different configs (ES2022/bundler + `vitest/globals` + DOM, versus ES2023/NodeNext + `types:["node"]` + `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`/`noUnused*`), neither a superset of the other, so **which coverage is missing** is not expressible as stated. The residual, honestly-recorded gap is the opposite direction: entries in the root program's `test/**/*` and `scripts/` are reproduced by no package task — recorded as Named gap 4 in `docs/turborepo.md` (`:297`), recorded and not closed, and no per-package tests-typecheck runner was invented (S5). The Manager's coverage figures (1,587 files, 238 baseline diagnostics in 86 files) were CONFIRMED exactly.

### L7

**Manager directive, now a standing constraint — and it binds the Manager's own briefs, not only the reports that come back to him.** Verbatim:

```
every factual premise in one of my briefs is either cited with a `path:line` I re-read this turn, or it is labelled UNVERIFIED and you must not act on it. Anything unlabelled and uncited is my memory, and my memory has now been wrong four times against a tree that was one `git show` away.
```

The mechanism the Manager named for the rule is that briefs are written out of session memory of measurements taken at an earlier commit. The four stale premises, each counted against the Manager: the core `src/` layout, `PACKAGE_DIRS`, `typecheck` = `tsc`, and the L5/L6 pair taken together. Every one of them was caught by re-reading the tree, never by trusting the handoff — which is exactly why the rule has to bind the brief as hard as it binds a report.

**Decision on `build`: no `build` task is added to `turbo.json`, and the artefact gap is fixed inside the existing CI job instead.** Turbo's hard error is the honest behaviour — `turbo run build --filter=@repo/kg` exits 1 with ``x Could not find task `build` in project`` (L5) — so there is nothing for a new task to repair, and adding one walks straight back into the earlier decline finding: a `^build` edge declared over packages that emit nothing. The artefact hole, stated as measured: `@repo/kg`'s production artefact is built by nothing in CI; the only builder is `packages/llmwiki-kg/Dockerfile:65` (`RUN pnpm --filter @repo/kg run build`, re-read at `:65` this turn), and no reference to `tsconfig.build` exists under `.github/`, `scripts/`, `package.json` or `turbo.json`. Combined with the fact that the KG workflow never ran (the decision below), the image ships an artefact no CI job has ever compiled. The fix is ONE step added to the existing `build-and-test` job, running `pnpm --filter @repo/kg run build` after the root build. A step inherits the job's required check name, so branch protection stays intact — unlike a new job name, which would have no branch-protection entry and whose red result could be merged past (S11 forbids renaming the existing jobs for the same reason). The requirement the Manager imposed on that step: it must be observed going RED — break `tsconfig.build.json` in the checkout, watch the step fail, restore — because an added CI line nobody saw fail is a hope, not a gate.

**Decision on `typecheck:tests`: recorded, not fixed.** All 142 KG test files live inside the KG ratchet's program; 0 of root `typecheck:tests`' 86 baselined entries are under the KG package; the same files sit in both programs under two configs, neither a superset of the other (ES2022/bundler + `vitest/globals` + DOM versus ES2023/NodeNext + `types:["node"]` + `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`/`noUnused*`) (L6). These are two distinct programs with deliberately different strictness and BOTH are load-bearing. The tempting wrong conclusion is "one is redundant, delete it": neither is redundant, and neither should be deleted. The residual gap is the REVERSE direction — the root program's `test/**/*` and `scripts/` entries are reproduced by no package task. Recorded here as a roadmap item, recorded and not fixed, with no per-package tests-typecheck runner invented in this slice (S5).

**Decision on the never-run KG workflow: `packages/llmwiki-kg/.github/workflows/ci.yml` is DELETED in this slice, executed as T5.** Its unique step — Build at `:63`, the `tsconfig.build.json` compile — is covered by the new `build-and-test` step from the `build` decision above. Everything else about the file is stale for this repo: `working-directory: ts` (`:40`), `-f ../db/schema.sql` (`:58`), and `AKS_TEST_DATABASE_URL` (`:36`) alive only through the `LLMWIKI_TEST_DATABASE_URL` fallback in the resolver at `packages/llmwiki-kg/ts/src/routes/stacks-harness.ts:36-38`, plus a skip guard (`:69`) that `test/fixtures/no-database-fails-loudly.test.ts` now owns. Relocation was REJECTED, because it would resurrect a stale shape under a new path: a workflow that never ran, whose unique content moves into a job that does run, is a document that lies about coverage. Its blob SHA is recorded as `blob SHA recorded in the T5 result`.

**The T2 guard's bite proof — the only executable pin this slice adds.** The guard is a CHARACTERISATION pin on behaviour that was already correct, so there is NO meaningful RED and none is claimed. The bite was proven by mutation instead: forcing `@repo/kg` onto the generated-tsconfig branch made the banner assertion fail while `status === 0` still passed, which proves the content assertion is what discriminates and not the exit code carrying the test. The revert was proven by sha256 identity plus `git diff --exit-code` on `scripts/package-tasks-runners.ts`.

### L8

**Independent verification (T4), every gate exit literal.** `gates:static` 0, `tsc --noEmit` 0, `typecheck:tests` 0, `typecheck:kg` 0, `lint` 0 with the exact triple `558 baseline violations in 396 files across 423 rule/file entries`, `fallow:ci` 0, `fallow:kg` 0, `build` 0, `vitest run test/artifact` 0, `pnpm test` **0** (821 files / 6125 tests / 312.16 s, load 3.34→9.54, no timeouts), `test:pack` 0, `test:affected` **78** — the documented full-tier decline, with the diff `scripts/run-affected-tests.ts` computes empty, which is what 78 means.

**The deleted KG workflow's identity is a blob SHA, confirmed before deletion.** `git rev-parse HEAD:packages/llmwiki-kg/.github/workflows/ci.yml` returned `8f6e9e9a6a86280a625bede87d90d6e8928a991c`, so the content stays addressable once the path is gone (`docs/turborepo.md`, Named gap 5, records the same SHA). Its deletion required updating the delivery-surface inventory pin in `test/pnpm-migration-wiring.test.ts`: the `WORKFLOWS` set's 4th entry was removed and `toBe(4)` became `toBe(3)`. The RED was observed first — `expected 3 to be 4` at `:142` with the deletion in place and the test unedited — then GREEN. **The pin remains an exact literal and was not weakened to a greater-than**: a count over three literally listed workflows is what makes that inventory fail when a delivery surface appears or disappears, and a `toBeGreaterThan` would have made this deletion invisible.

**A3 falsification: the "built by nothing in CI" claim is withdrawn.** The claim was written because the Manager's brief framed it as "the image ships an artefact no CI job has ever compiled"; it is false, because the artefact IS compiled during root `pnpm test` by `test/kg-mcp-e2e/probe-harness.ts:46`/`:86` (measured `packageBuildMs: 5317`), with `dist` read afterwards by `test/kg-mcp-e2e/kg-api-child.ts:41` and `test/kg-mcp-e2e/kg-mcp-child.ts:42`. What survives is a smaller and real gap: **no CI step treats the artefact as a delivery artefact**, so breakage arrives as a red MCP e2e fixture that names the wrong subsystem. The step added to `build-and-test` (`pnpm --filter @repo/kg run build`, `.github/workflows/ci.yml:92-93`) is justified as **signal locality, not coverage** — the compile already happened on every run, and the step's ~5.3 s duplicate inside a 312 s job buys a failure message in the right place, not a check that was missing.

**Method rule, now binding briefs and future claims, not only reports.** `grep` finds declarations, not executions — a claim of the form "nothing does X" requires running the thing or reading the runner, never a grep. All five falsified premises in this slice were conclusions about runtime behaviour drawn from a `grep` or a Dockerfile: the core `src/` layout, `PACKAGE_DIRS`, `typecheck` = `tsc`, the `build` false green (L5), and the artefact claim above. That is the L7 defect at the level of **method** rather than citation, and it is why the five cost a slice's worth of re-measurement.

**S6's literal wording is UNSATISFIABLE, and it is named as unsatisfiable rather than quietly reinterpreted.** The spec asks that `turbo run test --filter=@repo/kg` "run the same set `vitest related` would run". Run literally, that oracle does not exist for KG: `vitest related --run packages/llmwiki-kg/ts/src/index.ts` reports `No test files found, exiting with code 0` — an empty set reported as success, which is the false green this project keeps removing. The derived selection is the only honest oracle: bucket `@repo/kg=549`, `uncovered=0`, and `UNATTRIBUTABLE == []` asserted at `test/package-selection-union.test.ts:67`. The assertion stays, as the spec requires; the wording it was written against cannot be satisfied by the tool that wording names.

**Census class: the change that invalidates a derived census regenerates it in the same commit.** The guard test added one collected file, which moved `collected=823 → 824` and `meta=66 → 67` with the buckets otherwise unchanged (`@repo/foundation=405 @repo/wiki=565 @repo/kg=549 @repo/api=13 orphan=29 uncovered=0 distinct=824 multiPackage=409`), and `docs/turborepo.md`'s published census was regenerated here, in the same commit as the change that staled it. That is a principle for derived numbers, not an incidental fixup: **a printed census is a claim about HEAD, and a claim about HEAD that outlives its tree is the same defect as a stale citation.** A derived number that is published without being regenerated by the change that moves it is a locator nobody re-read.

### L9

**Two residuals were left behind by the delivery slice, and the worker that refused them was right to.** Neither was a failure of that task; both sat outside its allowed edit surfaces, and reporting them beat widening it. The first: the new CI comment above the `@repo/kg` build step still carried the inference A3 had already withdrawn — that CI "shipped a `packages/llmwiki-kg/ts/dist` that nothing here compiled" — so the workflow contradicted its own retraction two lines above the step the retraction justified. It is rewritten to the measured truth: the artefact was compiled only incidentally, by the kg-mcp-e2e harness running `tsc -p packages/llmwiki-kg/ts/tsconfig.build.json` inside root `pnpm test` (`test/kg-mcp-e2e/probe-harness.ts:46`, measured `packageBuildMs: 5317`), so a packaging break surfaced as a red MCP e2e fixture naming the wrong subsystem; the step makes the build explicit delivery work so it fails in a step named for delivery; and it stays a STEP inside the job because a step inherits the required `build-and-test (24)` check name while a new job name has no branch-protection entry. The second: Named gap 4's published census was one file short. `test/package-task-gate-parity.test.ts` added one file to the `typecheck:tests` program — the guard is what staled the number printed beside it, which is the census class of L8 arriving in a document that was not edited by the change — measured this task as `Test type-check: 1588 files checked; 238 baseline diagnostics in 86 files; no regression.`, with `238` and `86` untouched and only the file count moved.

**Doc-split deferral: `docs/turborepo.md` is not split in this slice, and two Manager conditions bound when it may be.** The split is a mechanical move whose real risk is not the move but losing the interlock between a gap, its evidence and its disposition — a heading that travels without its quoted measurement is worse than a long file — so it needs its own RED rather than a `git mv`. It **waits until the image-CI decision lands**, because the five image gaps are mid-correction and splitting now would move them twice, once into a shape the decision then changes. And when it moves it **carries the corrected framing**: "neither image is built or run by any root workflow" (`grep -rn "docker" .github/workflows/` has no match at HEAD, re-run this task), never the understated "the KG image has zero CI enforcement" — accurate about a workflow that never ran, and now the wrong description of a repo whose second image CI equally never builds.

**Commit plan for this slice: two commits, split by risk class so native review can take the pin alone.** The guard pin is risk item 6 — a green that answers a different question — and gets its own commit; the delivery change is risk item 5 (delivery/environment) and goes with its records: the CI step, this document, and `docs/turborepo.md`. `target` — a 9-byte untracked file at the repository root, content `untouched`, observed before this slice began — is deliberately excluded from both commits and is **not investigated**. The honest state is "not investigated", not "not mine": a file nobody can account for is a fact about the tree, and assigning it an owner before looking is the same inference the L8 method rule forbids. (An earlier note wrote `dd/target`; that was a typing error, and the path is `target`.)

### L10

**The docker-image CI gap this document recorded is closed, in `odd/tasks/docker-images-in-ci.md` at `4671bc8fb8500e7a7716266c924a31e176e2a564`.** Both images this repository ships are now built and exercised by one step inside the existing `build-and-test` job, and never pushed anywhere — publishing remains the owner's decision. It stays a STEP rather than a new job for the reason L9 gave and this document keeps re-learning: a step inherits the required `build-and-test (24)` check name, while a new job name has no branch-protection entry and its red result could be merged past. The step runs `.github/scripts/docker-images-check.sh`, which lives under `.github/` precisely because `.dockerignore:59` excludes that directory from every build context, so the runtime image's `/app/scripts` stays byte-identical and the delivered artefact did not change.

**The KG partial-manifest question this document left `unverified` now has a verdict: the install succeeds, and it is tolerated rather than correct.** `Scope: all 3 workspace projects` against the root image's `Scope: all 5`, with two member manifests absent and the two absent members linked as dangling symlinks carrying the placeholder `0.0.0` instead of their real `0.1.0` — the install works, and `--frozen-lockfile` never compared the absent importers at all, because with `--frozen-lockfile` resolution is skipped by construction and `Lockfile is up to date, resolution step is skipped` is not a pass signal.

**The two findings that slice recorded and refused to fix, one line each.** The runtime image ships `migration_open_kg_classification.sql` and `migration_drop_ingest_outbox.sql` while no `SCHEMA_FILES` entry in `scripts/apply-schemas.sh` names either — a documented manual path rather than proven-missing coverage, and a schema question for its own slice. The two Dockerfiles share no base stage and duplicate their enable/install/prune rationale (`Dockerfile:34-44` vs the KG Dockerfile's `:17-29`), which is a drift channel that has already fired once.

**Cost, measured: 147 s cold at HEAD**, 73 s root + 74 s KG, against the earlier 122 s at base — under the +180 s line that would have forced a separate job and a branch-protection change, though with a 33 s margin rather than 58 s and host-specific either way. The deferral condition L9 named for splitting `docs/turborepo.md` — "it waits until the image-CI decision lands" — has now landed; the split itself is still not taken here, and its corrected framing is measured at the image-CI HEAD rather than assumed.
