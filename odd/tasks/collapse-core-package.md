# Collapse `@atomicstrata/llmwiki-core` into `packages/wiki`

Make `@atomicstrata/llmwiki-core` stop being a package: the engine lives in `packages/wiki`, the root tarball becomes self-sufficient, and the two-artefact split disappears. Five authorised slices, one work-unit commit each, reported at every boundary.

Status: authorised, sliced. Files: ~51 net (6 deletions + ~45 edits) across five slices, each ≤18 files. Risk: item 3 (published surface and subpaths) and item 5 (packaging and delivery).

## Specs

**S1 — the goal, in the human's words.** "a real monorepo where everything wiki-related lives in the wiki package — and `@atomicstrata/llmwiki-core` should stop being a package and live in the wiki repo." The code lives in `packages/wiki` and the split disappears.

**S2 — the root tarball is self-sufficient.** "**The root tarball is self-sufficient**: pack it **alone**, install it in a clean project, and show `import { createWiki }` resolving to a **function** and an ingest working. No second tarball." The gate is a clean-project install of the packed tarball with no sibling tarball and no hoisted rescue. Build success is not evidence for this and must not be reported as such; neither is a green `docker build` nor a green `pnpm test`, because `nodeLinker: hoisted` makes `@hono/node-server`, `ajv` and `express` reachable flat in `node_modules` transitively and both can pass over a broken published tarball.

**S3 — `dist/index.js` carries the engine.** "show it is no longer a facade — `resolveDimensions` and the engine chunk are inside it, with sizes before and after." Before-size is measured at base before any source edit.

**S4 — `withQuiet` still quiet, proven by execution.** "prove quiet output survives the collapse. This is the specific thing the split existed to protect, and the warning about a second `AsyncLocalStorage` instance is the risk — a bundled duplicate would silently stop suppressing output. Test it, do not reason about it." If it is not quiet, that is a blocked item reported and stopped on, never shipped as a packaging win.

**S5 — `test/artifact/facade-surface.test.ts` moves or dies.** "it will move or die. Report which, and whether the package-selection union guard's single named hole shrinks or disappears." Decision: it DIES, because its subject is the two-artefact surface — `dist/compiler-sdk.js` exporting exactly two values, and both `exports` subpaths resolving under the *core's* `dist/`. Its valuable assertions (no wildcard re-exports; the root's required value exports) move into a rewritten artifact test that asserts the post-collapse surface. The union guard's named hole DISAPPEARS rather than shrinks: the exemption in `scripts/package-selection.ts` exists only because a test reached a non-surface `dist/`, and there is no longer one to exempt.

**S6 — the container still works.** "`docker build` green and both modes executed inside the image (`/health` 200, `/` 200 with the container's own `Host`, `/` 403 with a wrong one, `serve` stdio `initialize` exit 0), plus the runtime asset assertions." Both containers are in scope: the root `Dockerfile` and `packages/llmwiki-kg/Dockerfile`.

**S7 — this is the recorded direction arriving, and the prior decision's premise evaporates.** `scripts/package-selection.ts:34-35` already records: "`@atomicstrata/llmwiki-core` IS DELIBERATELY NOT A SURFACE. It is transitional — it will become a thin alias of `@repo/wiki` or disappear." `docs/turborepo.md:137-143` heads a section "`@atomicstrata/llmwiki-core` is transitional". The prior decision in `odd/tasks/core-facade-and-packaging.md` (`L5`, corrected by its `L20`) held that the root tarball cannot be made self-sufficient: "Bundling the engine into the root package would give the process a second AsyncLocalStorage/lock/error-class instance, and `withQuiet` would silently stop applying across that boundary", citing the warning in `packages/wiki/src/sdk/compiler-composition.ts` — "Quiet output must use core's AsyncLocalStorage instance, not a bundled copy" — and the core `tsup.config.ts` header, "shared authority, locks, error classes and the module-instance token resolve to one set of chunks in an installation". **This change does not reverse that decision; it removes one of its two sides.** The duplicate instance can only arise when root bundles the engine while a second artefact is also installed — which is exactly why root `tsup.config.ts:17` externalizes the core today. One artefact means one module instance by construction, so the trade-off disappears. A reader holding both documents must be able to see that the earlier decision was right and became inapplicable.

**S8 — the published name's retirement is documented, and the registry is untouched.** Nothing in this work is pushed or published. The published `@atomicstrata/llmwiki-core@1.4.0-dev.20260919` artefact stays installable on the registry. The in-repo deprecation note records the name's retirement so it is documented rather than silent. Any `npm deprecate` pointing at `llm-wiki-compiler` is the user's own later decision and out of this session's scope.

**S9 — no slice leaves the tree with a red gate it did not arrive with.** Each boundary report carries the gate exits. A slice that must land with something known-red names it explicitly and names the slice that closes it.

## Tasks

| ID | Specs | Task | Route | Commit |
|---|---|---|---|---|
| T1 | S2, S3, S4 | RED first, observed at base: `PACK_DISTRIBUTION` → `["."]`; single-tarball clean-project install asserting `createWiki` is a function and an ingest runs; `withQuiet` silence; engine present in `dist/index.js` | gentle-ai-worker | pending |
| T2 | S1, S2, S3, S7 | The collapse: 6 deletions under `packages/llmwiki-core/`; root manifest absorbs 3 missing deps and adopts `@modelcontextprotocol/sdk ^1.32.1`; externals merge into root's library entry; `scripts/tsup-command.ts` prerequisite build removed; workspace member, aliases, `tsconfig` include, wiki's self-referential imports, KG config, lockfile | gentle-ai-worker | pending |
| T3 | S5, S2 | Remaining test surface GREEN: packaging tests, rewritten artifact test asserting the post-collapse surface, union guard named hole removed, package-selection and dependency-wiring guards | gentle-ai-worker | pending |
| T4 | S6, S9 | Gates and delivery: `eslint.config.mjs`, `.fallowrc.json`, `contract-cordination.json`, `turbo.json`, `scripts/build-stamp.ts`, `scripts/package-selection.ts`, `publish.yml`, both Dockerfiles | gentle-ai-worker | pending |
| T5 | S8, S1 | Docs and the deprecation record: `ARCHITECTURE.md`, `README.md`, `CHANGELOG.md`, `docs/guides/sdk.mdx`, `docs/guides/sdk-packages.mdx`, `docs/turborepo.md`, `docs/guides/clp/build-your-first-profile.mdx`, `docs/troubleshooting/stale-pages.mdx` | gentle-ai-worker | pending |

## Log

**L1 — the assignment, verbatim.** "Collapse `@atomicstrata/llmwiki-core` into `packages/wiki`. The human's goal, in their words: *'a real monorepo where everything wiki-related lives in the wiki package — and `@atomicstrata/llmwiki-core` should stop being a package and live in the wiki repo.'*" Measured consequences stated at assignment: root `dist/index.js` was a ~108 KB facade whose `resolveDimensions`, `LLMWIKI_DIMENSIONS` and `sdk/core.ts` counts are zero, with the engine in an ~849 KB chunk of the other package; the root tarball is not installable alone (`npm i <root.tgz>` fails `ETARGET` on the pinned core), so publishing requires two tarballs; `compiler-composition.ts` warns that quiet output must use core's `AsyncLocalStorage` instance, "and **that warning exists because the split exists**". Two acceptable shapes were named: delete the package if nothing consumes it, else make it a thin alias. Scope and stop: "If the real set exceeds ~30 files, stop and report." Do not expand into the monorepo layout, the `import type` orphans (Named gap 2), or the turbo `pnpm` PATH gap (Named gap 1).

**L2 — correction, from measurement: the assignment's package description was stale.** It said the package "has no `src/` of its own" and that its `tsup.config.ts:8-12` compiles `../../packages/wiki/src/core-index.ts`. Measured: `git ls-files packages/llmwiki-core` returns `LICENSE`, `README.md`, `package.json`, `src/compiler-sdk.ts`, `src/index.ts`, `tsup.config.ts` — no `tsconfig.json`. The package owns its entries, added by `6425c815 feat(core): own the facade's published surface`, which is in base history. Those two sources are thin RE-EXPORT facades over `../../wiki/src/core-index.js` and `../../wiki/src/sdk/compiler-composition.js`. The substance held: no engine lives in the package, root `tsup.config.ts:17` still externalizes it, `PACK_DISTRIBUTION = ["packages/llmwiki-core", "."]` is verbatim at `test/sdk/pack-distribution.ts:32`.

**L3 — correction: `publish.yml:71` is `PACKAGE_DIRS: "packages/llmwiki-core ."`** — both directories, not a core-only form. This is the line the whole publication story turns on.

**L4 — consumer measurement: verdict (B), published with zero documented consumers.** Published by OIDC trusted publishing as the first of two artefacts; `publishConfig.access: public`; version `1.4.0-dev.20260919`, a prerelease line. No document anywhere instructs an embedder to install it; the opposite — `packages/llmwiki-core/README.md:9-12` and `docs/guides/sdk-packages.mdx:20-28` divert to `llm-wiki-compiler` and call the scoped package "not separately supported consumer API". In-repo consumers are only: pinned dependency in root `package.json:76` and `packages/wiki/package.json:42`, type-only imports in `packages/wiki/src/sdk/types.ts`, dev aliases in `tsconfig.json:19` and `vitest.config.ts:35`, and tests.

**L5 — prior-decision reframing, from the Manager.** The prior slice in `odd/tasks/core-facade-and-packaging.md` decided at `L5` and corrected itself at `L20` that the root tarball cannot be made self-sufficient because bundling would create a second `AsyncLocalStorage`/lock/error-class instance and `withQuiet` would silently stop applying. Recorded in Specs as S7 in these terms: **the premise no longer holds because this change removes one of its two sides** — not "we reverse L5". The Manager's instruction: "if it is not quiet, that is the blocked item you predicted — report it and stop, do not ship a silent-output regression as a packaging win."

**L6 — shape decision: DELETE the package, not a thin alias.** Reason: the human's words are "should stop being a package", which is deletion; the repository's own recorded intent is "alias or disappear"; and deletion is reversible at the level that matters because nothing here is pushed or published — the registry artefact stays installable and `npm deprecate` remains the user's own decision (S8). The assignment's fallback ("if genuinely unknown, keep the name as a thin alias") does not apply: the repository cannot see the npm registry, but that is not the same as the consumer question being unknown, and every in-repo pointer says this name is not a consumer API and is intended to disappear.

**L7 — the measured file set, and the stop rule firing.** `grep -rIl 'llmwiki-core'` returns 73 files. Excluded: 24 under `odd/tasks/**` (append-only history — three of them describe a package that will no longer exist, and that is the point; a collapse that rewrites its own history is the defect) and `pnpm-lock.yaml` (regenerated, never hand-edited). That leaves 48 candidates: 6 deletions and 42 edits, of which 40 are engineering (code, build, tests, delivery). The assignment estimated ~12; it missed a 16-file test surface and a second container. The stop rule fired at >30, the Manager raised it to ~51 and authorised five slices, each its own work-unit commit, reported at every boundary. A prior reconnaissance proposed "scrubbing" core references from three `odd/tasks/**` files; rejected as a rule violation.

**L8 — machine-verified dependency and externals facts (crux of S2).** `node -e` over both manifests: the core declares 19 runtime dependencies, root already declares 16 of them. Missing from root, exactly three: `@hono/node-server ^1.19.14`, `ajv ^8.20.0`, `express ^5.1.0`. Range conflict: `@modelcontextprotocol/sdk` is `^1.32.1` in the core and `^1.29.0` in root. Externals must MERGE, not merely drop: the core's library build externalizes `express`, `@modelcontextprotocol/sdk`, `@modelcontextprotocol/sdk/*`, `@hono/node-server`, `mammoth`, each with a recorded reason — bundling them into ESM output produces `Dynamic require of "ajv"/"tty"/"url" is not supported` at import time. Root's `api` entry survives that with a `createRequire` banner, but its library entry carries no banner and no shebang, so it must externalize that list verbatim. `nodeLinker: hoisted` means the three missing packages are reachable flat in `node_modules` transitively, so a green `docker build` and a green `pnpm test` can both pass over a broken published tarball; only a clean-project install of the packed tarball sees it.

**L9 — T1's gate, from the Manager.** RED-first at base and the RED must be OBSERVED: `PACK_DISTRIBUTION` still `["packages/llmwiki-core", "."]`, the single-tarball install failing, `dist/index.js` still a facade. "A test written after the collapse that passes proves nothing about the collapse." And S9: no slice may leave the tree with a red gate it did not arrive with.

**L10 — T1: RED observed at base, and the S3 "before" measured before a single test existed.** Test-only slice; NO production code changed. Files: `test/sdk/pack-distribution.ts` (`PACK_DISTRIBUTION` → `["."]`), `test/sdk/packaging.test.ts` (single-tarball install, engine-dependency resolution, a REAL ingest through the installed package), new `test/artifact/bundle-engine.test.ts` (engine in `dist/index.js`, the quiet scope's owner). Covers **S2** (packed alone, installed alone, ingest executed), **S3** (engine defines its symbols inside `dist/index.js`) and **S4's structural half**; S4's behavioural half is the open decision recorded below.

*Base state, `corepack pnpm run build` green, measured BEFORE any test was written:*
- `wc -c dist/index.js dist/api.js` → `108001 dist/index.js` / `2477179 dist/api.js`. `ls -l dist/` → `api.js 2477179`, `api.js.map 6546133`, `index.d.ts 6956`, `index.js 108001`, `index.js.map 1174398`, `viewer/`.
- `grep -c 'resolveDimensions' dist/index.js` → `0`. `grep -c 'new AsyncLocalStorage' dist/index.js` → `2`. `grep -c 'async_hooks' dist/index.js` → `1`.
- `wc -c packages/llmwiki-core/dist/*.js` → `chunk-EJL753SJ.js 426390`, `chunk-MFKTX3BK.js 830536`, `compiler-sdk.js 193`, `index.js 53981`, `project-config-seam-HMPK6GRG.js 1935` (total `1313035`). `grep -c 'resolveDimensions' packages/llmwiki-core/dist/*.js` → `chunk-MFKTX3BK.js:3`, every other file `0`.
- Occurrence counts (`grep -o … | wc -l`), because line counts hide a duplicated module: `dist/index.js` → `resolveDimensions 0`, `LLMWIKI_DIMENSIONS 0`, `createDimensionsDatabase 0`, `new AsyncLocalStorage 2`, `@atomicstrata/llmwiki-core 1`, `var quietScope 1`. `dist/api.js` → `resolveDimensions 4`, `new AsyncLocalStorage 6`, `@atomicstrata/llmwiki-core 0`, `var quietScope 1`. `packages/llmwiki-core/dist/chunk-MFKTX3BK.js` → `resolveDimensions 3`, `new AsyncLocalStorage 6`, `var quietScope 1`.
- The root facade's entire engine surface is one statement: `dist/index.js:2608` → `import { withQuiet, createWikiCoreAtRoot } from "@atomicstrata/llmwiki-core/compiler-sdk";`. `dist/api.js` already bundles the engine and imports nothing from the core.
- Root `exports` names only `.` and `./package.json`; `withQuiet` and `createWikiCoreAtRoot` are published ONLY on the core's `./compiler-sdk` subpath.
- Registry check (read-only): `npm view @atomicstrata/llmwiki-core@1.4.0-dev.20260919 version` → **404**; the published line is `1.4.1`, `1.4.2`, `1.5.0-rc.1`, `1.5.0`. The exact prerelease the root manifest demands does not exist, which is precisely the `ETARGET` below.

*RED, literal (each command run in the foreground at base):*
1. `PATH=… corepack pnpm run test:pack` → `EXIT=1`, `[ELIFECYCLE] Command failed with exit code 1.`
```
 ❯ test/sdk/packaging.test.ts (1 test | 1 failed) 18578ms
   × packaging (slow; run via `npm run test:pack`) > the root tarball installs alone, imports, and ingests 18577ms
     → the root tarball must install alone; npm said:
npm error code ETARGET
npm error notarget No matching version found for @atomicstrata/llmwiki-core@1.4.0-dev.20260919.
npm error notarget In most cases you or one of your dependencies are requesting a package version that doesn't exist.
npm error A complete log of this run can be found in: /home/urgosxd/.npm/_logs/2026-11-11T09_00_05_428Z-debug-0.log
: expected 1 to be +0 // Object.is equality

 Test Files  1 failed (1)
      Tests  1 failed (1)
```
2. `PATH=… corepack pnpm exec vitest run test/artifact/bundle-engine.test.ts` → `EXIT=1`, `Tests 3 failed | 1 passed (4)`
```
 → dist/index.js must DEFINE resolveDimensions, not import it from another package: expected false to be true // Object.is equality
 → dist/index.js must not import a package that no longer exists: expected 'var __defProp = Object.defineProperty…' not to contain '@atomicstrata/llmwiki-core'
 → quiet output is suppressed through one AsyncLocalStorage instance; a second package's bundle constructs its own, so `withQuiet` entered through one silently stops applying in the other: expected [ Array(2) ] to deeply equal [ 'dist' ]
     + "packages/llmwiki-core/dist",
```
The one case that PASSES at base is the per-bundle guard (`var quietScope` at most once inside each shipped bundle), on purpose: it is the preserve half, and it must survive the collapse unchanged.
3. `PATH=… corepack pnpm exec vitest run test/sdk/pack-distribution.test.ts` → `EXIT=1`, `Tests 1 failed | 1 passed (2)`
```
 × pack distribution list > names exactly the publishable workspaces and the root facade
   → expected [ Array(1) ] to deeply equal []
- []
+ [
+   "publishable but missing from the list: packages/llmwiki-core",
+ ]
```
The second pin case (`publish.yml PACKAGE_DIRS`) still passes at base because the package still exists; it turns red the moment T2 deletes it, and stays red until `publish.yml` moves.

*T1 corrections, from measurement, and one open decision:*
- **"`dist/**` contains exactly one `new AsyncLocalStorage` construction, not two" is false at base, and was not used.** `dist/index.js` already constructs TWO in ONE module: `var quietScope = new AsyncLocalStorage(); var verboseScope = new AsyncLocalStorage();` from `packages/wiki/src/utils/output.ts:71,130`. Totals also differ per bundle (`2` in `dist/index.js`, `6` in `dist/api.js`). The invariant that actually catches a bundled duplicate is the quiet scope's OWNER, so the assertion is `var quietScope` at most once per bundle, and exactly one package's built bundles defining it across the checkout — `["dist"]` after the collapse, `["dist", "packages/llmwiki-core/dist"]` today.
- **`readPublishPackageDirs` refused a one-package distribution.** It threw `expected at least two directories`, a shape the collapse cannot satisfy. Lowered to at least one; an empty or unmatched value still throws, so the anti-blindness property it was written for is intact.
- **`withQuiet` is NOT reachable from the installed root entry** (root `exports` = `.` and `./package.json` only), so S4's behavioural half cannot be written against the packed root tarball at this boundary. It needs a decision this Log does not take: keep a `./compiler-sdk`-shaped subpath on `llm-wiki-compiler` in T2/T3, or accept S4 as structural. The structural half is in place; the behavioural half stays OPEN and is named in the T1 report.
- **The ingest needs a Stack, and no port avoids it.** `writeToDimensions` calls `resolveStackForCommand` BEFORE the port is consulted (`packages/wiki/src/services/ingest/service.ts`), so a `dimensionsPort` returning `[]` still reaches Postgres. The ingest case therefore uses `test/fixtures/probe-stack-suite.ts` and its loud no-database rule, imported LAZILY so the install case stays database-free. Consequence to review: `test:pack` now needs a reachable database for its ingest case. Measured environment: `postgresql://aks:aks@localhost:5434/aks` reachable.

*Expected to remain RED at this boundary, and who closes each:* `test:pack` + `bundle-engine.test.ts` + both `pack-distribution.test.ts` cases and `verifyInstalledTypes`'s `@atomicstrata/llmwiki-core` type imports → **T2** (collapse, manifest merge with the three missing deps and `@modelcontextprotocol/sdk ^1.32.1`, externals merge, `publish.yml`) and **T3** (remaining test surface green). No slice arrives with a red gate it created: T1 created these on purpose and S9 is why they are listed here.

*Scope amendment (T1's, not the Manager's):* `publish.yml`'s `PACKAGE_DIRS` moves from **T4** into **T2**, because `test/sdk/pack-distribution.test.ts` pins `PACK_DISTRIBUTION` against that value and T1 would otherwise leave that pin red across two boundaries.

*Checks run on T1's own diff:* `corepack pnpm exec eslint <the three files>` → exit 0. `corepack pnpm exec tsc --noEmit` → exit 0. `corepack pnpm run typecheck:tests` → `1587 files checked; 238 baseline diagnostics in 86 files; no regression.` `git status --short` → only the three test paths and this document; no scratch directory left in the worktree.

**L11 — T1 continuation: the `./compiler-sdk` decision encoded, the quiet invariant corrected, the database answer.** Still test-only; no production code, no commit. Files: `test/sdk/packaging.test.ts` (behavioural quiet probe on the installed tarball) and `test/artifact/bundle-engine.test.ts` (the `dist/compiler-sdk.js` surface). Covers **S4** — behavioural half now encoded, instance-identity half asserted structurally — and keeps **S2**, **S3**.

*The decision (Manager's, encoded verbatim in intent):* **the root package gains a `./compiler-sdk` subpath in T2**, built from `packages/wiki/src/sdk/compiler-composition.ts`, exporting `withQuiet`, `createWikiCoreAtRoot` and their types. Rationale: S4 requires a behavioural quiet proof, `withQuiet`'s only public reach today is the core's `./compiler-sdk` which T2 deletes, and removing an embedder's only door while asserting quiet structurally is the reasoning S4 forbids. It is a replacement, not new surface.

*The quiet-scope invariant, corrected again by measurement.* T1's first pass already rejected "exactly one `new AsyncLocalStorage`" (base `dist/index.js` constructs TWO in one module — `quietScope` and `verboseScope`, `packages/wiki/src/utils/output.ts:71,130`; `dist/api.js` constructs six). The refined statement, now asserted: **`var quietScope` at most once per bundle, constructed by exactly one package's bundles, and ZERO times in `dist/compiler-sdk.js`** — the last clause is the hazard the new subpath introduces. `dist/index.js` and `dist/compiler-sdk.js` are separate files built with `splitting: false` (root `tsup.config.ts`), so a subpath that re-exports `withQuiet` from `../utils/output.js` INLINES a second `AsyncLocalStorage`; quiet entered through the subpath would then be invisible to the engine in `dist/index.js`, silently. That is S4's failure mode moved inside one tarball, and it is asserted at `test/artifact/bundle-engine.test.ts`.

*A limit that must not be read as a proof (measured).* Every `WikiCore` method is wrapped in `runQuiet` (`packages/wiki/src/sdk/core.ts:59`, applied at `:96`, `:99`, `:113`, `:119`, `:131`, `:144`, `:147`, `:149`, `:159`, `:168`, `:182`, `:184`, `:190`, `:201`, `:205`, `:210`, `:212`), so no public SDK operation emits anything: `listPages`, `status`, `lint`, `exportOkf`, `importOkf`, `listSources` were each called on a fresh root against the built artefact and produced zero bytes on both streams. Consequence, stated plainly: **a duplicate `AsyncLocalStorage` would pass any public-method stream assertion.** The behavioural probe therefore guards stream cleanliness through the packaged subpath (a real ingest, both streams empty), and instance identity is proved structurally by the `ZERO`-construction assertion above, not by the stream. A true behavioural identity proof needs an emitter on the published surface or the launcher's MCP stdio path (S6).

*Behavioural RED, literal.* `PATH=… corepack pnpm run test:pack` exits 1 at the INSTALL (`npm error code ETARGET` / `No matching version found for @atomicstrata/llmwiki-core@1.4.0-dev.20260919.` — S2's RED from L10), so at base the quiet probe is UNREACHED inside that gate. The subpath's own RED was therefore observed directly, by packing the two base tarballs and installing them into a clean fixture (the shape that installs at base) and running the exact probe body:
```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './compiler-sdk' is not defined by "exports" in /tmp/…/node_modules/llm-wiki-compiler/package.json imported from /tmp/…/quiet.mjs
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
Node.js v24.21.0   (child exit 1)
```
And `PATH=… corepack pnpm exec vitest run test/artifact/bundle-engine.test.ts` → `EXIT=1`, `Tests 5 failed | 1 passed (6)`:
```
× the root bundle carries the engine > defines the dimensions symbols its engine source declares
  → dist/index.js must DEFINE resolveDimensions, not import it from another package
× the root bundle carries the engine > imports nothing from the package the collapse deletes
  → dist/index.js must not import a package that no longer exists
× the quiet scope has one owner > publishes exactly the compiler-sdk surface the collapse replaces
  → dist/compiler-sdk.js must exist and carry content; run `corepack pnpm run build`
× the quiet scope has one owner > constructs no quiet scope of its own: the engine's is the one it re-exports
  → dist/compiler-sdk.js must exist and carry content; run `corepack pnpm run build`
× the quiet scope has one owner > is defined by the root package's bundles and no other package's
  → expected [ Array(2) ] to deeply equal [ 'dist' ]
✓ the quiet scope has one owner > is constructed at most once inside each shipped bundle
```

*The database answer (S2's ingest): there is NO database-free ingest, and this is a gate-property change for `test:pack` locally.* Exact chain, `packages/wiki/src`:
- `sdk/core.ts:99` — `ingestText: (input) => runQuiet(() => ingestTextSource(root, input, env, options.dimensionsPort))`.
- `services/ingest/service.ts:310` `ingestTextSource` → `:332` `writeToDimensions(...)`.
- `services/ingest/service.ts:160` `writeToDimensions` → `:171` `createDimensionsDatabase(env)` opens a Postgres handle unconditionally → `:190` `const stackId = explicitStackId ?? await resolveStackForCommand(dimensionsDb.db, env)` — a database round trip, BEFORE anything else — → `:208` the `dimensionsPort` is consulted only to pick dimensions, never to skip the Stack.
- `services/stacks/resolve-stack.ts:62-69` `resolveStackForCommand`: `selectStack({env})`; an `explicit` selection (`AKS_STACK_ID`, which the SDK never sets) returns immediately, otherwise `ensureDefaultStack(db)` PROVISIONS the default Stack. The DB-free branch that exists for other callers — `resolveStackForDimensions` at `:93-99`, which returns `undefined` when the selection is default and no dimension is enabled — is **not** on the ingest path.
- Even with a Stack in hand, the write is row-backed: the wiki dimension writes pages as rows (`writeToDimensions` comment, `:167-170`, "Pages are rows in Postgres now"), and the ingest ceiling is `INGEST_DIMENSIONS = ["wiki", "kg"]` (`:78`). `LLMWIKI_DIMENSIONS` cannot empty that ceiling.

Cost to the gate, unsoftened: **`test:pack` is no longer database-free locally.** It now needs a reachable Postgres discovered by `test/fixtures/test-database.ts` (`LLMWIKI_TEST_DATABASE_URL`, else `postgresql://aks:aks@localhost:5434/aks`), and it fails LOUDLY without one (`test/fixtures/probe-stack-suite.ts` → `missingTestDatabase`), never skipping. In CI it costs nothing new: the job that runs `test:pack` already starts a `postgres` service and exports `LLMWIKI_TEST_DATABASE_URL`/`AKS_DATABASE_URL`/`DATABASE_URL` (`.github/workflows/ci.yml:37-61`) and applies schemas (`:95-98`) before `pnpm test` (`:104`) and `pnpm run test:pack` (`:107`); `publish.yml`'s preflight does the same before its own `test:pack` (`:268`). The install half of the fixture stays DB-free: the probe fixture is imported lazily.

*Still RED at this boundary, and who closes each:* `test:pack` (install ETARGET → manifest merge) and `bundle-engine.test.ts` (engine inline, core specifier, `dist/compiler-sdk.js` absent, second quiet-scope owner) → **T2**; `pack-distribution.test.ts` both cases → **T2**; `verifyInstalledTypes`'s `@atomicstrata/llmwiki-core` type imports → **T3** (they must move to `llm-wiki-compiler/compiler-sdk`, which is the same decision encoded here). Nothing arrives red that T1 did not create, and S9 is why each is named.

*Checks on this continuation:* `corepack pnpm exec eslint test/artifact/bundle-engine.test.ts test/sdk/packaging.test.ts` → exit 0. `corepack pnpm exec tsc --noEmit` → exit 0. `corepack pnpm run typecheck:tests` → `1587 files checked; 238 baseline diagnostics in 86 files; no regression.` Code lines (comments excluded): `packaging.test.ts` 219, `bundle-engine.test.ts` 120 — both inside the house rules.
