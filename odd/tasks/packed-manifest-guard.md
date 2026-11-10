# Packed manifest guard — what actually protects an embedder

Branch `fix/packed-manifest-guard`, base `2c81bfcfed05cb8b9d2fe183f1ce213df234f0ab`. Four bounded follow-ups from the integrated `feature/published-entry-composition` ([published-entry-composition.md](published-entry-composition.md)): `S1`–`S3` are a real defensive gap, `S4` keeps a real security behaviour asserted, `S5` closes a proof no tier reaches.

## Specs

Spec IDs are `S1`–`S5`; task IDs are `T1`–`T5`. Lines marked `Consequence:` are derived, not quoted.

S1. THE GUARD ASSERTS THE `dependencies` BLOCK, NOT THE WHOLE MANIFEST. Manager ruling, verbatim: "That criterion was **mine and it was wrong**: no package manager installs the `devDependencies` of a package you install" and "What actually protects embedders is **no `workspace:*` under `dependencies`**, and that block is clean (20 registry ranges, zero `workspace:`)." Measured at base `2c81bfcf`: root `package.json` `dependencies` holds **20** entries and **0** of them contain `workspace:`. The guard's subject is that block and nothing else.

Consequence: a guard whose subject is the whole manifest tests an invariant no consumer can observe, which is why it demanded something that is not a defect.

S2. THE FOUR `devDependencies` OCCURRENCES ARE COSMETIC AND MUST BE RECORDED AS SUCH. Measured: root `package.json:103-106` carries `"@repo/api": "workspace:*"`, `"@repo/foundation": "workspace:*"`, `"@repo/kg": "workspace:*"`, `"@repo/wiki": "workspace:*"` — all four inside `devDependencies`. They are harmless because no package manager installs the `devDependencies` of a package you install. The comment next to the guard must say exactly that, with that reason: a future reader who "fixes" them breaks the workspace build. That comment is the deliverable as much as the assertion.

Consequence: `test/affected-escalation-wiring.test.ts:171` **REQUIRES** `expect(root.devDependencies?.[KG_BARE_SPECIFIER], ...).toBe("workspace:*")` for `@repo/kg`, so a guard asserting the whole manifest is free of `workspace:*` would go RED on today's tree. That whole-manifest acceptance criterion was the previous slice's, and it is **retracted**.

S3. THE GUARD POSITIVELY ASSERTS THAT `dependencies` VALUES ARE REGISTRY-RANGED OR URL-SHAPED. A bare absence assertion passes for an empty or mangled block; the positive half is what states that every value a consumer's installer will read is installable.

Consequence: the placement decision is justified, not incidental. Measured at base: **no test in this repository reads a PACKED tarball's manifest.** `test/artifact/entries-load.test.ts` reads the checkout's `package.json` and `packages/llmwiki-core/package.json`; `test/artifact/container-entry.test.ts`, `test/sdk/pack-distribution.ts` and `test/declared-dependencies-wiring.test.ts` all read the checkout; `test/sdk/packaging.test.ts:115-116` reads only `repo/dist/index.js` and `repo/dist/index.d.ts` from the scratch fixture and never the installed manifest, even though it does `npm install` the tarballs at `:121`. So the packed manifest is currently unguarded by any tier, which is what `S1`–`S3` exist to correct.

S4. THE CONTAINER PROBE SENDS THE CONTAINER'S OWN `Host` HEADER, AND THE 403 STAYS ASSERTED. Measured at base: `/` returns **403** under a literal probe and **200** with `Host: <eth0>:4173`. That is the viewer's fail-closed origin gate; `docker/` and `packages/api/src/host/` are byte-identical to base, so the gate is untouched by this work. The probe carries the container's own `Host` and a comment states why, so the next reader does not read a 403 as a regression and "fix" an origin gate. The **403-on-wrong-`Host`** case stays an assertion: it is a real security behaviour, not a wart to smooth over.

Consequence: this nuance has surfaced twice in two slices, which is the whole argument for making it permanent rather than re-discovering it.

S5. THE ONE-OFF TARBALL+LIVE-DATABASE PROOF IS RECORDED, NEVER COMMITTED. "A real ingest through the **installed tarball** together with a **live database**" is run once by hand, with its commands and output recorded here. It is not a committed test: a DB-gated test that skips in CI buys the appearance of coverage at real spawn cost. If its result differs from the source-resolved artefact tier, that difference **is the finding** and the reason this item existed.

Consequence: `test:pack` proves published types DB-free; the artefact tier proves a real ingest with the engine resolved **from source**. Those are not one proof.

## Tasks

T1 · S1-S3 · route: gentle-ai-worker · the manifest guard + correction of the guard scope · commit: 96fdcbc6f65fd3df232a0a1e88d004d351205a81
T2 · S4 · route: gentle-ai-worker · the container probe carrying the container's own `Host` · commit: 1ed7e1469d569ad4d4d1e94113baf4b9e512644e
T3 · S5 · route: gentle-ai-verify · the one-off tarball+DB measurement, recorded not committed · measured at base `2c81bfcf` and recorded in `L5`/`L6` below: PASS on the packed-vs-source comparison, with the public read-back open to the extent of `listPages()` · commit: pending (this documentation commit; a commit cannot carry its own SHA, so the full SHA is filled by the next tracker update)
T4 · S1-S5 · route: gentle-ai-verify · independent verification against the specs · commit: pending (verification runs after these commits)
T5 · S1-S5 · route: gentle-ai-worker · promote the record to `odd/tasks/published-entry-port.md` ([published-entry-port.md](published-entry-port.md)) · commit: pending (this documentation commit; a commit cannot carry its own SHA, so the full SHA is filled by the next tracker update)
T6 · — · route: blocked · unblock condition: Manager schedules the F1–F4 slices (recorded in `L7`, not absorbed here) · commit: pending

## Log

L1 — original request (verbatim):

```text
## 1. The packed-manifest guard is scoped wrong (real gap)

The previous slice could not satisfy an acceptance criterion demanding no `workspace:*` in the packed root manifest. That criterion was **mine and it was wrong**: no package manager installs the `devDependencies` of a package you install, so the four `workspace:*` occurrences at root `package.json:103-106` are harmless to consumers. What actually protects embedders is **no `workspace:*` under `dependencies`**, and that block is clean (20 registry ranges, zero `workspace:`).

So:
- If a guard exists that asserts the whole manifest is free of `workspace:*`, **rescope it to `dependencies`** and say so — as written it demands something that is not a defect.
- If no such guard exists, **add one** asserting `dependencies` carries no `workspace:` / `workspace:*`, plus a positive assertion that the packed manifest's `dependencies` are all registry-ranged or URL-shaped.
- **Record the four `devDependencies` occurrences as cosmetic**, in a comment next to the guard, with the reason they are harmless — so a future reader does not "fix" them and break the workspace build. That comment is the deliverable as much as the assertion.

Prove the guard bites: temporarily inject a `workspace:*` into `dependencies`, observe RED, restore, observe GREEN.

## 2. The container check must carry the container's own `Host`

`/` returns **403** under a literal probe and **200** with the container's own `Host: <eth0>:4173`. That is the viewer's fail-closed origin gate, and `docker/` plus `packages/api/src/host/` are byte-identical to base. **This nuance has now surfaced twice in two slices.** Make the container check permanent: the probe sends the container's own `Host` header, and a comment states why — otherwise the next reader reads a 403 as a regression and "fixes" an origin gate. Keep the 403-on-wrong-`Host` case as an assertion too; it is a real security behaviour, not a wart to smooth over.

## 3. Run the one proof that no tier reaches — once, recorded, not committed

"A real ingest through the **installed tarball** together with a **live database**" was the honest gap: `test:pack` proves published types DB-free, and the artefact tier proves a real ingest but resolves the engine **from source**. Those are not one proof.

Run it once by hand: pack both tarballs (`PACK_DISTRIBUTION = ["packages/llmwiki-core", "."]`, `test/sdk/pack-distribution.ts:39`), install them into a scratch project, point it at a real database (pgvector `kind_kirch` or Docker), ingest a source, and read a page back. **Record the commands and the output.** If it passes, the claim is closed with a measurement; **if it differs from the source-resolved tier, that difference is the finding and the reason this item existed.** Do **not** commit it as a test — a DB-gated test that skips in CI buys the appearance of coverage at real spawn cost.

## 4. Promote the record to its own file

Create `odd/tasks/published-entry-port.md`. Right now S10 exists only as a Consequence line inside another feature's document, which is where findings go to be lost. It must carry four measured facts:
- Moving the root entry is **inert for the SDK path**: `dist/index.js` is 108,001 B with `resolveDimensions` 0, `LLMWIKI_DIMENSIONS` 0, `sdk/core.ts` 0, while the engine ships in `packages/llmwiki-core/dist/chunk-*.js` at 848,656 B.
- The engine reaches embedders through that **second published artefact** (`tsup.config.ts:17` externalizes it; `packages/llmwiki-core` has no `src/` and compiles `packages/wiki/src/core-index.ts` + `sdk/compiler-composition.ts`).
- The cost was always **larger than a file move**: `packages/api/src/index.ts` is a 44-line docstring with **zero exports**, so a composing entry could not reuse `"."` as-is.
- What publication gates is **registry consumers against the old pinned core**, not the evidence — `test:pack` installs the local core tarball beside the root one, so packed evidence is real today.
Add that a **required** port on `CreateWikiOptions` stays blocked until publication exists, because the published type must not name a private specifier.

## Gates

`gates:static` · `tsc --noEmit` · `typecheck:tests` · `lint` (ceiling is **zero headroom** at literal `566 baseline violations in 402 files across 429 rule/file entries` — new code must be violation-free; **`lint:update` is forbidden**) · `fallow:ci` · `build` · `test/artifact/*` · `pnpm test` **alone** · and `test:pack` **only if** you changed anything the packed path reads.

## Hard prohibitions

No history rewriting (no `git reset`, `git restore --staged`, `--amend`), **no hook bypass of any kind** — `git -c core.hooksPath=/dev/null` is functionally `--no-verify` and has already been disclosed once as a violation. No push, no `--no-verify`, no `HUSKY=0`, no `cp -a` of this worktree. `odd/tasks/**` append-only except the tracker line.
```

L2 — measurement, base `2c81bfcfed05cb8b9d2fe183f1ce213df234f0ab`: `git ls-files '*.test.ts' | wc -l` → **807**. `git status --short` → empty (clean). Branch `fix/packed-manifest-guard` == `main` at base, `git rev-list --count main..HEAD` → **0** commits ahead. That census has been reported as **799**, **800**, **803** and **807** on four consecutive slices; re-deriving it here confirms **807** at this base, so it is measured rather than carried.

L3 — reconnaissance correction: **no guard exists asserting the whole manifest is free of `workspace:*`.** The closest test is `test/affected-escalation-wiring.test.ts:171`, which mandates `"@repo/kg": "workspace:*"` in `devDependencies` and would go RED if a whole-manifest guard were added. Therefore "rescope it" has no subject to rescope, and `T1` adds the guard instead. The Manager's earlier acceptance criterion on the packed root manifest — that the packed manifest carry no `workspace:*` at all — is **retracted**, and the four `devDependencies` occurrences are recorded as cosmetic under `S2`.

L4 — environment: a reusable pgvector container `kind_kirch` (`pgvector/pgvector:pg16`, healthy, labels `llmwiki.role=shared-test-db`) is running; its host port is Docker-assigned per recreation (currently **32768**) and must be read with `docker port kind_kirch 5432/tcp`, never hardcoded; database `test`, user `test`. `LLMWIKI_TEST_DATABASE_URL` unset means DB-backed suites target the closed `localhost:5434` and **FAIL loudly** — they do not skip, so an unset variable is visible rather than silently green.

L5 — T3 measurement (one-off, recorded, NOT committed): run by hand at base `2c81bfcfed05cb8b9d2fe183f1ce213df234f0ab`. Not committed as a test, by design (see `S5`).

- Build: `corepack pnpm run build` → exit **0**. `dist/index.js` = **108,001 B**; `packages/llmwiki-core/dist/chunk-EASDPJWH.js` = **849,299 B**; `dist/api.js` **2.40 MB**.
- Packed by replicating the two `npm pack --ignore-scripts --json --pack-destination` calls directly rather than importing `packDistribution` (the helper was **not** driven): `packages/llmwiki-core` → `entryCount: 80`, `atomicstrata-llmwiki-core-1.4.0-dev.20260919.tgz` **2,050,224 B**; root → `entryCount: 74`, `llm-wiki-compiler-1.4.0-dev.20260919.tgz` **3,253,834 B**.
- Installed both tarballs with `npm install --ignore-scripts` into a scratch project. `npm ls --depth=0` → `@atomicstrata/llmwiki-core@1.4.0-dev.20260919` and `llm-wiki-compiler@1.4.0-dev.20260919`. `package-lock.json` showed **BOTH** `resolved` entries as `file:../tarballs/…tgz` — the **LOCAL core tarball**, not a registry version — and root's dependency `deduped` onto it.
- **Installed root manifest measured: `dependencies` = 20 entries with 0 `workspace:` occurrences; `devDependencies` = 4 `workspace:` occurrences.** This is direct evidence for the guard's scope (`S1`–`S2`) taken from the actual packed artefact rather than from the checkout.
- Database: `docker port kind_kirch 5432/tcp` → `0.0.0.0:32768`; db `test`, user `test`, password never printed. Schema present: `public.stacks`, `public.stack_documents`.
- Ingest through the **INSTALLED tarball**: write landed. The same ingest through the repo `dist/index.js`: **identical DB effect**.
- Compared: `listSources` identical except `ingestedAt`; `status` byte-identical after normalizing stack id/root (same 443-byte payload); `wiki.pages` **1** row and `wiki.source_documents` **1** row on both, with identical `slug: oneoff-packed-ingest`, `page_directory: concepts`, `body`, `source_identity: manual:b5bb3478…`, `content_hash: 0bb641cc…`, `size_bytes: 246`, differing only in `stack_id` and timestamps.
- sha256 over every `dist/*.js` and `*.d.ts`: `packages/llmwiki-core/dist` **BYTE-IDENTICAL across 41 files**; `dist/index.js` = `0841f969…` on both the repo and the installed tarball.
- **VERDICT: PASS — packed path indistinguishable from the source-resolved path.**
- **THE ONE HONEST SHORTFALL**: the public read-back `listPages()` could **NOT** complete on **EITHER** path: `_DrizzleQueryError … PostgresError: column "aliases" does not exist` (code **42703**). Cause: the shared container `kind_kirch` is **SCHEMA-STALE** — its `wiki.pages` lacks `aliases` and `attribution_gaps`, which HEAD's select requires (`packages/wiki/src/dimensions/wiki/schema.sql:101,104`). The read-back was therefore proven at the **raw `wiki.pages` row**, not through the public read API. The container was **not** migrated (it was not created by the run). The failure is **IDENTICAL on both paths**, so it is an environment condition, **not** a tarball-vs-source difference.
- **TWO PRE-EXISTING BUGS** found, identical on both paths, **out of scope**, not caused by this work: `getPage` throws `syntax error at or near "and"`; and `status.sources` reports `0` while `listSources()` returns **1** source.
- Cleanup: the run's own DB rows were deleted (`delete from public.stacks where domain like 'oneoff-%'` → **2 deleted**; counts went `{pages:2,sources:2,stacks:2}` → `{pages:0,sources:0,stacks:0}`). Tracked tree untouched by the run.

L6 — consequence: because the public read-back could not run against the stale container, the claim "a real ingest through the **installed tarball** with a **live database**, read back through the **public API**" remains **open exactly to the extent of `listPages()`**. The ingest itself and the stored row it produced are **proven** — on both paths, and byte-identically so. What is unproven is only the final hop through the public read API, and it is unproven **on both paths equally**, so it carries no information about the difference between them. Closing it needs a container whose `wiki.pages` carries `aliases` and `attribution_gaps`; migrating `kind_kirch` was out of scope for this run.

L7 — out-of-scope findings, escalated to Manager (recorded, NOT absorbed by this slice): the slice stays at its four items. Nothing below is fixed, worked around, or partially addressed here; the Manager schedules each as a separate slice. Reproductions are kept verbatim and copy-pasteable.

**F1 — the schema-stale reusable container (the important one).**
`kind_kirch`'s `wiki.pages` has columns `archived,body,created_at,links,orphaned,page_directory,slug,source_identity,stack_id,summary,tags,title,updated_at` and is MISSING `aliases` and `attribution_gaps`, which HEAD's select requires (`packages/wiki/src/dimensions/wiki/schema.sql:101,104`). Consequence: every DB-backed result obtained against that container is untrustworthy, and any `listPages()` there dies with `PostgresError: column "aliases" does not exist` (code 42703).
Reproduce: `docker port kind_kirch 5432/tcp`; export `LLMWIKI_TEST_DATABASE_URL` for db `test`, user `test`; run any DB-backed read that selects from `wiki.pages`.
Root cause shape: `prepareContainerDatabase` skips schema work when a container is reused (`test/fixtures/testcontainers-postgres.ts:31-40`), so nothing detects the mismatch.
Proposed remedy (Manager's, verbatim intent): not "recreate the container" — that repairs one machine and teaches nobody. The reuse path must **verify the schema and fail loudly when it does not match**, so the next stale container announces itself instead of silently degrading every read.

**F2 — `getPage` throws `syntax error at or near "and"`.**
A public read method failing with a generated-SQL error. Likely shape: a trailing `and` with no operand, i.e. an empty-predicate path the tests never exercise. Reproduces identically from the installed tarball and the repo `dist/`, so it is neither this slice's doing nor the packed path's.
Reproduce: ingest one markdown source, then call `getPage`.

**F3 — `status.sources` reports `0` while `listSources()` returns 1.**
A counter disagreeing with the list it summarises. Same status: identical on both paths, pre-existing.
Reproduce: ingest one source, compare `status.sources` against `listSources().length`.

**F4 — hardcoded container port in a committed document.**
`odd/tasks/stack-scoped-compile-lock.md:87` records the shared container at `localhost:32782`; the real host port is Docker-assigned per recreation and was `32768`. Same class as the `Host`-header 403: a reader trusting a document over the system. This file is NOT edited by this slice. Standing rule recorded here: read the port with `docker port kind_kirch 5432/tcp`, never hardcode it.
