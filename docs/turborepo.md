# Turborepo: the derived per-package task graph

Maintainer and operator reference for `turbo.json`, the per-package `test`,
`lint`, `typecheck` and `fallow` scripts, and the selection that sits behind them.
This page is repo-facing (plain `.md`, not part of the published Mintlify site),
because `turbo.json` is JSONC with inline reasoning and the fuller argument — the
measurements, the rejected alternatives, the known holes — needs a page.

The design rule the whole thing exists for, verbatim:

> **derive the selection, never enumerate it.**

A hand-written per-package path list works today and rots tomorrow: someone adds
`test/dimensions/wiki-v2/`, the filter silently misses it, and nothing fails.
That is the "a green that stopped looking" defect, and it is the one thing this
slice can hide, so everything below is derived from the module graph at run time.

## The graph: four tasks, and not one of them cached

| task        | `dependsOn` | `cache` | what it runs                                        |
| ----------- | ----------- | ------- | --------------------------------------------------- |
| `test`      | `["^test"]` | `false` | the package's derived test selection, root config    |
| `lint`      | `[]`        | `false` | the house-rule ratchet, narrowed to the package      |
| `typecheck` | `[]`        | `false` | the package's sources plus its derived tests         |
| `fallow`    | `[]`        | `false` | the root `fallow:kg` gate, for `@repo/kg` only       |

**Every task is `cache: false`, and that is the point of the file.** The goal here
is **order and selection, not speed**. A cache hit is a green that did not
execute: the task reports success because an identical key was trusted, not
because anything ran. This repository has spent a long time removing exactly that
class of green, so caching stays off until someone produces a provably complete
input set *in writing* — flipping the flag is not the argument.

`test` declares a real dependency edge and the other three declare none:

- `^test` orders a package's tests **after** its workspace dependencies' tests.
  Every `test` task runs against **one** pgvector database, provisioned once by
  `test/global-setup.ts` and seeded per worker by
  `test/setup/test-database-url.ts`. Two suites writing the same schema in the same
  container produce a victim that is non-deterministic, so the dependant must never
  run concurrently with its dependencies.
- `lint` and `typecheck` read the tree and report; they order nothing.
- `fallow` exists for one package. `@repo/kg` is the only member with a
  `.fallowrc.json` and baselines; the other three declare no `fallow` script, so
  the task resolves to nothing for them rather than to a scan over no baseline.

`.turbo/` is gitignored: with caching off it holds run summaries and logs, not
verdicts.

## Why there is no `build` task, and why no package gets one

`@repo/api`, `@repo/wiki` and `@repo/foundation` emit nothing. They export
`./src/*.ts` and are bundled from source by the **single** root `tsup` run
(`tsup.config.ts` `noExternal: [/^@repo\//]`). A `build` task over a package that
emits no artifact is a task that reports success without an artifact — the exact
defect this graph exists to avoid — so no `build` task is declared and no `^build`
edge is invented to make the graph look symmetrical.

The packages that genuinely emit keep their own untouched scripts: `@repo/kg`
(`tsc -p tsconfig.build.json`) and `@atomicstrata/llmwiki-core` (`tsup`). The
single real emit for the shipped artifact is the root `tsup` run, and `pnpm run
build` stays the gate for it.

## How selection works, in plain terms

A package's `test` set is **derived at run time from vitest's own module graph** —
the same graph `vitest related` uses — and never from a path list:

1. `scripts/module-graph.ts` boots a vite server with the root `vitest.config.ts`
   (aliases included), then transforms every collected test and every module it
   discovers, in two passes to a fixed point. `transformRequest` parses and records
   imports without executing module top level or test bodies, so the crawl is a
   read, not a run: no `dist/`, no database, no `globalSetup`. It is pinned to
   `vitest related`'s own answers by `test/module-graph-crawl.test.ts`.
2. `scripts/package-selection.ts` turns those closures into a partition:
   `Selection(P)` = the collected tests whose transitive closure reaches `P`'s
   source roots, **union** the collected tests living under `P`'s own directory.
   The directory clause is load-bearing, not a convenience:
   `packages/api/src/main.test.ts` and
   `packages/api/src/main-subcommand-flags.test.ts` live inside `@repo/api` and
   import no other repo module, so the graph clause alone loses both.
3. `scripts/package-tasks.ts` runs the task: it asks the runner for the collected
   universe (`vitest list --filesOnly --json`), derives the selection, and passes
   the derived files to `vitest run` as positional filters **under the root
   config**. Positional filters match by substring, so they can widen silently;
   the run also writes vitest's JSON report and
   `scripts/package-tasks-exactness.ts` compares the set of files that **actually
   ran** against the derived set. Any difference in either direction exits `3`
   naming every offending path. The filters save work; the assertion is what makes
   the task exact.

Because of that, **the selection cannot drift**: adding a test that imports the
package picks it up, adding a source file to the package picks it up, adding a new
test directory that imports the package picks it up — nobody edits a list. The
union guard in `test/package-selection-union.test.ts` is the other half: every
collected test must land in some package, in `meta` (`scripts/`,
`test/fixtures/`, `test/sdk/`) or in `orphan`, or the guard fails. Its census at
this commit, printed by the run rather than baked:

```
selection buckets: @repo/foundation=406 @repo/wiki=566 @repo/kg=550 @repo/api=13
meta=63 orphan=29 uncovered=1 collected=822 distinct=821 multiPackage=410
```

```
node scripts/package-tasks.ts <test|lint|typecheck|fallow> --package <@repo/name>
```

## `@atomicstrata/llmwiki-core` is transitional

Core has **no task surface** — no `test`, `lint`, `typecheck` or `fallow` — and it
will become a thin alias of `@repo/wiki` or disappear. Giving it a surface now
would create a surface that has to be deleted later, and a green that means
nothing in the meantime.

The consequence is surfaced rather than absorbed. `test/artifact/facade-surface.test.ts`
imports core's **built** artefacts (`packages/llmwiki-core/dist/index.js`,
`compiler-sdk.js`) dynamically and reaches nothing else in the repository, so no
package selection owns it and core's `dist/` is neither a source root nor a meta
root. The union guard therefore names it explicitly as the one **unattributable**
test and asserts that list by exact equality — a second such name cannot appear
without failing. The root `pnpm test` gate still runs that file; what is on record
is that no per-package run does.

## Known limitation: type-only imports are erased

The derivation reads the module graph, and the ssr transform **erases type-only
imports**. A test that merely `import type`s a package therefore has no edge to
that package's sources and is not selected by it. Two tests are in that position
today and are named in `test/package-selection-union.test.ts`:

- `test/query-candidate-id-absent.test.ts`
- `test/sdk/published-dimensions-port.test.ts`

Both are `orphan` for that reason. `vitest related` misses them identically, so
this is a property of the transform and the graph, not of this crawler — but it is
a real hole in per-package selection, so it stays written down instead of being
papered over by widening a bucket. The root suite runs both.

## `@repo/kg#test` runs under the ROOT vitest config

`packages/llmwiki-kg/ts/vitest.config.ts` keeps `include: ["src/**/*.test.ts"]`,
which collects **142 of the 822** files the root run collects. That is a
package-local config narrowing the suite to a fifth of it, so `@repo/kg#test` does
not use it: every package's `test` task runs under the root `vitest.config.ts` and
passes its derived selection as filters. `@repo/kg`'s `typecheck` likewise invokes
the existing ratchet `scripts/kg-typecheck.ts`, never a `tsc --noEmit` lookalike.

## PREREQUISITE: turbo needs a working bare `pnpm`

**This is an environment prerequisite, not a defect of the graph.** Turbo resolves
the workspace and runs each package's script by shelling out to the **bare `pnpm`
binary**. On a host where bare `pnpm` exits `127`, turbo fails with `127` before
running anything — the same launcher problem this repository already works around
in `scripts/pnpm-invocation.ts`, where the global `pnpm` is a shell wrapper whose
`exec` target was deleted, so `command -v pnpm` succeeds and `pnpm --version`
exits `127`.

Remedy, either:

```bash
corepack enable            # exposes the corepack pnpm shim as `pnpm`
# or put the corepack shim directory that provides `pnpm` on PATH
```

CI needs no special handling: `pnpm/action-setup` puts a working `pnpm` on `PATH`,
so turbo works there by construction. Locally, `corepack pnpm`, `node_modules/.bin/pnpm`
or `npm_execpath` are how the *other* gates survive a broken launcher; turbo has no
equivalent indirection, which is why this page states the prerequisite instead of
implying the graph is broken when `turbo` exits `127`.

Everything on this page was verified by reading the config, running the selection
and its guards, and probing `turbo`'s flag set. No full `turbo run` was executed
while writing it; the documented invocations are the ones a reader runs.

## What the graph does NOT own

- **The gate of record is still root `pnpm test`.** No gate is routed through
  Turborepo, and none may be: `test`, `test:unit`, `test:integration`,
  `test:affected`, `test:pack`, `gates:static`, `build`, `lint`, `fallow:ci`,
  `fallow:kg`, `typecheck:tests` and `typecheck:kg` are byte-identical to what they
  were before this graph existed, and `test/package-task-selection.test.ts` freezes
  them and asserts none of them mentions `turbo`. `test:affected`'s exit codes
  (`78` full tier, `69` uncomputable, `0` true negative) are load-bearing and
  survive unchanged.
- **No CI job name moved.** `test-typecheck`, `codebase-health` and
  `build-and-test (24)` are branch-protection requirements; the lint ratchet is a
  **step inside** `build-and-test` so it inherits that required check name. Turbo
  runs locally, and no workflow was edited.
- **Per-package `lint` is a view, not a replacement.** `scripts/lint-ratchet.ts` is
  a whole-repo gate on a frozen baseline and accepts no scope argument; the package
  task reuses its measurement and narrows it. A scope narrower than the tree it
  audits is a different measurement, so `pnpm run lint` remains the gate.

## Worked example

Run the wiki package's tests:

```bash
turbo run test --filter=@repo/wiki
```

Because `test` declares `dependsOn: ["^test"]`, this runs
`@repo/foundation#test` first — `@repo/wiki` depends on it through `workspace:*`,
and the shared pgvector database must not be written by two suites at once — then
`@repo/wiki#test` over the wiki selection. Add `--only` when you want the filtered
package alone and are not relying on that ordering.

Lint the KG package:

```bash
turbo run lint --filter=@repo/kg
```

Each of these is `pnpm run <task>` inside the package directory, which is
`node ../../scripts/package-tasks.ts <task> --package <name>` — so you can always
run the same work without turbo:

```bash
corepack pnpm --filter @repo/wiki run test
```

See what a filtered run *would* do, without running any task:

```bash
turbo run test --filter=@repo/wiki --dry=json
```

`--dry=json` (`--dry-run=json` is the long form) prints the resolved task graph:
which tasks matched the filter, their `dependsOn` edges, their cache status
(`false` everywhere here) and the `directories`/`command` each one would use.
Combined with a real run it is the fastest way to confirm that a filter selects the
task you meant, and that nothing was cached into a green that did not execute.
