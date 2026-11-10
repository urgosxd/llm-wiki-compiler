# turborepo

Feature: declare an explicit Turborepo task graph over the pnpm monorepo. Turborepo's headline feature is its cache, and **a cache hit is a green that did not execute** — the exact defect this project has spent a week killing. So every task in this slice is declared with `cache: false`, and a checked-in test pins that. The graph is added as a graph, not as a runner: no gate path moves.

## Specs

S1. Turborepo is added as an explicitly declared task graph over this pnpm monorepo (5 workspace members: `packages/api`, `packages/foundation`, `packages/llmwiki-core`, `packages/llmwiki-kg/ts`, `packages/wiki`).

S2. "**`cache: false` on every task that produces a verdict** — `test`, `typecheck`, `lint`, `fallow`, `build`. Optimise later, deliberately, with a proven input set. **Do not enable caching to make it feel like Turborepo.**"

S3. "If you believe a task's cache key is provably complete, propose it with the argument rather than enabling it. A cached `test` task is the single most dangerous thing you could add to this repository."

S4. "**Every existing script must still do exactly what it did.** `gates:static`, `test`, `test:unit`, `test:integration`, `test:affected`, `test:pack`, `build`, `lint`, `fallow:ci`, `fallow:kg`, `typecheck:tests`, `typecheck:kg`. A script that silently narrows is a gate that lies. `test:affected`'s exit codes (**78** = full tier, **69** = uncomputable, **0** = true negative) are meaningful and must survive."

S5. "**The required CI check names.** `test-typecheck`, `codebase-health` and `build-and-test (24)` are branch-protection requirements, and **renaming or splitting a job silently un-gates `main`**. The lint ratchet runs as a *step inside* `build-and-test` for exactly this reason."

S6. "The boundaries themselves stay where they are — ESLint `no-restricted-imports` and `local/dimension-boundary` own those, and Turborepo must not become a second, weaker enforcement layer that disagrees."

S7. "`git ls-files '*.test.ts'` is the source of truth for test counts; the suite ran 819 files / 6,099 tests at `a6999a0`. A Turborepo run that collects a different set is a finding, not a rounding difference."

S8. "Lint ceiling is now **`558 baseline violations in 396 files across 423 rule/file entries`**; a **decrease-only** rebaseline is allowed with the diff shown and the new triple reported; an increase never is."

S9. "**Check load average before concluding anything from a timeout**: a suite run under load 17 produced three false 30 s timeouts on this project. Report the load with the result."

S10. "No history rewriting (no `git reset`, no `git restore --staged`, `--amend`). **No hook bypass of any kind**."

S11. "**No `cp -a` of this worktree** (`.git` is a pointer file; a copy is a second handle on the same gitdir). No push, no `--no-verify`, no `HUSKY=0`. `odd/tasks/**` append-only except the tracker line."

S12. The graph must be *proven*, not asserted: a checked-in test asserts the cache policy and the absence of gate routing through Turborepo.

## Tasks

- T0 | S1-S12 | worker | record the decline decision with its measurements | 3e0ed441d59b6582c8e784d7b2ddde967c9bf762
- T1 | S1, S2, S3, S4, S5, S12 | worker | feature document, then the contract test | dropped (adoption declined — turbo would run no gate and would narrow the collected test set)
- T2 | S1, S2, S3, S4, S6, S12 | worker | `turbo.json`, the `turbo` devDependency, the additive `graph` script, `docs/turborepo.md`, the `AGENTS.md` subsection, the resolved dry-run proof | dropped (adoption declined — turbo would run no gate and would narrow the collected test set)
- T3 | S4, S5, S8, S9 | worker | focused gates (`tsc`, `typecheck:tests`, `lint`, `fallow:ci`, `test:affected`) with literal exit codes | dropped (adoption declined — turbo would run no gate and would narrow the collected test set)

## Log

L1 — the user's original request, verbatim: "Project assignment for branch chore/turborepo:

Add Turborepo to the monorepo. It was deliberately deferred until the four packages were real; they are now — `@repo/foundation`, `@repo/wiki`, `@repo/kg`, `@repo/api` — with `@repo/api` as the actual composition root and a published facade through `@atomicstrata/llmwiki-core`."

L2 — the user's finding, verbatim: "FINDING (ground truth at a6999a0): `@repo/api`, `@repo/wiki` and `@repo/foundation` declare NO build script and export raw `./src/*.ts`; only `@atomicstrata/llmwiki-core` (`build: tsup`) and `@repo/kg` (`build: tsc -p tsconfig.build.json`) build independently. The single real emit is the root `tsup` run, which bundles `@repo/*` from source via `noExternal: [/^@repo\//]` (tsup.config.ts:47). Therefore `dependsOn: ["^build"]` cannot express 'wiki/kg build before api consumes them' without inventing package build tasks that emit nothing — which would be a task reporting success without an artifact. Recorded, not worked around."

L3 — the Manager's decision, verbatim: "Keep the document and commit it. "None of them" is the sentence the assignment was worth producing, and a record of why a tool was declined answers the question someone will ask in six months — "why no Turborepo here?" — with measurements instead of an opinion."

L4 — the decisive measurement, verbatim: "With cache off and gates untouched, the commands a developer or CI would run through turborepo rather than directly are: none of the repo's gates — turbo would offer only three package-level tasks no gate invokes (@atomicstrata/llmwiki-core#build, @repo/kg#build, @repo/kg#test), and what would be different is that the root tsup facade build (dist/api.js, today ordered by tsup.config.ts:21) and the root 819-file vitest run would simply not run at all, while kg's dist and core's dist each gain a second, unsynchronised writer."

L5 — the self-correction, verbatim: "a contract test asserting `cache: false` on tasks that never execute would be a guard against a lie nobody was telling."

L6 — the named gap, verbatim: "NAMED GAP: `packages/llmwiki-kg/.github/workflows/ci.yml` sits at a non-root path, so GitHub never runs it, and the KG image has zero CI enforcement — documented behavior with no gate, our oldest defect class. `git grep -i docker a6999a0 -- .github/workflows` returns no matches. The KG image is built only via `packages/llmwiki-kg/docker-compose.yml:23-25` and documented in `packages/llmwiki-kg/README.md:76` and `CONTRIBUTING.md:38`."

L7 — the three findings that decided it, with citations:

- **(i) The narrowing.** `packages/llmwiki-kg/ts/vitest.config.ts:6` sets `include: ["src/**/*.test.ts"]`, so `@repo/kg#test` collects 142 of the 820 files `git ls-files '*.test.ts'` reports, against the root `vitest run`'s 819 (the root run excludes `test/sdk/packaging.test.ts` at `vitest.config.ts:86`). Routing tests through Turborepo would swap the 819-file set for the 142-file one.
- **(ii) The double-writer hazard.** `scripts/tsup-command.ts:25-32` spawns the tsup CLI with `cwd: packages/llmwiki-core` (`:28`), and `packages/llmwiki-core/tsup.config.ts:35` sets `outDir: "dist"` with `:79` `clean: true` — the same config the package's own `build: tsup` runs. That makes two independent writers of one `dist`, and the precedent is already recorded at `vitest.config.ts:88-90`: "multiple beforeAll(npx tsup) calls were wiping dist/api.js mid-test".
- **(iii) The false-green sibling.** `@repo/kg#typecheck` is `tsc --noEmit`, while the gate CI actually runs is the root `typecheck:kg` = `scripts/kg-typecheck.ts`, a two-direction ratchet against `kg-typecheck-baseline.json` (a new diagnostic fails, and a baselined diagnostic that stopped occurring also fails). A graph built from the package script would advertise a weaker lookalike beside the real gate.

Also recorded: `@repo/kg`'s `dist` **is** consumed — `packages/llmwiki-kg/Dockerfile:112,122` copies and runs it, and `test/kg-mcp-e2e/probe-harness.ts:46` builds it itself at `:86` — so the build graph has two nodes and zero edges. There is no ordering to add.
