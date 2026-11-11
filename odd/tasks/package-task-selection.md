# package-task-selection

Feature: give every workspace package its own task surface — `test`, `lint`, `typecheck` and a `fallow`-equivalent where one makes sense — with each package's test set derived at run time from the import graph rather than enumerated.
Not: a gate migration. The gate of record stays `pnpm test` at the root, and no gate path is routed through Turborepo.

## Specs

S1. The user's goal, verbatim: *"If I modify the wiki dimension, I'd like only the wiki package to run its tests — same for KG. Not just tests: other tools too, like fallow, CI."* So `turbo run test --filter=@repo/wiki` must be **true**, and `turbo run lint --filter=@repo/kg` must be **true**.

S2. The constraint, verbatim: **"derive the selection, never enumerate it"**. The brief's "THE CONSTRAINT THAT DECIDES THIS SLICE" section states it in full:

```
The tests do **not** live inside the packages. Wiki's dimension coverage is in `test/dimensions/wiki/`, compiler coverage in `test/compiler/`, and so on. So two designs exist:

- **A hardcoded per-package path list** (`--dir packages/wiki/src test/dimensions/wiki …`). It works today and **rots tomorrow**: someone adds `test/dimensions/wiki-v2/` and the filter silently misses it, with nothing failing. That is the same defect as the advert guard that scanned 6 of 16 files, and I am not authorising it.
- **A derived selection**: for each package, the test files that **transitively import** that package's sources. Derived at run time from the import graph, so it cannot drift. This is the one.

`vitest related` already builds that graph, so the machinery exists — reuse it rather than writing a second resolver. `scripts/test-partition.ts` already classifies by content; do not duplicate its rules either.

**If a durable derived selection turns out not to be reachable in this slice, stop and report** rather than shipping the enumerated version with a caveat.
```

S3. The union assertion, verbatim:

```
**The union of every package's derived test set must equal the full collected suite** (819 files at this base, minus whatever the change itself legitimately alters). If the union is smaller, packages have a hole and something stopped being tested. That single check is the difference between a filter and a way to stop running tests while everything stays green.
```

S4. The bite proof, verbatim: **"Prove it bites: make one package's selection lose a file and show the guard failing."**

S5. Scope item 1, verbatim: "**Per package** (`@repo/foundation`, `@repo/wiki`, `@repo/kg`, `@repo/api`): `test`, `lint`, `typecheck`, and a `fallow`-equivalent where one makes sense. Each `test` derives its set as above. Each `lint`/`typecheck` scopes to that package's sources plus the tests that belong to it."

S6. Scope item 2, verbatim: "**`turbo.json`** with the declared graph, a real `dependsOn` for what genuinely depends on what, and **`cache: false` on every task that produces a verdict.** The user's goal is **order and selection, not speed by cache**. Do not enable caching; if you believe a key is provably complete, propose it with the argument."

S7. Scope item 3, verbatim: "**Every existing root script keeps working unchanged**: `test`, `test:unit`, `test:integration`, `test:affected`, `test:pack`, `gates:static`, `build`, `lint`, `fallow:ci`, `fallow:kg`, `typecheck:tests`, `typecheck:kg`. `test:affected`'s exit codes (**78** full tier, **69** uncomputable, **0** true negative) are meaningful and must survive. A script that silently narrows is a gate that lies."

S8. Scope item 4, verbatim: "**No CI job renames.** `test-typecheck`, `codebase-health` and `build-and-test (24)` are branch-protection requirements, and the lint ratchet runs as a **step inside** `build-and-test` so it inherits the required check name. Renaming or splitting a job silently un-gates `main`; if anything must change there, say so loudly."

S9. The three prohibitions, verbatim:

```
- Do not move 800 test files as a first resort. The derived selection exists precisely so the file layout does not have to change. If a move turns out to be necessary, report before doing it.
- Do not add a `build` task to a package that emits nothing just to make `^build` edges exist — a task that succeeds without an artifact is the defect this whole chain rejects.
- Do not route any gate through Turborepo. The gate of record stays `pnpm test` at the root.
```

S10. The Manager direction, verbatim: "@atomicstrata/llmwiki-core is transitional. Do not give it a full task surface (`test`/`lint`/`typecheck`/`fallow`). Treat it as a member that will become a thin alias or disappear, and say so in your design." And: "with core transitional, the union check must still equal the full suite. If a test currently attributes only to core, the union will show it as unattributed — that is information, not a failure, and it is precisely the kind of hole this slice exists to surface. Report any such test by name rather than absorbing it."

S11. Measured design facts at this base — recorded as measurements, not proposals:

- The derivation is a crawl of vitest's own vite module graph, driven by `vitest.config.ts` with aliases identical to vitest's, run in two passes to a fixed point.
- `transformRequest` executes no test body and no module top level.
- A full crawl of 819 files takes ~5.2 s, peaks at ~415 MB, resolves 1560 modules and records 0 transform failures. It requires no `dist/` and no database, and it does not run `globalSetup`.
- It reproduces `vitest related` exactly: 6/6 files for `packages/wiki/src/index.ts`, and 23/23 for that file plus `packages/wiki/src/sdk/compiler-composition.ts`.
- `Selection(P)` = the collected tests whose transitive closure intersects `P`'s source roots, UNION the collected tests living under `P`'s own directory.
- A test is `meta` when its closure intersects the declared meta roots (`scripts/`, `test/fixtures/`, `test/sdk/`) AND intersects no package source root AND the test is not under a package directory.
- A test is `orphan` when its closure is the test itself only and it is not under a package directory.
- Measured buckets at this base: `@repo/foundation` 406, `@repo/wiki` 566, `@repo/kg` 550, `@repo/api` 11 (+2 by the directory rule), meta 62, orphan 29, collected 819. 410 tests span more than one package, which is expected and must not be "fixed".
- Type-only imports are erased by the ssr transform, so `test/query-candidate-id-absent.test.ts` and `test/sdk/published-dimensions-port.test.ts` are orphan although their text imports wiki sources; `vitest related` misses them identically.
- `@repo/kg` must run under the ROOT vitest config, never `packages/llmwiki-kg/ts/vitest.config.ts`, whose `include: ["src/**/*.test.ts"]` collects 142 of 820 files.
- `@repo/kg` typecheck must invoke the root ratchet `scripts/kg-typecheck.ts` scoped to the package, never the weaker `tsc --noEmit` lookalike.
- `turbo@2.11.10` is installable (verified).

S12. The gates, verbatim: "`gates:static` · `tsc --noEmit` · `typecheck:tests` · `typecheck:kg` · `lint` (ceiling **`558 baseline violations in 396 files across 423 rule/file entries`**; decrease-only rebaseline allowed with the diff verbatim and the new triple reported; `lint:update` cannot record a decrease — decrement the named keys by hand if needed) · `fallow:ci` · `fallow:kg` · `build` · `vitest run test/artifact` · **`pnpm test` alone with its literal exit code** (`set -o pipefail` or `PIPESTATUS`). Report **load average** with any timeout — a run under load 17 produced three false 30 s timeouts on this project."

## Tasks

- T1 | S1, S2 | worker | the feature document and the turborepo.md log entry | (this task)
- T2 | S2, S11 | worker | module-graph crawl core with the frozen parity fixtures as a red-then-green test
- T3 | S3, S4, S10, S11 | worker | package/meta/orphan selection with the union guard and its bite proof
- T4 | S1, S5, S6, S10 | worker | per-package scripts, turbo.json, turbo devDependency, .gitignore
- T5 | S7, S8, S9 | worker | docs and the proof runs that root scripts and CI names are unchanged | 19815dd77e36d3f26a6ea83a769678f032983df0
- T6 | S1-S12 | verify | independent verification of every S#

## Log

L1 — the user's original request (the inherited brief `project-brief#88`), verbatim:

```
Give every workspace package its own task surface, so a change to one package runs that package's tools — and only those — under a declared graph. This is the prerequisite Turborepo needs, and the reason it was declined: **today no package can be asked to run its own tests, because its tests do not live inside it.**

Repo: llm-wiki-compiler, `main` at **`a12fd91f1fe850e77b46a0698cec29ae22e188fa`**. Read `AGENTS.md`. Node 24 ONLY: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>`; the pre-commit hook refuses a wrong major. pnpm; bare `pnpm` 127 → `corepack pnpm`. `maxWorkers` 4; `pnpm test` alone is ~819 files / ~6,099 tests / ~310–380 s.

## The goal, in the user's words

*"If I modify the wiki dimension, I'd like only the wiki package to run its tests — same for KG. Not just tests: other tools too, like fallow, CI."* So `turbo run test --filter=@repo/wiki` must be **true**, and `turbo run lint --filter=@repo/kg` too.

## THE CONSTRAINT THAT DECIDES THIS SLICE: derive the selection, never enumerate it

The tests do **not** live inside the packages. Wiki's dimension coverage is in `test/dimensions/wiki/`, compiler coverage in `test/compiler/`, and so on. So two designs exist:

- **A hardcoded per-package path list** (`--dir packages/wiki/src test/dimensions/wiki …`). It works today and **rots tomorrow**: someone adds `test/dimensions/wiki-v2/` and the filter silently misses it, with nothing failing. That is the same defect as the advert guard that scanned 6 of 16 files, and I am not authorising it.
- **A derived selection**: for each package, the test files that **transitively import** that package's sources. Derived at run time from the import graph, so it cannot drift. This is the one.

`vitest related` already builds that graph, so the machinery exists — reuse it rather than writing a second resolver. `scripts/test-partition.ts` already classifies by content; do not duplicate its rules either.

**If a durable derived selection turns out not to be reachable in this slice, stop and report** rather than shipping the enumerated version with a caveat.

## The assertion that makes it safe

**The union of every package's derived test set must equal the full collected suite** (819 files at this base, minus whatever the change itself legitimately alters). If the union is smaller, packages have a hole and something stopped being tested. That single check is the difference between a filter and a way to stop running tests while everything stays green.

Prove it bites: make one package's selection lose a file and show the guard failing.

## Scope

1. **Per package** (`@repo/foundation`, `@repo/wiki`, `@repo/kg`, `@repo/api`): `test`, `lint`, `typecheck`, and a `fallow`-equivalent where one makes sense. Each `test` derives its set as above. Each `lint`/`typecheck` scopes to that package's sources plus the tests that belong to it.
2. **`turbo.json`** with the declared graph, a real `dependsOn` for what genuinely depends on what, and **`cache: false` on every task that produces a verdict.** The user's goal is **order and selection, not speed by cache**. Do not enable caching; if you believe a key is provably complete, propose it with the argument.
3. **Every existing root script keeps working unchanged**: `test`, `test:unit`, `test:integration`, `test:affected`, `test:pack`, `gates:static`, `build`, `lint`, `fallow:ci`, `fallow:kg`, `typecheck:tests`, `typecheck:kg`. `test:affected`'s exit codes (**78** full tier, **69** uncomputable, **0** true negative) are meaningful and must survive. A script that silently narrows is a gate that lies.
4. **No CI job renames.** `test-typecheck`, `codebase-health` and `build-and-test (24)` are branch-protection requirements, and the lint ratchet runs as a **step inside** `build-and-test` so it inherits the required check name. Renaming or splitting a job silently un-gates `main`; if anything must change there, say so loudly.

## Do not
- Do not move 800 test files as a first resort. The derived selection exists precisely so the file layout does not have to change. If a move turns out to be necessary, report before doing it.
- Do not add a `build` task to a package that emits nothing just to make `^build` edges exist — a task that succeeds without an artifact is the defect this whole chain rejects.
- Do not route any gate through Turborepo. The gate of record stays `pnpm test` at the root.

## Checkpoint
**Report the measured file count before writing**, and **stop if the change exceeds ~30 files.** State plainly which design (derived vs enumerated) you achieved, and if derived, how the graph is built and why it cannot drift.

## Gates
`gates:static` · `tsc --noEmit` · `typecheck:tests` · `typecheck:kg` · `lint` (ceiling **`558 baseline violations in 396 files across 423 rule/file entries`**; decrease-only rebaseline allowed with the diff verbatim and the new triple reported; `lint:update` cannot record a decrease — decrement the named keys by hand if needed) · `fallow:ci` · `fallow:kg` · `build` · `vitest run test/artifact` · **`pnpm test` alone with its literal exit code** (`set -o pipefail` or `PIPESTATUS`). Report **load average** with any timeout — a run under load 17 produced three false 30 s timeouts on this project.
Database: freshly provisioned, `TESTCONTAINERS_REUSE_ENABLE=false`, ports via `docker port`.

## Hard prohibitions
No history rewriting (no `git reset`, no `git restore --staged`, `--amend`). **No hook bypass of any kind.** **No `cp -a` of this worktree** (`.git` is a pointer file; a copy is a second handle on the same gitdir). No push, no `--no-verify`, no `HUSKY=0`. `odd/tasks/**` append-only except the tracker line.

## Report
The per-package selection design with the proof it derives rather than enumerates; **the union-equals-full-suite assertion and its bite proof**; what `turbo run test --filter=@repo/wiki` actually ran versus what `vitest related` on a wiki source returns (they must match); every existing script's before/after; whether any CI job name moved; every gate exit with the literal suite exit code, the lint triple and load average; commit SHAs as **full 40 characters**; `git status --short`; and a `Risk:` line arguing **item 6** explicitly — a selection that misses files is a green that stopped looking, and that is the one failure this slice can hide.
```

L2 — the Manager direction change, verbatim: "@atomicstrata/llmwiki-core is transitional. Do not give it a full task surface (`test`/`lint`/`typecheck`/`fallow`). Treat it as a member that will become a thin alias or disappear, and say so in your design." And: "with core transitional, the union check must still equal the full suite. If a test currently attributes only to core, the union will show it as unattributed — that is information, not a failure, and it is precisely the kind of hole this slice exists to surface. Report any such test by name rather than absorbing it."

L3 — the decision that shapes T2, with its evidence: `vitest related` in vitest 3.2.7 has no enumeration mode. Its CLI accepts file paths, `--filesOnly` and `-t/--testNamePattern`; it prints the selected files, but no flag returns the set as data. `related <dir>` and `related <glob>` exit `0` with zero tests, because an argument that matches no collected file contributes no reverse-dependency edges — a silent empty selection that reports green having run nothing. The derived selection is therefore obtained by crawling vite's module graph directly, which is the same graph `related` uses (aliases from `vitest.config.ts`, `transformRequest` per module) and which reproduces `related` exactly for two oracle inputs (6/6 and 23/23, S11). That parity is what makes the crawl a reuse of the existing machinery rather than a second resolver.

L4 — the census measurement: with the two-pass crawl complete at `a12fd91`, the collected suite of 819 files partitions as `@repo/foundation` 406, `@repo/wiki` 566, `@repo/kg` 550, `@repo/api` 11 (+2 by the directory rule), meta 62, orphan 29. The buckets overlap heavily — 410 tests span more than one package — so their sum far exceeds 819, and the union is what the guard compares. Self-inclusion versus self-exclusion of a package's own directory accounts for a 729-vs-727 union delta of exactly `packages/api/src/main.test.ts` and `packages/api/src/main-subcommand-flags.test.ts`: both live inside `packages/api`, and neither imports a package source, so only the directory half of `Selection(P)` reaches them.

L5 — the named limitation: closure-internal guards cannot detect a *resolution* error that reroutes a test into the meta bucket. If an alias or a resolution ordering changed so that a test's closure pointed at `scripts/` or `test/fixtures/` transitively instead of at a package source root, that test would still be collected, excluded from every package, and look like a legitimate meta attribution — the union would show a hole only if nothing else claimed it, and the meta bucket would absorb the loss silently. Only parity against `vitest related` can see that class of error, which is why the frozen parity fixtures are mandatory and not optional.

L6 — T5: the orphan ratchet reconciled, and the turbo/pnpm prerequisite recorded.

(i) **The orphan ratchet, reconciled rather than widened.** T4 added `test/package-task-selection.test.ts`, which pins `turbo.json` and the workspace manifests as policy data. It became a genuine new orphan: the union guard went RED with `expected [ …(29) ] to deeply equal [ …(28) ]`, the diff naming exactly `+ "test/package-task-selection.test.ts"` and nothing else, exit `1`. Investigated before touching the list: it imports `node:fs` (:39), `node:path` (:40) and `vitest` (:41) and no repo module — no `../scripts/`, no `../packages/` — and its inputs are data files read at run time through `readFileSync` (:120 inside `readJsonc`, `:131` for each manifest): `turbo.json` (:126) and `packages/*/package.json`. Its closure is therefore itself alone, which is the orphan rule by construction, so the entry was added to `FROZEN_ORPHANS` with that justification in a comment. Nothing else in the list was touched, and the UNATTRIBUTABLE entry (`test/artifact/facade-surface.test.ts`) is unchanged. Re-run: GREEN, `6 passed`, exit `0`, census `@repo/foundation=406 @repo/wiki=566 @repo/kg=550 @repo/api=13 meta=63 orphan=29 uncovered=1 collected=822 distinct=821 multiPackage=410`.

(ii) **The turbo prerequisite, stated where operators read it.** `turbo` shells out to the bare `pnpm` binary, so on a host where bare `pnpm` exits `127` — measured on this host: `command -v pnpm` resolves to `~/.local/share/pnpm/bin/pnpm`, whose `exec` target is missing — turbo fails with `127` before running anything. That is the same launcher defect `scripts/pnpm-invocation.ts` exists to work around for the other gates, and turbo has no equivalent indirection. `docs/turborepo.md` therefore carries a PREREQUISITE section: `corepack enable` (or putting the corepack shim on `PATH`), the fact that CI's `pnpm/action-setup` supplies a working `pnpm`, and the statement that this is an environment prerequisite and not a defect of the graph. No real `turbo run` was executed while writing the page; only `turbo run --help` and a `--dry=json` flag-parse probe.
