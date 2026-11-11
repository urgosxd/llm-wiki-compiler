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
| `test`      | `[]`        | `false` | the package's derived test selection, root config    |
| `lint`      | `[]`        | `false` | the house-rule ratchet, narrowed to the package      |
| `typecheck` | `[]`        | `false` | the package's sources plus its derived tests         |
| `fallow`    | `[]`        | `false` | the root `fallow:kg` gate, for `@repo/kg` only       |

**Every task is `cache: false`, and that is the point of the file.** The goal here
is **order and selection, not speed**. A cache hit is a green that did not
execute: the task reports success because an identical key was trusted, not
because anything ran. This repository has spent a long time removing exactly that
class of green, so caching stays off until someone produces a provably complete
input set *in writing* — flipping the flag is not the argument.

## No task declares a dependency edge. Selection is per package, literally

**`test` used to declare `dependsOn: ["^test"]`, and it no longer does. That edge
must not come back.** The ruling behind it:

- **Database serialisation is a CONCURRENCY concern, not a dependency edge.** Every
  `test` task runs against **one** pgvector database, provisioned once by
  `test/global-setup.ts` and seeded per worker by
  `test/setup/test-database-url.ts`. Two suites writing the same schema in the same
  container produce a victim that is non-deterministic, so the concern is real —
  and it is answered by `"concurrency": "1"` at the **root of `turbo.json`**, which
  forces one task at a time across the whole run. That is strictly stronger than an
  edge would be: it also separates siblings that do not depend on each other, which
  a `^test` edge never did.
- **A dependant's change does not invalidate its dependencies' tests.** Those tests
  already passed against the tree they belong to; re-running them because a
  dependent moved is work no filter asked for. With `^test`,
  `turbo run test --filter=@repo/wiki` executed **972 file-runs** — 406
  `@repo/foundation` files plus the 566 wiki files, as the suite stood when the
  edge was removed — for a filter whose selection was 566. Without it, the
  filtered run executes **exactly** the filtered package's tests.

So a per-package selection means what it says: `turbo run test --filter=@repo/wiki`
runs the wiki selection (565 files in the census below) and starts no foundation
task. `lint`, `typecheck` and `fallow` never had an edge and still declare `[]`.

The concurrency cap is declared in the graph rather than passed by hand **because a
constraint a graph file carries cannot be forgotten, and an environment variable
can**. `TURBO_CONCURRENCY=1` produces the same serialisation, but only for the person
who remembers to type it; `"concurrency": "1"` applies to every invocation, on every
machine, including a future one nobody has told about the database. `turbo` 2.11.10
supports the key at the root of the config file (`node_modules/turbo/schema.json`,
`concurrency`: "Use `1` to force serial execution (one task at a time)"; documented
at `node_modules/turbo/docs/reference/configuration.mdx`, default `"10"`), and the
value is validated on load — an invalid one fails the run with
`Invalid value for `--concurrency` flag`.

`fallow` exists for one package. `@repo/kg` is the only member with a
`.fallowrc.json` and baselines; the other three declare no `fallow` script, so the
task resolves to nothing for them rather than to a scan over no baseline.

`.turbo/` is gitignored: with caching off it holds run summaries and logs, not
verdicts.

## Why there is no `build` task, and why no package gets one

`@repo/api`, `@repo/wiki` and `@repo/foundation` emit nothing. They export
`./src/*.ts` and are bundled from source by the **single** root `tsup` run
(`tsup.config.ts` `noExternal: [/^@repo\//]`). A `build` task over a package that
emits no artifact is a task that reports success without an artifact — the exact
defect this graph exists to avoid — so no `build` task is declared and no `^build`
edge is invented to make the graph look symmetrical.

The packages that genuinely emit keep their own untouched scripts — `@repo/kg`
(`tsc -p tsconfig.build.json`) — and it used to be two: `@atomicstrata/llmwiki-core`
ran `tsup` over wiki's sources as a second artefact, and that emitter is gone with
the package. The single real emit for the shipped artifact is the root `tsup` run,
and `pnpm run build` stays the gate for it.

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
`test/fixtures/`, `test/sdk/`, `test/artifact/`) or in `orphan`, or the guard fails.
Its census at this commit, printed by the run rather than baked:

```
selection buckets: @repo/foundation=405 @repo/wiki=565 @repo/kg=549 @repo/api=13
meta=70 orphan=29 uncovered=0 collected=827 distinct=827 multiPackage=409
```

**That census is REGENERATED, and it was already stale before this slice.** Two corrections landed
in the same commit and are recorded as two, because only one of them is ours. The PRE-EXISTING
drift: the block used to read `meta=67 … collected=824 distinct=824`, while the base commit itself
printed `meta=69 … collected=826 distinct=826` — two test files had landed after it was generated.
This slice's own delta: `test/package-task-boundary-notice.test.ts` reaches `scripts/` and lands in
`meta`, so `meta` +1 and `collected`/`distinct` +1. Before: `meta=67 orphan=29 uncovered=0
collected=824 distinct=824`. After: `meta=70 orphan=29 uncovered=0 collected=827 distinct=827`.

The package buckets (`405/565/549/13`), `orphan=29` and `uncovered=0` did NOT move, and that is the
claim worth checking in the diff: a boundary DECLARATION plus a notice test cannot change what any
package's selection runs, because no collected test file joined or left a package. `orphan=29` is
where the three declared type-only dependents still sit — see
[Named gap 2](#named-gap-2-import-type-orphans).

```
node scripts/package-tasks.ts <test|lint|typecheck|fallow> --package <@repo/name>
```

### The boundary, stated: static import specifiers only

**The selection models static import specifiers and nothing else.** The crawl is vite's
`transformRequest(url, { ssr: true })` walked over `importedModules`, so a dependency is
visible exactly when it is a static `import` **specifier**. Three routes are invisible to that
closure by construction, and no amount of crawling fixes them:

- `require(...)` — a call expression, not a module request the graph records;
- a computed `import(expr)` — the specifier is not a literal, so there is no request to follow;
- `new URL("../..", import.meta.url)` — a string, not a module request at all. This is how
  `test/artifact/dist-specifiers.test.ts`:99 reaches the built root `dist/`, and it is the case
  that decides the design: **a closure over static imports cannot see it**, so the class is
  DECLARED, never modelled.

A fourth route is elided before the graph exists: `import type`, which the ssr transform
erases. [Named gap 2](#named-gap-2-import-type-orphans) records the pairing that answers it.

**Which shapes are refused, and which are merely invisible — the honest boundary.** These are
two different claims and an earlier version of this page ran them together:

- **REFUSED: a type-only dependent that nobody declared.** The set is DERIVED, not frozen:
  `scripts/type-only-dependents.ts` parses every collected test with the TypeScript compiler and
  reports each `(test file, package)` pair whose only route to the package is an elided import —
  `import type { X } from`, `import type X from`, inline `import { type X } from` and
  `export type { X } from`. `TYPE_ONLY_DEPENDENTS` only supplies the reason for each pair, and
  `test/package-selection-union.test.ts` requires the two sets to be EXACTLY equal in both
  directions. So a new dependent fails the run **in whichever bucket it lands**, `orphan` or
  `meta`, and an annotation whose edge is gone fails too.
- **NOT COVERED, by detection or by refusal: `require(`, a computed `import(` and
  `new URL("...")`.** These are calls and strings, not module requests, so no scan of import
  specifiers can enumerate them, and nothing fails when a new one appears. The artefact route at
  `test/artifact/dist-specifiers.test.ts`:99 is that shape. They are undeclared-by-detection, not
  refused — do not read the paragraph below as covering them.

What the declaration buys is that the type-only gap **fails closed — and the fail-closed edge
lives in the union test, not in `assertCoverage`.** `orphan` is an ACCEPTED bucket:
`assertCoverage` counts packages, `meta` and `orphan` as covered, so a test no surface can
attribute runs in no per-package selection and nothing complains — all 29 currently do exactly
that. Changing that would mean changing the bucket's STATUS, not adding a refusal to
`assertCoverage`. What does fail closed is the frozen `orphan` pin,
`expect(result.orphan).toEqual([...FROZEN_ORPHANS])`, for the shape it can see: a new test with
an empty closure ran red with `expected [ …(30) ] to deeply equal [ …(29) ]` and returned to
green when deleted. That pin cannot see a type-only dependent that lands in `meta`, which is why
the derived assertion above exists.

## The recorded direction arrived: no transitional package is left

This page used to head a section "`@atomicstrata/llmwiki-core` is transitional",
recording a package with **no task surface** — no `test`, `lint`, `typecheck` or
`fallow` — and predicting that it "will become a thin alias of `@repo/wiki` or
disappear". It disappeared: `odd/tasks/collapse-core-package.md` collapsed it into
`packages/wiki` and the root `llm-wiki-compiler` package. The workspace is four
private members (`@repo/api`, `@repo/foundation`, `@repo/kg`, `@repo/wiki`), every
one of them has a task surface, and **no member is exempt** from this graph.

The exemption that section described is gone rather than renamed. `test/artifact`
is a `META_ROOTS` directory class in `scripts/package-selection.ts` beside
`scripts/`, `test/fixtures/` and `test/sdk/`, because those suites assert the BUILT
ROOT DISTRIBUTION — one artefact produced from all four members at once — and
attributing them to whichever package's source they happen to exercise would drop
them from every other package's selection. `test/package-selection-union.test.ts`'s
leftover bucket is `UNATTRIBUTABLE = []` and is asserted, so a NEW unattributable
test fails the run instead of joining a list. The retired package's
`test/artifact/facade-surface.test.ts` was deleted with its subject, the assertions
worth keeping moved into `bundle-engine.test.ts` and `entries-load.test.ts`, and
both land in `meta` with the rest of the artifact tier.

### The earlier two-artefact decision, and why it is inapplicable now

`odd/tasks/core-facade-and-packaging.md` decided at `L5`, and restated at `L20`,
that the root tarball could not be made self-sufficient:

> Bundling the engine into the root package would give the process a second
> `AsyncLocalStorage`/lock/error-class instance, and `withQuiet` would silently
> stop applying across that boundary.

The decision cited the warning still in place at
`packages/wiki/src/sdk/compiler-composition.ts`:

> Quiet output must use core's AsyncLocalStorage instance, not a bundled copy.

That decision was right, and the collapse does not reverse it: it removes one of
the two sides the warning is about. A second module-instance token can only exist
while the root bundle inlines the engine AND a second artefact carrying the same
engine is installed — which is exactly why the root `tsup` config externalized the
core. With one artefact the quiet scope is constructed once, by the only bundle
that ships, and `test/artifact/bundle-engine.test.ts` pins that: `var quietScope`
is constructed at most once per bundle, `dist/compiler-sdk.js` constructs none of
its own, and exactly one package's bundles define it. This graph inherits the
simplification — `@repo/kg` is the only member that emits anything, so there is no
second emitters' task to order, which is the second reason the `build` section
above still declares no task.

## `@repo/kg#test` runs under the ROOT vitest config

`packages/llmwiki-kg/ts/vitest.config.ts` keeps `include: ["src/**/*.test.ts"]`,
which collects **142 of the 827** files the root run collects. That is a
package-local config narrowing the suite to a fifth of it, so `@repo/kg#test` does
not use it: every package's `test` task runs under the root `vitest.config.ts` and
passes its derived selection as filters. `@repo/kg`'s `typecheck` likewise invokes
the existing ratchet `scripts/kg-typecheck.ts`, never a `tsc --noEmit` lookalike.

## Roadmap: task ↔ gate equivalence

The front door is Turborepo **only when every package task equals its root gate**. Until then
`turbo run <task> --filter=…` remains a convenience that can answer a question CI never asked,
and a filter that looks like coverage is worse than no filter. This table is the measured
distance between the two — the roadmap as measurement, honestly including the part that is not
equivalent.

| package task | what it runs today | root gate it must equal | equal? |
| --- | --- | --- | --- |
| `@repo/kg#typecheck` | `node scripts/package-tasks.ts typecheck --package @repo/kg`, which spawns `scripts/kg-typecheck.ts` | `typecheck:kg` (`node scripts/kg-typecheck.ts`, two-direction ratchet) | **yes** — both emit the identical sentence `KG package type-check: 357 files checked; 0 diagnostics baselined across 0 entries in packages/llmwiki-kg/ts/tsconfig.json; no regression.` |
| `@repo/kg#test` | derived import-graph selection under the ROOT vitest config, with an exactness assertion on the files that actually ran | the root suite's KG coverage | **yes** — bucket `@repo/kg=549`, package run `Test Files 546 passed / 3 skipped (549)`, `Tests 3775 passed / 4 skipped`, `uncovered=0` |
| `@repo/kg#lint` | the ratchet's own `collectSnapshot`/`compareViolations`, narrowed to the package's files | `pnpm run lint` | **no, by design** — package scope reports `764 files in scope; 381 baseline violations in 274 files`, root reports `1662 files scanned; 558 baseline violations in 396 files across 423 rule/file entries`; a scope narrower than the tree is a different measurement, so the root gate stays the gate of record |
| `@repo/kg#fallow` | re-enters root `fallow:kg` through the resolved pnpm | `fallow:kg` | **yes** |
| `@repo/kg#build` | no `build` task exists in `turbo.json` | — | **no** — `turbo run build --filter=@repo/kg` exits **1** with ``Could not find task `build` in project``; root `pnpm run build` (`tsup`) and package `build` (`tsc -p tsconfig.build.json`) produce different artefacts for different consumers, so this is a design question, not a wiring one |
| `typecheck:tests` | no per-package equivalent exists | `pnpm run typecheck:tests` | **no** — `Test type-check: 1591 files checked; 238 baseline diagnostics in 86 files; no regression.` is reachable only from the root script |

**What is already equivalent:** typecheck, test and fallow. That equivalence was built before
this slice (`a9a21dfc`), and this slice did not change it — it PINNED typecheck by execution
(`test/package-task-gate-parity.test.ts` invokes the CLI and asserts the ratchet's own success
sentence, never the runner's source text) and recorded the rest.

**What this slice made equivalent:** nothing, and that is the honest answer. The slice's premise
— that `@repo/kg#typecheck` ran a weaker `tsc` sibling — was falsified by measurement before any
write (`odd/tasks/kg-task-parity.md`, `L3`). The equivalence already held; what was missing was a
pin, not a fix.

**What remains divergent, and why:** the three "no" rows above. Two are design questions
(`build`, and whether a per-package `typecheck:tests` should exist) and one is an intentional
scope decision (`lint`). The residual from Named gap 4 belongs here too: the root program's
`test/**/*` and `scripts/` entries are reproduced by **no** package task, because a package task
is scoped to its own package by construction.

**Reading the count: 3 of 6 pairs are equal, and the three that are not are three different kinds
of gap.** `lint` differs **by design** — a package-scoped snapshot (`764 files in scope / 381
violations in 274 files`) against the root `1662 / 558 / 423`; not a weaker gate but a different
question, so the root gate stays the gate of record. `build` is **absent from turbo** and fails
honestly with exit 1. `typecheck:tests` is **absent entirely**, with no per-package runner. **Two
of those three need a decision from the user, not a patch.**

**Caching remains OFF on every verdict task.** `cache: false` is set in all four `turbo.json`
tasks (`test`, `lint`, `typecheck`, `fallow`), and enabling it is out of scope until a cache key
is proven complete in writing. A cache hit is a verdict nobody executed.

## Named gap 1: `turbo` requires a working bare `pnpm` on `PATH`

**This is a gap, not a footnote.** Turbo resolves the workspace and runs each
package's script by shelling out to the **bare `pnpm` binary**. On this host bare
`pnpm` exits **127**: the global `pnpm` is a shell wrapper whose `exec` target was
deleted, so `command -v pnpm` succeeds and `pnpm --version` exits `127`. Turbo
therefore fails with `127` **before running anything**, and **the failure names
nothing helpful** — no path, no binary, no hint that a launcher is broken.

This is the same launcher defect `scripts/pnpm-invocation.ts` already works around
the other gates; turbo has no equivalent indirection.

**Proposed durable fix:** route turbo's package-manager invocation through that same
resolver — the one place that already knows how to find a working `pnpm` — so turbo
inherits the workaround instead of each operator repeating it. Until that exists, the
prerequisite is real:

```bash
corepack enable            # exposes the corepack pnpm shim as `pnpm`
# or put the corepack shim directory that provides `pnpm` on PATH
corepack pnpm install --frozen-lockfile # installs the workspace through that shim
```

**The install needs the same launcher, and it is the step that is missing.** A tree
installed by npm has no `node_modules/@repo/*` links, so every task fails as
`Cannot find package '@repo/kg/testing/per-run-database'` — an error about an
internal export, not about the install — instead of as the one command that repairs
it. `test/global-setup.ts` refuses at session start for exactly that reason and
prints the command; the reader-facing statement of it lives in `AGENTS.md`,
"Installing the workspace". That refusal is guarded rather than hoped about:
`test/install-preflight-seam-guard.test.ts` runs the real global setup in a spawned
child against a broken temp root and a healthy temp root, so neither the deferred
workspace imports nor the gated `teardown()` can regress silently.

CI needs no special handling: `pnpm/action-setup` puts a working `pnpm` on `PATH`, so
turbo works there by construction. Locally, `corepack pnpm`, `node_modules/.bin/pnpm`
or `npm_execpath` are how the *other* gates survive a broken launcher; turbo does not
look at any of them, which is exactly why the fix above is the durable one and a
shim on `PATH` is the interim one.

Any `turbo` invocation — including the measurement runs behind this page — needs that
shim or `corepack enable` first. The graph itself is unaffected; only the launcher is.

## Named gap 2: `import type` orphans

**This is a gap, and what answers it is a DERIVED set plus a stated pairing — not a patch to
the graph.** The derivation reads the module graph, and the ssr transform **erases type-only
imports**, so a test that merely `import type`s a package has no edge to that package's
sources and is not selected by it.

**Seventeen pairs today, in two packages, and the number is measured rather than maintained.**
`scripts/type-only-dependents.ts` derives them from the collected suite; seven reach
`@repo/wiki` and ten reach `@repo/foundation`, and `TYPE_ONLY_DEPENDENTS` in
`scripts/package-selection.ts` annotates each with a reason. Two examples of the shapes that
matter: `test/query-candidate-id-absent.test.ts` imports `QueryResult` from
`packages/wiki/src/utils/types.js` and nothing else at runtime, and
`test/viewer-sidebar.test.ts` imports `type { ViewerPage }` while every other repo import is
`test/fixtures` — so it is attributed to `meta`, is absent from the 565-file wiki selection, and
was invisible to a guard that only looked at `orphan`. A frozen list of three names shipped
here first and was short by fourteen, which is why the set is derived and the list is only an
annotation.

**The pairing, written so nobody reads it as a to-do.** A `test` run cannot observe a
type-only edge **at all**, because the import is elided: the emitted JavaScript does not
contain the type, so no runtime assertion can fail on a change to it. That is measured, not
assumed — with `QueryResult` temporarily given `candidateId?: string`,
`vitest run test/query-candidate-id-absent.test.ts` still exits `0`. The tier that **does**
observe it is the root `typecheck:tests` program (`scripts/typecheck-tests.ts` over
`tsconfig.test.json`), which compiles these files: the same mutation makes it exit `1` with
`test/query-candidate-id-absent.test.ts: 1 diagnostics exceeds baseline 0`. A per-package
`typecheck:tests` does not exist and **was declined by the owner**, so there is no
package-level substitute to build; the pairing is root-wide by decision, not by omission.

The consequence in one sentence: **a selective green (`turbo run test --filter=@repo/wiki`)
does not speak for these files' type edges**, and `pnpm run typecheck:tests` is the gate that
does. This page used to claim the files "remain covered by the root `pnpm test` gate" — that
is false: `pnpm test` is the same `test` tier, and it cannot observe an elided import either.
`scripts/package-tasks.ts` prints one line on stderr, before vitest runs, when the package has
declared type-only dependents, so the affected run states this itself instead of leaving the
reader to find it here.

**Why the edge is declared and not modelled.** The recorded direction — record `import type`
specifiers during the crawl and pull those files into wiki's selection — was deliberately not
taken: it would make the `test` tier select files it cannot fail on, while the
`new URL("../..")` route stayed invisible, so the graph would look complete and would not be.
Instead the gap is named and pinned. `test/package-selection-union.test.ts` fails if a
declared entry rots — file gone, no longer in the `orphan` bucket, package owner changed, or
the declared type no longer imported from the declared module — and the frozen `orphan` pin
fails if an undeclared unreachable test appears.

**The exhaustiveness assertion was proven to bite** rather than asserted: a throwaway
`test/zz-throwaway-type-only-probe.test.ts` importing only
`type { QueryResult }` from `packages/wiki/src/utils/types.js` turned
`test/package-selection-union.test.ts` red with `expected [ …(30) ] to deeply equal [ …(29) ]`
and `+ "test/zz-throwaway-type-only-probe.test.ts"` in the diff; the file was deleted and the
run went green.

`vitest related` misses these files identically, so this is a property of the transform and
the graph, not of this crawler.

## Named gap 3: the artefact `@repo/kg` ships is built only incidentally, never as a delivery step

**This is a gap, not a footnote, and it leads with the artefact rather than with turbo.**
`@repo/kg` has a real emit: `packages/llmwiki-kg/ts/package.json` declares
`"build": "tsc -p tsconfig.build.json"`, and `packages/llmwiki-kg/ts/tsconfig.build.json`
extends the package config while excluding `src/**/*.test.ts`, so the package produces
`packages/llmwiki-kg/ts/dist`. That directory is not an internal detail — it is what the
runtime image runs (`packages/llmwiki-kg/Dockerfile:113` copies it, `:123`
`CMD ["node", "packages/llmwiki-kg/ts/dist/index.js"]`).

**RETRACTED: "the artefact was compiled by nothing in CI".** That was this gap's headline, and
it is false. The claim was written because the Manager's brief framed it as "the image ships an
artefact no CI job has ever compiled" — but `test/kg-mcp-e2e/probe-harness.ts:46` had already
been compiling it inside root `pnpm test`:

```ts
const BUILD_ARGS = ["tsc", "-p", "packages/llmwiki-kg/ts/tsconfig.build.json"];  // :46
await run("npx", BUILD_ARGS, { cwd: REPO_ROOT, timeout: BUILD_TIMEOUT_MS, … });  // :86
```

The harness executes inside the suite CI runs, the measured build was `packageBuildMs: 5317`,
and its `dist` output is read afterwards by `test/kg-mcp-e2e/kg-api-child.ts:41` and
`test/kg-mcp-e2e/kg-mcp-child.ts:42`. **A broken `tsconfig.build.json` already fails CI today** —
as a side effect inside an e2e test, not as a named delivery step.

**The method rule this slice earned, and it binds briefs as hard as reports.** Beside the
standing `path:line`-or-UNVERIFIED rule: **`grep` finds declarations, not executions — a claim
of the form "nothing does X" requires running the thing or reading the runner, never a grep.**
This claim is exactly that failure. `grep -rn "tsconfig.build" .github/ scripts/ package.json
turbo.json` returning nothing says nothing about whether a compiler is invoked, because the
invocation lives under `test/` and spells its arguments there. All five falsified premises in
this slice — the core `src/` layout, `PACKAGE_DIRS`, `typecheck` = `tsc`, the `build` "false
green", and this one — were conclusions about RUNTIME behaviour drawn from a `grep` or from a
`Dockerfile`. That is the stale-citation defect one level up: it is the method, not the locator,
that was wrong.

**What survives, as a smaller and true claim:** the failure signal arrives from an unrelated e2e
fixture, deep inside the suite, and **no CI step builds the artefact as a first-class delivery
step**. The only place it was ever built *as an artefact* is the image build —
`RUN pnpm --filter @repo/kg run build` at `packages/llmwiki-kg/Dockerfile:65`; the harness builds
it as a fixture side effect. Root `pnpm run build` is `tsup` over the distribution
(`package.json:27`) and never touches this config. The gap is incidental-versus-explicit, not
"compiled by nobody".

`turbo.json` declares `test`, `lint`, `typecheck` and `fallow`, and no `build`. Turbo 2.11.10
resolves tasks against that declaration, so the command is not merely empty:

```
$ corepack pnpm turbo run build --filter=@repo/kg --dry=json
  x Missing tasks in project
  `->   x Could not find task `build` in project
exit=1

$ corepack pnpm turbo run build --filter=@repo/kg
  x Missing tasks in project
  `->   x Could not find task `build` in project
exit=1
```

**WITHDRAWN: the "false green / exits 0 having run nothing" framing.** The analysis that raised
this gap described the outcome as "`turbo run build --filter=@repo/kg` **exits 0 having run
nothing**". That is not what happens and it is withdrawn, not repaired: both commands above
fail with **exit 1**. The absence of a `build` task in `turbo.json` is an **honest hard
error**, not a green that answered nothing, because an undeclared task key is a hard error
rather than an empty selection. Anyone who believed the green form would go looking for a
silent no-op that does not exist. What the error costs is reachability, not honesty — the
command that would build the artefact cannot run at all.

**No `build` task will be added, and this is a decline rather than a deferral.**
`turbo.json` declares `test`, `lint`, `typecheck` and `fallow`, and keeps doing so. Three of
the four members (`@repo/api`, `@repo/wiki`, `@repo/foundation`) emit no artefact — they
export `./src/*.ts` and are bundled from source by the single root `tsup` run — so a `build`
task plus a `^build` edge would create queued tasks that report success while producing
nothing. That is the decline finding recorded in **"Why there is no `build` task, and why no
package gets one"** above, and it is not restated here.

**ADDRESSED in this slice — by a STEP inside `build-and-test`, not by a new job — and the value
is signal locality, not coverage.** `.github/workflows/ci.yml:91-92` now runs
`pnpm --filter @repo/kg run build` as the step **"Build the @repo/kg artefact the image
ships"**, immediately after the root `pnpm run build` step and before the KG diagnostic
ratchet, using the same config the image uses.

- **What it fixes:** breakage currently arrives as a red `test/kg-mcp-e2e` fixture, which reports
under the MCP e2e suite's name when the thing that broke is packaging. A delivery artefact should
fail in a step named for delivery, beside the other build steps.
- **What it costs:** roughly **5.3 s of duplication** — the same compile the harness already
performs — inside a job whose suite measured **312 s**. That is about **1.7%**.
- **What it does not do: close a coverage hole. There is none.** The artefact was already
compiled on every `pnpm test` run; the step moves where the failure is reported, it does not add
the compile. It is said in those words because a reader comparing the step against the harness
would otherwise read it as duplication with no reason given.

**Weighed, not defended:** if 5 s of duplication in a 312 s job is judged not worth a better
failure message, dropping the step costs nothing but the message. It is recorded here as a
weighed decision about where a breakage should be reported, not as a hole that was closed.

**Why that placement is the safe one:** a step inherits the job's required check name
`build-and-test (24)`, so its red result blocks a merge. A **new job** would introduce a
check name that has no branch-protection entry until someone adds it, so its red result
could be merged past while every required check stayed green. That asymmetry — not
convenience — is why this landed as a step, and it is the same reasoning that keeps the lint
ratchet a step inside `build-and-test`.

**Who consumes each build**, which is why turbo's single `build` key stays declined:

| build | produces | consumed by |
| ----- | -------- | ----------- |
| `@repo/kg#build` (`tsc -p tsconfig.build.json`) | `packages/llmwiki-kg/ts/dist` | **the image is the only production consumer**: built at `packages/llmwiki-kg/Dockerfile:65` (`RUN pnpm --filter @repo/kg run build`), copied at `:113`, run at `:123` (`CMD ["node", "packages/llmwiki-kg/ts/dist/index.js"]`). `dist` is also read by the MCP e2e harness (`test/kg-mcp-e2e/kg-api-child.ts:41`, `test/kg-mcp-e2e/kg-mcp-child.ts:42`), which compiles it itself at `test/kg-mcp-e2e/probe-harness.ts:86`. |
| root `pnpm run build` (`tsup`, `package.json:27`) | `dist/index.js`, `dist/compiler-sdk.js`, `dist/api.js` | the published distribution and the container launcher; every `@repo/*` bundle is inlined by `tsup.config.ts` `noExternal: [/^@repo\//]`. |

Two different artefacts for two different consumers, and turbo can reach **neither** meaning:
`pnpm run build` at the command line and the new CI step both call a named script
directly. Giving turbo a `build` task means deciding which of the two meanings the single
word carries in the graph — they cannot share one task key without one of them silently
becoming the other. Nothing is declared in `turbo.json`; the CI step above is what makes the
artefact gated, and it does so without answering that design question.

## Named gap 4: `typecheck:tests` has no per-package equivalent, and KG's tests are already covered twice

**This is a gap, not a footnote, and the measured shape is the reverse of the one that was
reported.** The claim under test was: a KG test file's types are checked *only* by root
`pnpm run typecheck:tests`, so `turbo run typecheck --filter=@repo/kg` cannot fail on a KG
test's type error. That is **false** — the package task sees KG's tests, and sees them under a
stricter configuration. The residual gap is a different one: the same program is 1,590 files
wide, and no package task reproduces its `test/**/*` and `scripts/` entries at all. The reason
KG is covered is one line of configuration:
`packages/llmwiki-kg/ts/tsconfig.json` declares `"include": ["src/**/*.ts"]` and excludes
only `dist` and `node_modules` (`tsconfig.build.json` is what drops `src/**/*.test.ts`, and it
is not the config the ratchet reads). All **142** `src/**/*.test.ts` files the package's own
`vitest.config.ts` collects are therefore inside the program `scripts/kg-typecheck.ts`
builds — measured through the TypeScript API as `357` file names, `142` of them `*.test.ts` —
and the ratchet prints it:

```
KG package type-check: 357 files checked; 0 diagnostics baselined across 0 entries in packages/llmwiki-kg/ts/tsconfig.json; no regression.
exit=0
```

Because that ratchet is two-directional, a **new** KG test diagnostic is not in
`kg-typecheck-baseline.json` and fails `turbo run typecheck --filter=@repo/kg`. The package
task is not blind to tests; it is the stricter of the two.

The root ratchet's own numbers, taken from its single summary line and nothing else:

```
$ corepack pnpm run typecheck:tests
Test type-check: 1591 files checked; 238 baseline diagnostics in 86 files; no regression.
exit=0
```

The figure was 1,587 when the Manager measured it; this slice's guard test
(`test/package-task-gate-parity.test.ts`) added the one file to this program, the install-preflight
pair (`test/fixtures/install-preflight.ts`, `test/install-preflight.test.ts`) added two more, and the
install-preflight seam guard (`test/install-preflight-seam-guard.test.ts`) added one more — its two
`.mjs` fixtures are not in this program, though they are in the lint scan, which is why that one
reports `1662 files scanned; 558 baseline violations in 396 files across 423 rule/file entries`
where the previous slice measured `1659` files and the same triple. The
census is regenerated in the same change each time so the published number never describes a tree
that no longer exists.

Its program comes from `tsconfig.test.json`, whose `include` names
`packages/llmwiki-kg/ts/src/**/*` beside `packages/wiki/src/**/*`, `packages/api/src/**/*`,
`test/**/*` and the two `scripts` entries — so **the same 142 files are in both programs**,
and the "coverage" of the supposed hole is not expressible: there is no KG test file that
only one of the two checks. Measured against `test-typecheck-baseline.json`, `0` of its `86`
baselined entries are under `packages/llmwiki-kg/ts/src`; under both programs KG tests
currently contribute zero diagnostics.

**What actually diverges is the compiler configuration, not the file set, and neither program
is a superset:**

| | test program (`tsconfig.test.json`) | KG package program (`packages/llmwiki-kg/ts/tsconfig.json`) |
| --- | --- | --- |
| base | root `tsconfig.json`: target `ES2022`, `moduleResolution: "bundler"`, `strict` | own config: target `ES2023`, `module`/`moduleResolution` `NodeNext` |
| ambient types | `types: ["node", "vitest/globals"]`, plus `DOM` libs and `allowImportingTsExtensions` | `types: ["node"]` only, `lib: ["ES2023"]` |
| extra strictness | — | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters` |

So a KG test can be red under one ratchet and green under the other: the package config
rejects ambient vitest globals and unused locals that the test config tolerates, and the test
config supplies DOM libs the package config does not. These are **two distinct programs with
deliberately different strictness, and both are load-bearing**: ES2022 with
`moduleResolution: "bundler"` plus `vitest/globals` and the DOM libs, versus ES2023 with
`NodeNext`, `types: ["node"]` only, and `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` and `noUnused*` switched on. **Neither program is a superset of
the other, so neither is redundant and neither should be deleted.** Collapsing them would
mean one of two real verdicts disappears: the test program is the only one that would catch
a typo against a DOM global, and the package program is the only one that would catch an
unused parameter or an unchecked index in KG source.

**Both ratchets are load-bearing, and that is the divergence to record** — not a missing
check, but two checks over one file set with two sets of rules and two baselines, each of
which can fail independently.

What root `typecheck:tests` covers that **no** package task covers is the part of its `include`
that belongs to no member: `test/**/*` (the meta roots `scripts/`, `test/fixtures/`,
`test/sdk/`, `test/artifact/`) and the two `scripts` entries. The four members' `src` trees do
have package `typecheck` tasks, each under its own configuration — which is why the programme's
package-shaped half is reproducible per package and its meta-shaped half is not: a package task
is scoped to its own package by construction, so a monorepo-wide program cannot be
reconstructed from package tasks alone. That is structural, and it is not a hole in KG.

**The residual gap is the REVERSE direction — a roadmap item, recorded and not fixed.** It
is not "KG's tests are unchecked"; it is "the root program's non-package half has no package
task". `typecheck:tests` includes `test/**/*` and the two `scripts` entries, and **no package
task reproduces any of them**, because a package task is scoped to its own package by
construction. Closing it means a task that belongs to the workspace rather than to a member
— and the two-config split above would have to be resolved first for such a task to mean
anything. Inventing a per-package typecheck-of-tests runner in this slice would have been a
lookalike, so none was invented: this is recorded here as a roadmap item, with the measured
coverage above (1,590 files, 238 baseline diagnostics in 86 files, `0` of them under KG).

**Honest negative worth naming:** `packages/llmwiki-kg/ts/oracle/**` is in **no** tsconfig —
neither `tsconfig.test.json` nor the package config names it. It holds `0` `*.test.ts` files
today (`packages/llmwiki-kg/ts/eval/` holds only `eval-set.json`), so nothing goes unchecked
now; a source or test file added there would be checked by neither ratchet.

## Named gap 5: the KG image's CI workflow sat outside `.github/workflows`, so GitHub never ran it

**This is a gap, not a footnote.** `packages/llmwiki-kg/.github/workflows/ci.yml` exists on
disk, and it is not a workflow in this repository: GitHub reads only the root
`.github/workflows/`, which holds exactly three files (`find .github/workflows -maxdepth 1
-name '*.yml' -o -maxdepth 1 -name '*.yaml'` → `ci.yml`, `publish.yml`,
`typecheck-tests.yml`), and `grep -rn "llmwiki-kg/.github" .github/` prints **no reference**.
The KG image therefore had **zero CI enforcement** while that was the only file describing
it — and nothing in root CI was edited until this slice, so nothing the file was written to
enforce was running anywhere (see the decision at the end of this section).

What the file is: `name: CI` (`:1`), triggers `push` and `pull_request` on `main` (`:3-8`), one
job id **`test`** (`:10`) named **"Typecheck, build and test"** (`:11`) on `ubuntu-latest`, with a
`pgvector/pgvector:pg16` service on `5432` (`aks`/`aks`/`aks`, `pg_isready` healthcheck),
`env.AKS_TEST_DATABASE_URL` (`:36`), and `defaults.run.working-directory: ts` (`:40`). Its
steps, in order:

| # | step | runs | root CI equivalent |
| --- | --- | --- | --- |
| 1 | `actions/checkout@v4` | — | same |
| 2 | `Setup pnpm` | `pnpm/action-setup@v4` | same |
| 3 | `actions/setup-node@v4` | node 24, `cache: pnpm`, `cache-dependency-path: pnpm-lock.yaml` | same, without that path |
| 4 | `Install dependencies` | `pnpm install --frozen-lockfile` (`working-directory: .`, `:54`) | same |
| 5 | `Apply database schema` | `psql "$AKS_TEST_DATABASE_URL" -f ../db/schema.sql` (`:58`) | **stronger** here: `./scripts/apply-schemas.sh` then `CHECK_ONLY=true ./scripts/apply-schemas.sh` (`ci.yml:106`, `:108`), which asserts every tenant table exists AND enforces row-level security |
| 6 | `Typecheck` | `pnpm run typecheck` in `ts/` → `scripts/kg-typecheck.ts` | same gate: `pnpm run typecheck:kg` (`ci.yml:100`) |
| 7 | `Build` | `pnpm run build` in `ts/` → `tsc -p tsconfig.build.json` | **now covered** by the step added in Named gap 3: `pnpm --filter @repo/kg run build` (`ci.yml:92`) |
| 8 | `Test` | `pnpm test 2>&1 \| tee test-output.log` (the package's 142 files) | **superset**: root `pnpm test` collects 827 files, of which KG's selection is 549 |
| 9 | `Guard against silent skips` | fails when the summary line reports more than 4 skips | none, and obsolete here — see below |
| 10 | `Upload failure log` (`if: failure()`) | `actions/upload-artifact@v4` on `ts/test-output.log` | none (ergonomics, not a gate) |

**The one step root CI did not cover explicitly was the build, and that is the whole of the real
loss — with the retraction in Named gap 3 applied.** The artefact the runtime image ships
(`packages/llmwiki-kg/Dockerfile:113`, `:123`) is compiled inside root `pnpm test` by
`test/kg-mcp-e2e/probe-harness.ts:46`/`:86`, so this file's step 7 was never the only compile in
the repository — it was the only *explicit* one, the only place a broken `tsconfig.build.json`
would have failed a step named for building. Root `"build": "tsup"` (`package.json:27`) is the
distribution and never touches that config, and
`grep -rn "tsconfig.build" .github/ scripts/ package.json turbo.json` still finds **no
reference**. **That explicit step is now covered in root CI** by the
`pnpm --filter @repo/kg run build` step added to `build-and-test` (Named gap 3 above), so the
file's unique contribution is no longer unique to a file GitHub does not read.

**The honest negative:** the skip guard is already obsolete. Root `.github/workflows/ci.yml:30-31`
records that the database-backed suites "no longer skip when the harness is unreachable: they
fail loudly instead", and `test/fixtures/no-database-fails-loudly.test.ts` pins it; the
hardcoded allowance of four skips is a count from the standalone project that no longer
describes this suite. Steps 1-6 and 8 are covered, 9 is superseded, 10 is ergonomics, and 7
is the whole of the real loss.

**The file's paths describe a different repository shape.** It was authored when
`packages/llmwiki-kg/ts` was a standalone project whose `.github` sat above `ts/`:
`working-directory: ts` (`:40`), `-f ../db/schema.sql` (`:58`) and
`cache-dependency-path: pnpm-lock.yaml` all resolve against that layout. Here the workspace
root and `pnpm-lock.yaml` are the repository root and `packages/llmwiki-kg/ts` has no lockfile,
so every one of those three paths would resolve wrongly if the file ran at this path. Its
`AKS_TEST_DATABASE_URL` (`:36`) is still a **recognised** name —
`packages/llmwiki-kg/ts/src/routes/stacks-harness.ts:36` reads it first, as its siblings do —
but it is set by nothing in root CI, which supplies `DATABASE_URL`,
`LLMWIKI_TEST_DATABASE_URL` and `AKS_DATABASE_URL` instead; the harness reaches the database
here through the `LLMWIKI_TEST_DATABASE_URL` fallback, not through that variable. So the
file's env name matches this repository only by fallback.

**Decision taken: the file is deleted in this slice.** It moves from "proposal awaiting a
decision" to a decided deletion, recorded with its identity:

```
$ git rev-parse HEAD:packages/llmwiki-kg/.github/workflows/ci.yml
8f6e9e9a6a86280a625bede87d90d6e8928a991c
```

That blob SHA is the durable handle for the content: the file is gone from disk, and what it
contained stays addressable by that SHA for as long as the object is reachable, so the analysis
below can be re-checked instead of trusted.

**What the deletion costs, and why nothing else in the file was worth keeping.** The one
non-redundant step was the build (step 7, `pnpm run build` → `tsc -p tsconfig.build.json`),
and that is now the added `build-and-test` step from Named gap 3. Everything else was either
already in root CI or stale for this repository:

- `working-directory: ts` (`:40`) and `-f ../db/schema.sql` (`:58`) resolve against the
  layout the file was authored for, when `packages/llmwiki-kg/ts` was a standalone project
  whose `.github` sat above `ts/`. Here the workspace root is the repository root, so those
  paths resolve wrongly.
- `AKS_TEST_DATABASE_URL` (`:36`) is set by no root workflow. The harness still recognises
  the name, but it reaches the database through the `LLMWIKI_TEST_DATABASE_URL` fallback at
  `packages/llmwiki-kg/ts/src/routes/stacks-harness.ts:36`, so the variable is alive only by
  fallback, not by configuration.
- The `Guard against silent skips` step (a hardcoded allowance of four skips) is superseded
  by `test/fixtures/no-database-fails-loudly.test.ts`, which now owns that question.
- Step 10's failure-log upload is ergonomics on a run that never happened.

**Relocating the file was rejected, deliberately.** Moving it to `.github/workflows/` would
have resurrected the stale shape under a new path: `working-directory: ts`,
`-f ../db/schema.sql` and the obsolete skip guard would have started running as written,
reporting failures about a repository layout that no longer exists while `build-and-test`
already covers the same ground — and, being a new job name, it would have arrived with no
branch-protection entry (the asymmetry Named gap 3 records). A stale workflow moved is a
stale workflow enforced.

**Execution status: performed.** The file is deleted with a plain `rm` (not `git rm`), and `git
status --short` reports `D packages/llmwiki-kg/.github/workflows/ci.yml`;
`packages/llmwiki-kg/.github/workflows/` is left as an empty untracked directory rather than
re-populated with a stub. Nothing was relocated.

The one thing that had to move with it is the inventory in `test/pnpm-migration-wiring.test.ts`,
which listed this path inside its `WORKFLOWS` set and asserted
`expect(WORKFLOWS.length).toBe(4)`. The entry is gone and the count is `toBe(3)` — still an
exact number over three literally listed workflows, because a count assertion over an explicit
list is what makes that inventory fail when a delivery surface appears or disappears. It was
updated, not loosened. Measured: RED with the delete in place and the test unedited —
`AssertionError: expected 3 to be 4` at `test/pnpm-migration-wiring.test.ts:142:30`, exit 1 —
then GREEN after the two-line update, 9/9 tests, exit 0.

**Gap 3 and gap 5 were one decision, and only one half needed turbo.** With no `build` task
(will not be added — see Named gap 3), step 7's script could not become
`turbo run build --filter=@repo/kg`; it became the same `pnpm --filter @repo/kg run build`
root CI runs, which is what the image runs too.

## Named gap 6: two images, no shared base stage, and the same rationale written twice

**This is a gap, not a footnote, and nothing has gone wrong yet — which is exactly why it is
worth recording before it does.** The repository ships exactly two container images and they
share no stage, no fragment and no generated base:

```
$ wc -l Dockerfile packages/llmwiki-kg/Dockerfile
  226 Dockerfile
  123 packages/llmwiki-kg/Dockerfile
  349 total

$ find . -path ./node_modules -prune -o \( -iname 'Dockerfile' -o -iname 'Containerfile' -o -iname '*.dockerfile' \) -print
./packages/llmwiki-kg/Dockerfile
./Dockerfile

exit=0
```

Two files, no `Containerfile`, no `*.dockerfile`, no third definition anywhere. Both are the
same three-stage shape — `build`, `prod-deps`, `runtime` — with the stage boundaries landing
at the same logical points: root `Dockerfile:47` / `:113` / `:148`, and
`packages/llmwiki-kg/Dockerfile:32` / `:83` / `:96`. Every `FROM` in both files is the same
`node:24-slim`, and **neither image builds on the other**: there is no `FROM … AS` naming a
stage of the sibling file and no cross-image `COPY --from`.

**No shared base stage exists to hold the parts they agree on.** A shared fragment would live
under `docker/`, and that directory holds no Dockerfile content at all:

```
$ git ls-files 'docker/*'
docker/entry.sh
docker/env.example
docker/hub.env.example
exit=0
```

A shell entrypoint and two example env files — no fragment. The two compose services also
build independent contexts rather than one parameterised build: root `docker-compose.yml:49-51`
builds `context: .` with `dockerfile: Dockerfile`, and
`packages/llmwiki-kg/docker-compose.yml:24-25` builds `context: ../..` with
`dockerfile: packages/llmwiki-kg/Dockerfile`. Separate contexts, separate files.

**What is actually duplicated is the reasoning, not just the steps.** Each file independently
repeats its own enable → install → no-prune sequence, and each carries the same justification
as prose. The two rationale blocks are near-restatements of each other: root `Dockerfile:34-44`
("WHY THE RUNTIME TREE IS INSTALLED, NOT PRUNED", the `pnpm prune --prod` deadlock measurement,
the `ep_poll` parking, the 39-minute hang) and `packages/llmwiki-kg/Dockerfile:17-29` (the same
heading, the same measurement, with the KG file's own note that "[t]he same repair, for the same
reason, is at the top of the root `Dockerfile`" at `:29`). A reader who fixes one of these has
two places to carry the change to, and the second place's prose is a hand-copied paraphrase of
the first.

**The specific defects this shape could produce are ABSENT today, and that is a measurement,
not a reassurance.** The failure mode that two independent install sequences admits — invoking
`pnpm` before corepack has installed the shim, so the layer dies with
`/bin/sh: 1: pnpm: not found` (exit 127) — does not occur here. `corepack enable` runs in **all
four** install-bearing stages, before any `pnpm` invocation in its stage: root `Dockerfile:58`
(build) and `:119` (prod-deps); `packages/llmwiki-kg/Dockerfile:41` (build) and `:88`
(prod-deps). Measured by reading every `pnpm` line in both files: no image invokes bare `pnpm`
textually above its `corepack enable`.

```
$ grep -n 'corepack enable' Dockerfile packages/llmwiki-kg/Dockerfile
Dockerfile:58:RUN corepack enable
Dockerfile:119:RUN corepack enable
packages/llmwiki-kg/Dockerfile:41:RUN corepack enable
packages/llmwiki-kg/Dockerfile:88:RUN corepack enable
exit=0
```

**The gap is the drift channel, not a present break.** Two independently maintained sequences
of the same four steps are a place where one file's fix does not reach the other, and this
repository has already been bitten by that class once: the `pnpm prune --prod` deadlock was
carried identically in both files (`packages/llmwiki-kg/Dockerfile:22` records that it was
"measured on the root image, which carried the identical step") and had to be repaired twice,
with the second repair's reasoning re-written from scratch. An order-sensitive fix — the exact
shape gap 7 describes — would have to be applied to both files by hand, and nothing in the tree
would notice if it reached only one.

**Unifying the stages, parameterising one image, or introducing a shared base is explicitly
OUT of scope.** This section records the two-file shape and the duplicated rationale; it does
not propose a merge, an `ARG`-parameterised single file, or a `docker/` fragment. Which of those
to do — if any — is a separate decision, and it is not taken here.

## Named gap 7: the KG image copies two of the four workspace manifests, and its header claims otherwise

**This is a gap, not a footnote, and the honest verdict is that the tree does not decide it.**
The workspace has four members, declared in one place:

```
$ sed -n '4,9p' pnpm-workspace.yaml
packages:
  - packages/api
  - packages/foundation
  - packages/llmwiki-kg/ts
  - packages/wiki
```

Root `Dockerfile` copies **all four** member manifests in both install stages: the `build` stage
spans `:65-83` (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` at `:65`, then
`packages/llmwiki-kg/ts/package.json` at `:72`, `packages/foundation/package.json` at `:76`,
`packages/wiki/package.json` at `:79`, `packages/api/package.json` at `:83`), and the
`prod-deps` stage repeats the same four at `:121-125`.

`packages/llmwiki-kg/Dockerfile` copies **two**: the `build` stage spans `:49-53`
(`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` at `:49`, then
`packages/llmwiki-kg/ts/package.json` at `:50`, `packages/foundation/package.json` at `:53`),
and the `prod-deps` stage repeats those two at `:90-92`.

| member (`pnpm-workspace.yaml:5-9`) | root image | KG image |
| --- | --- | --- |
| `packages/api` | copied (`:83`, `:125`) | **ABSENT** |
| `packages/foundation` | copied (`:76`, `:123`) | copied (`:53`, `:92`) |
| `packages/llmwiki-kg/ts` | copied (`:72`, `:122`) | copied (`:50`, `:91`) |
| `packages/wiki` | copied (`:79`, `:124`) | **ABSENT** |

**The KG file's own header asserts the opposite of what its COPY set does.** Lines `:43-48` read:

> Manifests first, so the dependency layer caches independently of source changes.
> Every remaining workspace member declares its manifest where its `workspaces`
> entry names it, because pnpm validates the whole workspace against the one
> lockfile. `packages/llmwiki-core` was the fifth member until it was collapsed into
> `packages/wiki`; its manifest COPY is gone because the path is, and a COPY of a
> missing path fails the build (which is how the collapse announced itself here).

The claim — "Every remaining workspace member declares its manifest where its `workspaces`
entry names it" — is true of the two members actually copied and false of the two that are not.
`packages/wiki/package.json` and `packages/api/package.json` are named in
`pnpm-workspace.yaml:5-9` and are absent from the KG image's COPY set.

**Verdict: `unverified — not met, not unmet`.** Whether this is a working configuration or a
broken one is settled by something the tree cannot show: what `pnpm install --frozen-lockfile`
does when two lockfile importers have no manifest on disk. Either pnpm tolerates the absent
importers (the frozen check passes over declared-but-not-present members) and the KG image is
correct with a misleading header comment, or it fails or warns, and the image cannot be built
as written. **Nothing here was built to find out** — no `docker build` ran for this slice, and
no image was run — so neither side is asserted. Naming it `unverified` rather than picking the
plausible side is the point: the deciding observation is available and has not been taken.

The observation that would decide it is one command, and its verdict is visible in stdout:

```
$ docker build -f packages/llmwiki-kg/Dockerfile .
```

It ends either by completing the `pnpm install --frozen-lockfile` layer at
`packages/llmwiki-kg/Dockerfile:54` with the two absent importers silently skipped, or by failing
on them by name. That belongs to the separate image-CI decision noted in gap 9, not to this
documentation slice.

**The shape is the same one already recorded one member over.** The root `Dockerfile`'s own
comment at `:69-71` records the collapse of `packages/llmwiki-core`: the fifth member stopped
existing, the build stage died on a manifest COPY of a path that was gone, and that is how the
collapse announced itself. This is the same shape with a different sign — a member that exists
and is *not* copied — and the root file's `:66-68` states the invariant that the two-file split
lets the KG file violate: "a COPY of a path that does not exist fails the whole build", which
guarded the *removed-path* direction while nothing guards the *not-added* direction.

## Named gap 8: the root runtime image ships six KG SQL files and cannot say which of them is a runner's business

**This is a gap, not a footnote, and the measured shape is narrower than the one reported — the
prior framing is withdrawn, not repaired.** The claim under test was that the root image ships
two KG migrations "that no schema runner applies" and that this is "a suggestion of migration
coverage that does not exist". The first half is literally true of `scripts/apply-schemas.sh`
and **only** of it; the second half is false, and the file that refutes it is a test. The
measured truth is set out in full because the corrected version is a smaller, real gap and the
withdrawn version is a bigger one that a reader would go looking for and not find.

The root runtime stage copies the whole KG database tree into the image at `Dockerfile:188`:

```
COPY --from=build /app/packages/llmwiki-kg/db ./packages/llmwiki-kg/db
```

The directory holds six `.sql` files, and the runner names four of them.

```
$ ls packages/llmwiki-kg/db/
migration_drop_ingest_outbox.sql
migration_open_kg_classification.sql
migration_rls_tenancy.sql
migration_stack_ontology.sql
migration_synthesize_descriptions.sql
schema.sql

exit=0
```

`scripts/apply-schemas.sh:61-93` is the single authoritative list — `readonly SCHEMA_FILES=(…)`
— and it names `schema.sql` (`:62`), `migration_stack_ontology.sql` (`:63`),
`migration_synthesize_descriptions.sql` (`:64`) and `migration_rls_tenancy.sql` (`:75`) from
that directory, plus twelve files from the wiki dimension's tree. The other two names appear in
that file **zero** times:

```
$ for f in migration_open_kg_classification.sql migration_drop_ingest_outbox.sql; do echo -n "$f: "; grep -c "$f" scripts/apply-schemas.sh; done
migration_open_kg_classification.sql: 0
migration_drop_ingest_outbox.sql: 0
```

**Both outcomes are recorded in the tree: the open-classification migration is applied by the KG
suite itself, and the drop migration is applied by nothing, by design.** Which path treats each
file as its business:

| file in `packages/llmwiki-kg/db/` | applied by `scripts/apply-schemas.sh` | applied by anything else |
| --- | --- | --- |
| `schema.sql` | yes (`:62`) | — |
| `migration_stack_ontology.sql` | yes (`:63`) | — |
| `migration_synthesize_descriptions.sql` | yes (`:64`) | — |
| `migration_rls_tenancy.sql` | yes (`:75`) | — |
| `migration_open_kg_classification.sql` | **no** (0 matches) | **yes, by the KG test suite**: `packages/llmwiki-kg/ts/src/schema-open-classification-harness.ts:63-66` reads it as `MIGRATION_SQL` from the path an operator would run, `:261`/`:263` apply a pre-migration `LEGACY_SCHEMA_SQL` and then that file, and `schema-open-classification.test.ts:140-143` ("agrees with a database built from schema.sql") compares the migrated result against a fresh install built from `SCHEMA_FILES`. Its content is also MIRRORED into `db/schema.sql:349`, which is what makes a clean install carry its effect. |
| `migration_drop_ingest_outbox.sql` | **no** (0 matches) | **nothing, by documented design**: `db/schema.sql:342-345` records that there is "deliberately no `ingest_outbox` table", that the drop migration "is destructive and is applied by an operator, never by this file". Apart from this document and the ODD record cited below, that comment is the name's **only** occurrence in the repository — no script and no test mentions it. |

So the open-classification migration is not dead weight with no coverage: it has an executing
test, and its file-versus-mirror equivalence is asserted by comparing two databases — the same
convention the wiki dimension uses for `migration_wiki_db_parity.sql` in
`test/dimensions/db-parity-migration.test.ts:1-40`, where "[t]wo copies drift" is named as the
failure class and "the two copies are compared by a database, not by a reviewer". And the
`ingest_outbox` drop is operator-only **on purpose**, which is a decision already taken, not an
omission.

**The gap that survives is provenance and blast radius, not missing application.** The runtime
image copies all six files flat into `packages/llmwiki-kg/db` (`Dockerfile:188`), and nothing in
the image — no README, no manifest, no filename convention — distinguishes the four files a
schema runner applies from the one an operator must run by hand after a live upgrade from the
one that is **destructive**. Within the container those six files are peers. An operator who
lists that directory has no way to learn which is which except by reading `db/schema.sql`'s
comments and the test suite, neither of which is in the runtime image: the runtime stage copies
`scripts` (`:186`), `packages/wiki/src/dimensions` (`:187`) and `packages/llmwiki-kg/db`
(`:188`) — not the tests. The copy set is corroborated by a container measurement already on
record: `odd/tasks/published-entry-composition.md:99` asserts **6** KG `.sql` files present
inside a built runtime image, naming all six above. The sharper measured fact is that **the
destructive, operator-only migration ships inside the default runtime image**, so the file that
undoes a table is present in every container the published tag produces.

```
$ grep -rn 'migration_drop_ingest_outbox' --exclude-dir={node_modules,.git,target,dist,docs,odd} .
./packages/llmwiki-kg/db/schema.sql:343:-- drop is converted by `migration_drop_ingest_outbox.sql`, which is destructive and
exit=0
```

**Not deleted in this slice, deliberately, and for a reason that is now explicit.** Removing the
`COPY` at `Dockerfile:188` — or trimming it to the four runner-applied files — would decide two
schema questions nobody has asked in this slice: whether an operator is expected to run the
destructive migration from *inside* the shipped container (which the copy makes possible and
the `schema.sql` comment implies is a supported path), and whether the clean-install
`schema.sql` should keep carrying a mirror of a migration that already has a test proving the
two agree. Deleting the lines on the way past would answer both in the negative, silently, and
destroy the evidence that they are open. The inventory and its provenance table are recorded
here; the files stay; whether the runtime image should carry a destructive operator migration
is a schema decision, not a documentation one.

## Named gap 9: neither image is built or run by any root workflow

**This is a gap, not a footnote, and it corrects a narrower belief held until now.** The claim
on record was that the **KG image** had zero CI enforcement while the root image was somehow
covered. That is wrong in the direction that matters: it is not that one image lacks CI, it is
that **neither** image is built or run by any workflow in this repository.

```
$ grep -rn "docker" .github/workflows/
exit=1
```

No match, case-sensitively, across all three workflow files (`ci.yml`, `publish.yml`,
`typecheck-tests.yml` — the only files under `.github/workflows/`). Read case-insensitively
there is no hit either (`grep -rin "docker" .github/workflows/`, exit 1): the one former
mention was a comment describing the `Dockerfile:65` image build the artefact step replaced, and
the corrected comment above that step no longer names it — prose about a `Dockerfile` was never
an invocation of one. No job executes
`docker build`, `docker run`, `docker compose` or a buildx action anywhere in root CI.

The job inventories confirm it from the other side:

| workflow | job ids (measured) | image job |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `build-and-test` (`:24`), `codebase-health` (`:132`) | none |
| `.github/workflows/publish.yml` | `resolve` (`:84`), `preflight` (`:155`), `publish` (`:283`), `verify` (`:337`) | none |
| `.github/workflows/typecheck-tests.yml` | `test-typecheck` (`:12`) | none |

**The one workflow that ever attempted a KG image gate never ran, and gap 5 records why.**
`packages/llmwiki-kg/.github/workflows/ci.yml` sat at a non-root path, so GitHub never
registered it; its content is preserved by blob SHA
`8f6e9e9a6a86280a625bede87d90d6e8928a991c` and the file is deleted in this slice (Named gap 5).
Note what that file did **not** contain either: no `docker build`, no image job — its single
job id was `test` (`:10`) named "Typecheck, build and test" (`:11`), running typecheck, build
and test in `ts/`. So even the file that looked like KG image CI was KG *package* CI in the
wrong directory, and the KG image has never had a builder in CI at any path.

**What the artefact step from gap 3 covers, and what it does not.** The step
`Build the @repo/kg artefact the image ships` (`.github/workflows/ci.yml:91-92`, running
`pnpm --filter @repo/kg run build`) makes explicit what was previously only incidental: no CI
step compiled `packages/llmwiki-kg/ts/dist` as delivery work of its own. That directory is **one
input to one image** — copied into the
tracked file at `packages/llmwiki-kg/Dockerfile:113` and executed by `:123` — and the step
therefore proves that input compiles. It does not build `packages/llmwiki-kg/Dockerfile`, it
does not build the root `Dockerfile`, it does not build either of their `prod-deps` trees, and
it does not exercise `pnpm install --frozen-lockfile` in the image's own context, which is
exactly the check gap 7 needs. Compiling one input is not building an image.

**The real question, stated plainly:** this repository ships two container images that **no
workflow proves exist**. No CI step would fail if either `Dockerfile` stopped parsing, if a
stage stopped resolving, or if a manifest COPY set drifted (gap 7) — the first feedback would
come from whoever next runs `docker build` by hand. That is the finding, and it is recorded as a
measurement rather than a defect with a scheduled fix.

**Building the images in CI is a separate decision, being taken with the user, and it is NOT
part of this slice.** This section establishes the measured absence; it does not propose a
workflow, a job name, a buildx cache strategy, or a registry target, and none was added. The
asymmetry that makes the choice non-trivial is already recorded in Named gap 3: a new job name
arrives with no branch-protection entry, so an image job whose red result could be merged past
would be ceremony rather than a gate.

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
  runs locally; the graph and every root script are unchanged, and exactly one step was
  added to the `build-and-test` job (Named gap 3) — no job was renamed, added or removed.
- **Per-package `lint` is a view, not a replacement.** `scripts/lint-ratchet.ts` is
  a whole-repo gate on a frozen baseline and accepts no scope argument; the package
  task reuses its measurement and narrows it. A scope narrower than the tree it
  audits is a different measurement, so `pnpm run lint` remains the gate.

## Worked example

Run the wiki package's tests:

```bash
turbo run test --filter=@repo/wiki
```

Because `test` declares `dependsOn: []`, this runs **exactly one task**,
`@repo/wiki#test`, over the 565-file wiki selection: no `@repo/foundation#test`,
nothing else. Tasks run one at a time because of the root
`"concurrency": "1"`, so the run still cannot collide with a second suite over the
shared pgvector database — that protection is unchanged, it just no longer costs a
dependency's 405 files. `--only` is no longer needed for "just the filtered
package", because that is now what every filtered run means.

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
task you meant, and that nothing was cached into a green that did not execute — and
that a `--filter` of one package resolves to one task.
