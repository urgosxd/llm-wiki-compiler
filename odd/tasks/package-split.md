# Feature: package-split

The authorized monorepo split of llm-wiki-compiler: four packages — `@repo/wiki`, `@repo/kg`,
`@repo/api` and a bottom `@repo/foundation` — carved behind a boundary gate that can actually see
the boundary. Status: **S0** is complete, and the `@repo/kg` carve and the `@repo/foundation`
bottom layer have landed with three repair commits; **S3–S5** are unstarted and **S6** is partial —
the boundary gate is re-pointed at `@repo/kg` and proven to bite, but `@repo/wiki` and `@repo/api`
do not exist yet, so the allowed-edge matrix cannot be verified.

## Specs

Spec IDs are `S1`–`S9`; slice/task IDs are `S0`–`S6` from the program plan; any `specs:` value in the `## Tasks` table is always a spec ID.

Every spec below quotes the human's decision verbatim; any line marked `Consequence:` is derived
from the quote and is secondary.

S1. TARGET TOPOLOGY. "Target topology: three packages `@repo/wiki`, `@repo/kg`, `@repo/api`, plus a fourth bottom layer `@repo/foundation` — approved over `@repo/core` to avoid collision with the published `@atomicstrata/llmwiki-core`."

Consequence: four packages, not three, and the fourth is the bottom layer. The name `@repo/core` is not available even as an alias, because the collision it was rejected for is with a package this repository already depends on.

S2. ALLOWED DEPENDENCY EDGES. "Allowed dependency edges: `api → wiki`, `api → kg`, `{wiki,kg,api} → foundation`."

Consequence: `@repo/api` is the only package permitted to depend on both dimensions, and `@repo/foundation` is the only package every other package may depend on.

S3. FORBIDDEN EDGE. "Forbidden: `wiki ↔ kg` forbidden both ways."

Consequence: this is the authority the boundary gate encodes. Neither direction becomes permitted at any slice.

S4. DECISION D1, THE DISSOLUTION. "Decision D1: `src/dimensions/kg` dissolves into `@repo/api`, with only `ontology-store.ts` and `embedding-model-bridge.test.ts` going to `@repo/kg`"

Consequence: `src/dimensions/kg` does not become a package of its own, and the two named files are the only members of it that land in `@repo/kg`.

S5. WHERE TESTS LIVE (second half of D1). "unit tests live in the owning package, module integration in-package with Testcontainers, cross-module integration in `@repo/api`"

Consequence: test placement follows package ownership, and the only home for a test that spans modules is `@repo/api`.

S6. EVERY RELOCATION IS A RENAME. "Every source relocation must be a `git mv` rename with unchanged content — a copy would make git report ~200k changed lines for the same result and is grounds for rejection."

Consequence: a delete-plus-add or a re-created file is not an acceptable relocation mechanism, whatever the resulting tree looks like.

S7. SLICE S0, THE GATE MUST SEE THE REAL SURFACE. "S0 (this slice, already specified): widen the dimension boundary gate so it sees dynamic `import()` and `vi.mock`/`vi.doMock` with literal specifiers, report non-literal specifiers as their own category, leave the boundary itself unchanged (`wiki → kg` and `kg → wiki` stay forbidden exactly as today), and rebaseline so the ratchet visibly grows with a named cause."

Consequence: the widened gate is a prerequisite of every carve, because a package split that claims a clean boundary cannot be proven by a gate that cannot see part of the surface. Non-literal specifiers are reported in their own category rather than ignored — a report, not a silent pass.

S8. SLICE S0 DOES NOT CHANGE THE BOUNDARY. "leave the boundary itself unchanged (`wiki → kg` and `kg → wiki` stay forbidden exactly as today)"

Consequence: S0 changes what the gate can see, never what it permits. Any site it newly reports is a pre-existing reach site, and rebaselining it is growth with a cause, never a permission.

S9. SLICE S0 HARD PROHIBITIONS. "Hard prohibitions for S0: no moving of source files, no `package.json` changes, no touching `eslint-baseline.json` outside the enumerated growth, no history rewriting, no push, no `--no-verify`."

Consequence: S0 is a gate slice. Source relocation belongs to S1 and later, and the only legitimate baseline edit is the enumerated growth the widened rule makes visible.

## Tasks

S0 — Widen the dimension boundary gate so it sees dynamic `import()` and `vi.mock`/`vi.doMock` with literal specifiers, report non-literal specifiers as their own category, keep the boundary exactly as it is, and rebaseline so the ratchet visibly grows with a named cause. — specs: S7, S8, S9 — commit: ac0b54b29f06ab3626de759b1245e45134970c01

S1 — Create `@repo/foundation` and relocate the dimension-agnostic shared modules into it with `git mv`. — specs: S1, S2, S3, S6 — complete — commit: d8f10e8800326cce6f3918a52ccc7039746c3c07, followed by d022086f6c45b3e06770e9c10a0905f83e1298d3 (the dimension-agnostic shared module landed as the `DatabaseHandle` seam; the forfeited strict TS flags are recorded in L11)

S2 — Carve `@repo/kg` from `packages/llmwiki-kg`, landing `ontology-store.ts` and `embedding-model-bridge.test.ts` there per D1. — specs: S1, S2, S3, S4, S6 — complete — commit: 1971ead9a525a451bad8537be9788f238b47bcc2, followed by aedadebffb91c1a4697c8bba2d59d1fb412741ed

S3 — Carve `@repo/wiki` from `src/dimensions/wiki`. — specs: S1, S2, S3, S6 — commit: pending

S4 — Carve `@repo/api`, absorbing `src/dimensions/kg` per D1. — specs: S1, S2, S3, S4, S6 — **partial, not complete** — commit: dc47d27a6632f8b3bad68f1aec7d5a3c665215f6, 6e1370e687e258f273d93f6820fabefc57a3a0c9, d94b20108e51ce8ebd25c855c4d8a95b5b45f6d2 (`@repo/api` exists and is gated, but D1's dissolution did not happen because it cannot happen before `@repo/wiki` exists (see L12))

S5 — Place unit tests in their owning package, module integration in-package with Testcontainers, cross-module integration in `@repo/api`. — specs: S5 — commit: pending

S6 — Re-point the boundary gate at package names, verify the allowed edges `api → wiki`, `api → kg`, `{wiki,kg,api} → foundation` and that `wiki ↔ kg` is rejected both ways, and bring all gates green. — specs: S2, S3 — **partial, not complete** — commit: none yet (the gate is re-pointed at `@repo/kg` in 1971ead9a525a451bad8537be9788f238b47bcc2 and proven to bite, and all gates are green, but `@repo/wiki` and `@repo/api` do not exist yet, so the allowed-edge matrix cannot be verified)

## Log

L1 (opening of the effort): `la fase 1`

L2 (go for this split): `procede a la siguiente fase`

L3 (D1): `D1 disuelto en api`

L4 (D2): `D2 si`

L5 (naming): `si repo foundation`

The pre-compaction origin of this effort is not available verbatim, so this log starts where it starts; nothing here is reconstructed from memory.

L6 (measurement correction, decided by the Manager). The number this document was written around was wrong, and the correction is recorded here rather than swapped in silently. Verbatim: "Proceed with 116 / 77. Do not stop, and do not suppress anything to hit my number." Verbatim: "80 + 30 = 110 literal + 6 non-literal = 116 sites / 77 files is the number. My 107/76 was wrong; your reconciliation (67 + 9 = 76) is the correct arithmetic." The original yardstick was **107 sites / 76 files**; the exhaustive per-file scan found **116 sites / 77 files**; the delta of 9 sites / 1 file is **measurement error in the original count, not new leaks**. The attribution, stated explicitly: the original pass counted a JSDoc comment at `test/dimensions/kg-core-mock.ts:18` as a `vi.mock` registration (there are 4, not 5), and it conflated "files containing an invisible form" (11) with "files reaching only through one" (9). Neither error is a code change; both are the original count being wrong about the same tree. Verbatim, on the triple quoted earlier in the slice: "That triple was a stale base, and the 644/492/520 baseline is right." The earlier 650/498/526 figure is therefore discarded as a stale base, and the confirmed static baseline is **80 sites / 67 files, all `wiki → kg`, with `kg → wiki` = 0**. Disposition principle recorded as stated: a yardstick that turns out to be wrong stops being a yardstick the moment it is measured; leaving the wrong number in the document because it is the one the Manager gave would be the failure mode being corrected here.

L7 (non-literal specifier category decision). **6 non-literal sites exist, all in `test/dimensions/kg-config-laziness.test.ts`**, each an `import(SOME_CONST)` where the const is a module-scope string literal. Decision on the three options, verbatim: "**(c) is out.** Static constant resolution inside a lint rule is a mini-evaluator living in the boundary gate. It would make the gate's behaviour depend on evaluation semantics nobody else models, and the failure mode is silent: a specifier that resolves in the rule but not at runtime reads as clean. More machinery, more ways to be confidently wrong." Verbatim: "**(a) today** is correct: a labelled, honest, non-zero category beats a clever zero." Verbatim: "**(b) later, but only if inlining preserves what the test proves.** `kg-config-laziness.test.ts` exists to test lazy config loading through computed specifiers — that computed-ness may *be* the subject, not an accident. If inlining would change what the test demonstrates, then the category stays non-zero **forever, documented as such**, and that is a fine outcome. A permanent labelled category is better than a test that keeps its name and loses its point. Say in the follow-up note which of the two it is; do not assume inlining is safe because it compiles." So option **(a) ships in S0**, and option **(b) is a follow-up** whose note must state which of those two outcomes applies.

L8 (rebaseline constraint). Verbatim: "**the rebaseline diff must contain only the entries you just enumerated.** If `lint:update` produces a 37th site or an entry in a file you did not list, that is a regression wearing the same costume, and it stops the slice." The envelope, as predicted before the rebaseline and confirmed as measured (see L10): static `no-restricted-imports` unchanged at **80 sites / 67 files**; **30** new literal sites in **11** files; **6** non-literal sites in **1** file; **12** added baseline entries; triple `644/492/520 → 680/498/532`.

L9 (the type-level reach, recorded as a finding). `test/dimensions/kg-runtime-extraction-provenance.test.ts:192` reaches kg through a TS `typeof import()` — a real compile-time coupling invisible to every import-based gate — so the widened gate must also visit `TSImportType`, not only `ImportExpression` and `vi.mock` factories.

L10 (rebaseline measured, and the orchestrator's own prediction corrected). The S0 rebaseline as measured: static `no-restricted-imports` unchanged at **80 sites / 67 files**; the new rule `local/dimension-boundary` reports **36 sites in 12 files** = **30 literal sites in 11 files** + **6 non-literal sites in 1 file**; triple `644/492/520 → 680/498/532`; **exactly 12 baseline entries added, 0 removed, 0 changed**, plus one `configuration` digest line that moved because `eslint.config.mjs` bytes changed. The correction is attributed to the orchestrator's own prediction being wrong, not to a code change: L8 predicted `502` files-with-violations on the assumption that all 12 new-key files were new to the baseline, but **6 of the 12 already carried another house-rule violation** (for example `max-lines-per-function`) and were therefore already counted inside the `492`, so only 6 files are added: 492 + 6 = 498. Totals (`680`) and rule/file entries (`532`) matched the prediction exactly; only the files-with-violations component moved. The ruled-on figure of **116 sites / 77 files** (L6) is unaffected and remains the agreed reach surface: this correction concerns only the ratchet's files-with-violations component, never the reach count. The count the Manager's ruling established, verbatim: "80 + 30 = 110 literal + 6 non-literal = 116 sites / 77 files is the number."

L11 (delivery of the `@repo/kg` carve and the `@repo/foundation` bottom layer, batched as "S1 + S2 + S3" in the delivery's own labels). The instruction that scoped it, verbatim: `continuemos con el plan … todas las S1 s2 s... s6, tener turborepo y un monorepo estable`. **Label collision, resolved here so a later reader does not have to guess:** the delivery's internal step labels (`S1`/`S2`/`S3`) are a *different slicing* from this document's `S1`–`S6`, and the `## Tasks` cells above are recorded by what was actually done. The delivery's `S1` = this document's **S2** (`1971ead` + `aedadeb`: rename the package to `@repo/kg`, re-point the boundary gate, move `ontology-store.ts` and `embedding-model-bridge.test.ts`). The delivery's `S3` = this document's **S1** (`d8f10e8` + `d022086`: `@repo/foundation` with the `DatabaseHandle` seam). Nothing in the delivery corresponds to this document's `S3`–`S5`, and this document's `S6` is advanced, not closed. Three repair commits sit on the batch: `9c73ff6` (build: bundle the private workspace packages instead of externalizing them), `d022086` (docs: the seam's evidence pointers), `66a4a05` (packaging: `postgres` as a runtime dependency).

Measured evidence, re-measured against `a2c001f..66a4a05` for this entry. Boundary census **116 sites / 77 files → 80 sites / 42 files**: static `no-restricted-imports` **80 → 44** sites (67 → 32 files) and the widened `local/dimension-boundary` rule **unchanged at 36 sites / 12 files** — so the entire drop is the rename's real reduction and no part of it is the gate going blind. Baseline: **35 keys retired, 0 added, 0 rule values changed**; the only moved value is the `configuration` digest (`81fb64e0…` → `c36d6dcd…`), because `eslint.config.mjs` bytes changed. Both relocations are `=>` renames — `git diff --summary -M a2c001f..66a4a05` reports `rename {src/dimensions/kg => packages/llmwiki-kg/ts/src}/ontology-store.ts (94%)` and `…/embedding-model-bridge.test.ts (92%)`. The `Database` importer surface was resolved **by counting, not by picking between the two reported numbers**: **37 files**, in two syntactic families — the "25" was `src/`-only single-binding imports, the "27" was all `src/` files carrying the binding. Lint triple trajectory: **680/498/532 → 677/496/530 → 644/467/497**. Gate bite proof: an `@repo/kg` import introduced in `src/sdk/types.ts` fires `no-restricted-imports` with the wiki-must-not-import-kg message, and the file was restored byte-identical.

The failure only the exhaustive suite could see. Verbatim: `Every fast gate was green — tsc, both typechecks, lint, build, fallow:ci, fallow:kg, and test:affected escalated to the full unit tier — while 403 tests in 75 files failed because the shipped CLI cannot start. Only the exhaustive suite caught it.` Mechanism: `@repo/kg` in root `dependencies` made tsup externalize it, Node resolved it to raw TypeScript, and `dist/cli.js` died with `ERR_MODULE_NOT_FOUND`.

Final gate of record at `66a4a05bce3ca7feccb2370741670290c7a3f769`: `pnpm test` **920 files / 6844 tests**, 917 passed, 3 env-gated skips, **0 failures**; `test:affected` escalated and green; `test:pack` 1/1; `dist/cli.js` and `dist/index.js` carry **zero** `@repo/*` specifiers.

Deliberate deviations a reviewer must be able to find: the delivery's-S2 baseline key migration (2 keys retired by hand, strict reduction); the delivery's-S3 baseline reduction (33 keys, 0 insertions); the mock-seam relocation in `test/dimensions/kg-core-ontology-read.test.ts`; the widening of 10 KG signatures; both workspace packages placed in `devDependencies`; `postgres` promoted to `dependencies` with a `.fallowrc.json` suppression whose reason lives in `docs/fallow-gates.md`; and the deleted `packages/foundation/tsconfig.json`, whose forfeited flags — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUnusedLocals` — never applied to this package because no gate ever ran that file. They are not silently re-baselined: foundation is now a root-program root through the root `include`, so it cannot stop being type-checked when its last importer disappears.

Verifier incident, recorded as a permanent caution: `cp -a` on a linked worktree copies a `.git` **pointer file**, so any git command inside the copy operates on the shared gitdir — build a baseline tree with `git worktree add` or `git archive`, **never `cp -a`**. It cost no file content (2176 paths verified), and the repair was `git checkout -f`.

Three follow-ups named and explicitly not done: a prepublish manifest rewrite so the packed `devDependencies` carry no `workspace:`; the 9 removable `as unknown as DatabaseHandle` casts (proven removable, only `scope?.tx` needs narrowing); and `@repo/kg`'s `exports` targeting source rather than `dist/`.

L12 (delivery of slice S4 — `@repo/api` created and gated, D1's dissolution deferred). The decision, verbatim: "**Path B, approved — and the sequencing error is mine, not yours.**" Verbatim, on the first alternative: "Rejected: Path A. A named allowlist for five files, two of them inside the engine, is the inverted arrow wearing a baseline." Verbatim, on the second: "Also rejected: the provider registry." The reordering, verbatim in its substance: the next slice is `@repo/wiki`, then the pipeline inversion as its own slice, with a `DimensionsPort` interface in `@repo/foundation`, implemented in `@repo/api`, constructed at the entry points and threaded as an explicit option through compile and ingest — and in that slice alone "no test edits" does not apply.

**Why the S4 scope as written could not be executed, measured.** `src/**` *is* the wiki side, because `@repo/wiki` does not exist (S3 above is still `commit: pending`). Moving the join into `@repo/api` while the wiki side remains root `src/` would make `@repo/api` import root `src/` it does not own — acceptance criterion 4 inverted. The size of that reach was measured rather than argued: `resolveDimensions` has wiki-side callers at `src/compiler/index.ts:1411` and `src/services/ingest/service.ts:176`; no option object in compiler, ingest, mcp or viewer carries a `dimensions` field, so the value cannot be threaded yet; `LLMWIKI_DIMENSIONS` drives `kg` in-process from **three test files** — `test/compiler/graph-retirement-dimensions.test.ts`, `test/quickstart-concurrency.test.ts` and `test/dimensions/kg-shared-credentials-env-order.test.ts` — **plus the fixture helper** `test/fixtures/env-stack.ts`, four files under `test/` in total (`grep -rln "LLMWIKI_DIMENSIONS" test/`); and `createDimensionsDatabase` has **31 call sites across 17 files under `src/`** (`grep -rn "createDimensionsDatabase(" src/ --include=*.ts` returns 32 lines, one of them the definition at `src/dimensions/activation.ts:129`; a bare-name grep reports 24 files because it counts import lines too, which is a different quantity and not the one measured here). The join could therefore only have moved by pointing an arrow upward, which is the one thing the topology forbids.

**What did not move, named.** `src/dimensions/activation.ts`, `src/dimensions/kg/**` and `src/host/server.ts` were not relocated, because `@repo/wiki` does not exist and moving them today would make `@repo/api` import root `src/` it does not own. Measured: `git diff --summary -M` over the slice shows four `create mode` lines and **zero `=>` renames**. Nothing in this slice claims to be a relocation, so nothing in it is arithmetic a reviewer has to reconcile.

**Census, measured independently.** Bases `f9ea54fb`: **80 sites / 42 files** — `no-restricted-imports` **44** sites, `local/dimension-boundary` **30** literal + **6** non-literal. HEAD `d94b201`: **79 sites / 41 files** — **43** + **30** + **6** — with `kg → wiki` = **0** and `wiki|kg → api` = **0**. The decomposition is **exactly one row**: `src/utils/stack-id.ts`, `no-restricted-imports` **1 → 0**, cause = the re-export specifier changed from `@repo/kg` to `@repo/foundation`. **No file gained a site.** The drop is small because the join's ~37 reached files wait for the slice that can carry them legally; a larger number here would have been the inverted arrow arriving as progress.

**The three commits and what each holds.** `dc47d27a6632f8b3bad68f1aec7d5a3c665215f6` — the package skeleton plus both gate rules extended with the `{wiki,kg} → api` pair. `6e1370e687e258f273d93f6820fabefc57a3a0c9` — the Stack-id rule moved to `@repo/foundation` plus the two provider interfaces. `d94b20108e51ce8ebd25c855c4d8a95b5b45f6d2` — the two defects independent verification found.

**The five bite proofs, each with the rule that fired.** Static `wiki → @repo/api` fires `no-restricted-imports` with `NO_WIKI_API_IMPORT`; dynamic `wiki → @repo/api` fires `local/dimension-boundary`, because `no-restricted-imports` never visits `ImportExpression`; static `kg → @repo/api` fires `no-restricted-imports` with `NO_KG_API_IMPORT`; static `wiki → @repo/kg` still fires with the ORIGINAL message wording, the concatenation in `WIKI_BOUNDARY` having preserved the kg pair's bytes and order; and the `kg`-zone relative walk `../../../api/src/index.ts` fires `local/dimension-boundary` through the `^(\.\./){3,}api` pattern. That last one is the finding: the hole was real, and the verifier's first specifier for it (four `../`) silently resolved to a non-existent path — so the three-`../` arithmetic was measured against the real tree before the test was written, not inferred from the pattern.

**Deviations a reviewer must be able to find, each with its cause.** The `test/pnpm-migration-wiring.test.ts` edit — one enumerated `workspaces` data line, `toEqual` intact, `it` count 9 → 9, and the file's own `pnpm-workspace.yaml` cross-check untouched and green — because the slice legitimately added a workspace member and the full suite was otherwise RED. `src/utils/stack-id.ts` NOT deleted — BLOCKED by `test/mcp/stack-id-guard.test.ts:6`, which pins that specifier and must stay byte-identical. The KG `stack-id.ts` kept as a documented re-export shim, for the same reason. And the two `eslint-baseline.json` digest moves (`c36d6dcd… → 38deb2aa… → 8e75ec52…`) plus the one hand-retired key, because `lint:update` cannot express a decrease.

**The interfaces do not match the shapes in the original brief, and the callers are why.** `AdvisoryLockProvider` is shaped from `src/utils/lock.ts:288` — a non-blocking try-acquire where the wait policy and the release registry belong to the caller — so it has no `ttlMs` and no DSN. `ProjectConfigProvider<TConfig>` is shaped from `src/dimensions/wiki/project-config-seam.ts:50` — it resolves a Stack id, and the config type stays the owner's, so the bottom layer never names a wiki type. Both shipped with **no implementation and no registry**.

**The finding that outlives this slice, stated as a constraint on the next one.** `@repo/foundation` publishes TypeScript source with no build, so any *value* import from a `tsc`-compiled `dist` into its barrel fails at runtime with `ERR_MODULE_NOT_FOUND`; every prior edge into it was `import type` and erased. The `./stack-id` subpath export is what makes the first value edge resolve. And the tier that would have caught it on a fast gate could not start: **every fast gate, including the escalated full unit tier, was green while the KG e2e harness could not start its child process** — the same failure shape L11 records, one tier down. Check the child process of any harness that crosses this edge, not only that its files pass.

**Residual gate findings, measured and deliberately not fixed.** The `^(\.\./){3,}api` depth bound mirrors `KG_TO_WIKI`'s `{4,}`: a two-segment walk from `packages/llmwiki-kg/ts/` is not reported, and that is a stated bound, not an oversight. `node_modules`-routed specifiers are invisible to all four edge patterns — pre-existing and symmetric, so fixing one side alone would tilt the gate. `API_ZONE = tree("api/")` is stale and must be fixed in S5/S6, when `@repo/api` gains code.

**Gate of record.** Every gate exit 0. Ratchet triple **643/466/496** against the ceiling **644/467/497**. Full suite alone: **920 files / 6845 tests**, 917 passed, 3 skipped files; **6838 passed, 7 skipped tests, 0 failures, 376.42s**. `test:pack` 1/1. `node dist/cli.js --version` exit 0 printing `1.4.0-dev.20260919`. `grep -o '@repo/[a-z-]*' dist/*.js` empty.

**Status correction for the next reader.** The header's status sentence still says S3–S5 are unstarted and is not rewritten here, so the correction is recorded in this entry instead: **S3 is still pending**, **S4 is partial**, and **S6 stays partial** because `@repo/api` is an EMPTY package — zero exports, zero dependencies — so the permitted `api → wiki` and `api → kg` directions remain unexercised.
