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

S3 — Carve `@repo/wiki` from `src/dimensions/wiki`. — specs: S1, S2, S3, S6 — **advanced, not complete** — commit: 61cee9c09bfd9ae9144c5a35c7a3ce3be12fcd35, followed by the commit carrying L13, which is 8d3d4a449abebedfaf195a012f09f51c0f099546 (the `API_ZONE` re-point and the census re-derivation), followed by the two root-`src` residue repairs L14 records: d3fb36ceb8d0eed13109b1816115a84bdf7eee05 (the partition roots, the font-vendor target and the typecheck oracle's literals) and 3a0c70d9da1c8f82c08723478763975a4367a56e (`test/fixtures/src-tree.ts` pointed at the relocated package) — L15 records that these two SHAs were absent from this document until it was written. The parent brief labels this slice `S5: create @repo/wiki and relocate src/`, and that brief label is **this document's S3**, not this document's S5 (see L13); the relocation moved the whole `src/` tree into `packages/wiki/src/`, so the package exists while the wiki dimension is not yet singled out inside it.

S4 — Carve `@repo/api`, absorbing `src/dimensions/kg` per D1. — specs: S1, S2, S3, S4, S6 — **partial, not complete** — commit: dc47d27a6632f8b3bad68f1aec7d5a3c665215f6, 6e1370e687e258f273d93f6820fabefc57a3a0c9, d94b20108e51ce8ebd25c855c4d8a95b5b45f6d2 (`@repo/api` exists and is gated, but D1's dissolution did not happen because it cannot happen before `@repo/wiki` exists (see L12)), followed by 8479e7d3a2e326caabdfa412bc3ad103a3d5e869 (the `DimensionsPort` seam in `@repo/foundation`: `DimensionsRequest`, `DimensionsPort<TDimension>`, `MissingDimensionsPortError`, `requireDimensionsPort`, plus its in-package test) and cf1412cedb6e52f3bc05d4143be44efc2a4c7044 (`packages/wiki/src/utils/stack-id.ts` deleted, its single importer re-pointed at `@repo/foundation`). The join itself is **not** landed: the composition root of the shipped container is the CLI (`docker/entry.sh:64,84`), so the port has no legal production construction site while `cli.ts` lives in `packages/wiki/src` — see L17. The CLI-removal slice is a prerequisite.

S5 — Place unit tests in their owning package, module integration in-package with Testcontainers, cross-module integration in `@repo/api`. — specs: S5 — commit: pending (untouched: only `test/`'s import specifiers were rewritten, the test estate has not moved — see L13's label note)

S6 — Re-point the boundary gate at package names, verify the allowed edges `api → wiki`, `api → kg`, `{wiki,kg,api} → foundation` and that `wiki ↔ kg` is rejected both ways, and bring all gates green. — specs: S2, S3 — **partial, not complete** — commit: none yet (the gate is re-pointed at `@repo/kg` in 1971ead9a525a451bad8537be9788f238b47bcc2 and proven to bite, and all gates are green, but `@repo/wiki` and `@repo/api` do not exist yet, so the allowed-edge matrix cannot be verified; advanced by 61cee9c09bfd9ae9144c5a35c7a3ce3be12fcd35 (which moved `WIKI_ZONE` to `packages/wiki/`) and by the commit carrying L13, which is 8d3d4a449abebedfaf195a012f09f51c0f099546 (which fixed the stale `API_ZONE`, brought the ratchet's matching pattern into step, and re-derived the census at 79 sites / 41 files with a bite proof — still partial, because `@repo/api` is empty and the permitted `api → wiki` / `api → kg` directions stay unexercised)

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

L13 (delivery of the `@repo/wiki` relocation and the `API_ZONE` re-point).

**The label does not transfer, and this is the second time it needs saying.** The parent brief calls this slice **S5**, but its `S5: create @repo/wiki and relocate src/` is **this document's S3** — the `## Tasks` cells above are recorded by what was actually done, so `61cee9c` sits on S3, and this document's `S5` (test placement) is untouched and still `pending`. Two commits carried the slice: `61cee9c09bfd9ae9144c5a35c7a3ce3be12fcd35` (the relocation plus 1,946 rewritten external specifiers) and the commit carrying this entry (the `API_ZONE` re-point and the census re-derivation).

**The measure, corrected rather than absorbed.** **560** files relocated — not the 564 the brief assumed — every one at 100% similarity with zero deletions, measured as 560 lines of `=>>` in `git diff --summary -M ca075d41..61cee9c`. Authored change **2,417 lines added / 2,242 deleted** (`git diff --numstat` over the same range) against ~101,900 relocated lines: a ratio of **≈42:1** — **one order of magnitude, singular**, not the three the brief assumed. The body of `61cee9c` states **2,355 authored lines / ≈43:1**, a figure that predated the final two fixtures and is superseded by this entry. **No amend was made, because history rewriting is prohibited**; the correction lives here, where a reviewer of the arithmetic will look.

**The fallow rename-attribution limitation, named as a follow-up with the choice left open.** `fallow audit --gate new-only` attributes findings BY PATH, and its duplication fingerprints are computed over byte-identical clone ranges, so a rename is re-attributed as introduced rather than recognized as moved. Two options, and this entry **recommends neither**:

(a) Teach the gate rename-aware attribution — a line-based diff behind `FALLOW_DIFF_FILE`, so a finding binds to the range that survived instead of the path that carries it. Expensive: it changes what `codebase-health` means on every future PR, and it needs CI parity and docs changes in the same rollout.

(b) Accept that a large rename ships as a single commit. Cheap, and honest as long as the evidence boundary is kept: `git diff --summary -M` at 560 `=>>` lines for the relocation itself, and the authored-vs-relocated ratio for the arithmetic a reviewer checks instead of reading thousands of changed lines.

**This delivery used (b)**, and S6 and the pipeline inversion will meet the same wall. The consequence is stated, not hidden: slices 1 and 2 of the original three-commit plan (package creation + `git mv`, then the specifier rewrite) **collapsed into one commit**, because an intermediate state that moves 560 files before rewriting their importers is not merely red — it is *unmeasurable*, with 2,797 unresolved imports making 197 exports and 49 health findings look new. What ships is not the planned slicing; it is the slicing that keeps the gate answerable. The (a)/(b) choice stays open for whichever later slice has to pay for it.

**The standing rule, quoted verbatim, because this slice produced four instances of it.** "Every commit that changes a path must re-derive the gate's reach. Boundary rules and gate identity functions are anchored on path **spelling** and on **source text** — a rename is a path change, a depth change is a spelling change, and a rule that stops matching reports *zero* violations, indistinguishable from a clean tree. Re-measure the census in the commit that moves the paths, and reject any decrease you cannot attribute to a concrete cause."

The four instances observed today: the `llmwiki-kg` → `@repo/kg` package rename, which left every pattern anchored on the old name matching nothing; `KG_TO_API`'s pattern that matched only a `/packages/api` segment, while a KG file three directories below `packages/` spells `../../../api/src/index.ts` and resolves into the joiner without ever spelling it — measured clean by the gate; `KG_TO_WIKI`'s `^(\.\./){4,}src`, anchored on a root `src` that stopped existing the moment the tree moved to `packages/wiki/src/`; and fallow's duplication fingerprints, which re-attribute byte-identical clones whenever a specifier inside the cloned range changes, so a pure rename reads as introduced duplication.

**Two silent-green surfaces found and closed, both on the same day.** `test/boundary-gate-visible-forms.test.ts:120` spelled the **pre-move** path in its kg-zone probe, so it went on asserting a boundary message about a file that no longer existed — a probe that passes against nothing. Its specifier now resolves to the live tree (`../../../../packages/wiki/src/dimensions/wiki/index.js`). `test/fixtures/core-tree-fingerprint.ts` is dead code that ran `git ls-files src`: after the move that command lists nothing, so the function would have returned a constant hash while reading like a byte-level witness. Its path moved to `packages/wiki/src` with everything else. Measured, and worth stating plainly: the file has **no importers** at either end (`git grep core-tree-fingerprint` is empty at `ca075d41` and at HEAD), so what was closed is a false green waiting to be wired, not a live one.

**The `apply-schemas.sh` dual contract, and why it did not break.** `scripts/apply-schemas.sh` has two consumers with two different contracts: the container init scripts execute it, and `packages/llmwiki-kg/ts/src/testing/per-run-database.ts` parses its `SCHEMA_FILES=(` array **out of the file text** (with `test/dimensions/db-parity-migration.test.ts` pinning the same text). Neither consumer is reached through the moved tree, so the relocation could not sever it silently — proven by the 30 database-backed tests running with **0 skipped** in the full-suite verification of `61cee9c`. That is the only tier that can prove it: `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` downgrades exactly those failures to skips that report a reason, which is why CI must never set it.

**`API_ZONE` fixed in this commit.** It read `tree("api/")` and matched nothing, while `@repo/api` lives at `packages/api/` — inert today, a hole the day the package gained code. It now reads `tree("packages/api/")`, and the entry in `scripts/lint-ratchet.ts`'s `LINT_PATTERNS` that the file's own comment requires to stay in step with `CODE_FILES` moved with it, to `packages/api/**/*.{ts,tsx,js,mjs,cjs}`. The configuration digest moved as a consequence and was accepted through the documented `pnpm run lint:update` — `0cd0733…` → `308f84b…`, **one line changed, zero count changes, nothing else rewritten** — and the literal triple is unchanged at **643 / 466 / 496**. `eslint.config.mjs`'s redundant `api/**/*.ts` entry in `TYPESCRIPT_FILES` was left alone deliberately: `packages/**/*.ts` already reaches that tree, so it is dead-but-harmless rather than a hole, and this commit changed only what it enumerated.

**Census and bite proof for the gate commit.** The census was re-derived through the ratchet's own collector, before and after the change: **79 sites / 41 files** both times, identical to the last row — `no-restricted-imports` 43 static, `local/dimension-boundary` 30 literal + 6 non-literal, `kg → wiki` **0**. A re-point that changed the census would have meant the old zone was reachable code; an unchanged census here is the claim that the zone was already live and the change closes a hole that had not yet opened. The bite proof: throwaway probes in both zones carrying one forbidden reach per direction drove the census to **89 sites / 43 files** (static 49 + literal 34 + non-literal 6; `kg → wiki` 2, `kg → api` 2, `wiki → kg` 78, `wiki → api` 1) and the ratchet to **653 / 468 / 500** with 10 rule messages — all four directions and all three invisible forms (`import()`, `typeof import()`, `vi.mock`) firing — and deleting the probes returned the census to **79 / 41** with a clean `git status`.

**Gates of record for the gate commit.** `tsc --noEmit`, `typecheck:tests`, `typecheck:kg`, `lint` (643/466/496), `build`, `node dist/cli.js --version` → `1.4.0-dev.20260919` exit 0, `grep -o '@repo/[a-z-]*' dist/*.js` empty, `fallow:ci` and `fallow:kg` — every exit 0. The full suite was deliberately **not** run in this commit; the independent verifier runs it once, alone, afterwards.

L14 (corrective for the `@repo/wiki` relocation: the residue the relocation left behind).

**The verifier's verdict, quoted as the reason this commit exists.** The delivery of `61cee9c` +
`8d3d4a4` is **not green**: the full suite is RED and an existing command still points at the deleted
`src/`. Both are the same class — a path literal whose target moved — and both survived every fast
gate. Six gates were green (`tsc`, both typechecks, `lint` at 643/466/496, `build`, `fallow:ci`,
`fallow:kg`) while the tree was broken.

**Blocker 1 — `test/test-partition.test.ts` was inherited green and shipped red.** `git diff --stat
ca075d41..HEAD -- test/test-partition.test.ts` is **empty**: the relocation did not touch the file,
and the file names `src` in the oracle it builds to check the classifier. Observed red, verbatim:
`Error: ENOENT: no such file or directory, scandir '…/src'` at `test/test-partition.test.ts:54:7`.
The same literal existed in `scripts/test-partition.ts`'s `TEST_ROOTS`, where `collectTestFiles`
guards every root with `existsSync` — so **one literal produced two opposite failures at once**: loud
in the test, whose oracle walks each root unguarded, and *silent* in the product, whose tier then
reported success over a tree it never read. `test/test-partition-coverage.test.ts` could not catch it
either, and that is worth stating: it compares file SETS found by two independent walks, and a
phantom root contributes no files, so set equality holds while the root itself is the defect.
`TEST_ROOTS` is now `["test","packages","scripts"]`, and the durable pin is
`test-partition.test.ts` → `classifyTests > names only roots that exist on disk`, which reads
`TEST_ROOTS` from the implementation and fails with `suite roots absent from the tree: src`.
**The verifier's proposed pin was adapted, and the reason matters:** its literal
`["test","packages","src","scripts"]` list can never pass on the repaired tree, because the whole
point of the fix is that `src` must NOT exist — it would ship a permanently red assertion. Reading
the constant is the version that is red before the fix and green after, so that is what shipped.

**Blocker 2 — `scripts/vendor-fonts.mjs:21` wrote into the deleted directory.**
`path.join(projectRoot, "src/viewer/assets/fonts")` plus `mkdir(..., {recursive:true})` meant
`pnpm run vendor:fonts` **succeeded** while writing where the build never reads. The live bundle is
`packages/wiki/src/viewer/assets/fonts` — 13 woff2, confirmed present in `dist/viewer/assets/fonts`
by the build of this commit. Retargeted, and pinned by the new
`test/vendor-fonts-target.test.ts`, which reads the script text plus both existence facts instead of
running it: a pin that mutates the checkout to prove a path is not a pin a fast gate can run. The
script was **not executed** in this commit, on purpose.

**Advisory 1 — `scripts/test-typecheck-program.ts` silently narrowed.** `listCheckedSources` walked
`["src","test"]` with a per-name `existsSync` guard, so after the move the independent on-disk
cross-check against `tsconfig.test.json` covered `test/` alone **while the gate stayed green**. That
is the worst shape in this document's running list: a check that still runs, still passes, and now
reads less. It is `["packages/wiki/src","test"]`, and the measured proof that the repaired oracle
covers the moved tree is `typecheck:tests` reporting **1770 files checked; 260 baseline diagnostics
in 94 files; no regression** — unchanged counts, because the program never changed; only the
completeness check did. `test-typecheck-baseline.json` was therefore **not touched**. Pinned by the
new `test/wiring-src-literals.test.ts`.

**Advisory 2 and the `drizzle-orm` gap.** `packages/wiki/src` imports `drizzle-orm` **23 times across
26 files** and `packages/wiki/package.json` did not declare it; it resolved only because
`nodeLinker: hoisted` leaks the root copy. Declared at the root manifest's exact range `^0.45.4`,
whose resolution `0.45.4(postgres@3.4.9)` already pre-existed in `snapshots` — so the lockfile edge
is **3 added lines and zero version movement**, the same property `test/declared-dependencies-wiring.test.ts`
pins for the earlier declarations. Two further undeclared imports of the same shape exist in that
tree and are **reported, not added**: `@repo/kg`, **13 imports in 10 files**, which is the *forbidden*
`wiki → kg` edge and declaring it would be blessing a boundary violation the lint ratchet counts as
inherited debt; and `vitest`, **2 imports in the package's own 2 test files**, a test-only specifier
whose owner is the root devDependency list, not a runtime manifest.

**The three durable pins, and what each is worth.** `test-partition.test.ts`'s root-existence pin
(a root the tree does not have fails by name); `test/vendor-fonts-target.test.ts` (the vendor target
is literally the directory that exists and that the build copies); `test/wiring-src-literals.test.ts`
(the typecheck oracle's literals still name every checked source tree). Each was written first and
observed red before its fix: `suite roots absent from the tree: src`, `expected '…' to contain
'path.join(projectRoot, "packages/wiki/…'`, `expected '…' to contain '["packages/wiki/src", "test"]'`.

**Class-wide sweep, every surviving root-`src` assumption with its disposition.** Fixed: the three
above. Dead-but-harmless, left with reason: `scripts/build-stamp.ts` `INPUT_DIRS = ["src","packages","scripts"]`
— the verifier's reading is correct and confirmed here, `hashDir` swallows ENOENT so the dead entry
contributes nothing while `packages` still feeds the hash, and three pinned tests in
`test/build-stamp.test.ts` depend on the current entry list; `scripts/test-partition.ts` and
`test/test-partition.test.ts`'s `^(test|packages|src|scripts)\/` allowlist patterns (a prefix that
cannot occur is not a hole, and `test/test-partition-cli.test.ts` carries the same pattern outside
this commit's enumeration); `eslint.config.mjs` `TYPESCRIPT_FILES`'s `api/**/*.ts`, since
`packages/**/*.ts` already reaches that tree — it belongs to the next commit that touches that file.
Prose only, left: `.github/workflows/ci.yml:21,77,85`, `Dockerfile:9` (its `COPY` line 98 is already
`packages/wiki/src`), `scripts/kg-typecheck.ts:8`, `scripts/lint-ratchet.ts:238`,
`scripts/test-keyless.sh:7`, and the JSDoc module paths throughout `test/**`, which name logical
modules rather than resolving anything. False positives, verified self-contained:
`test/build-stamp.test.ts` and `test/test-affected-scope.test.ts` seed a scratch `src/` inside their
own `mkdtemp` roots; `test/fixtures/test-typecheck-project.ts` writes a synthetic project whose
`include` is its own `src/`; `test/citation-normalize.test.ts`, `claim-provenance*`,
`source-projection` and the wiki/dimensions row suites use `src.md` and `src://` as *source identities*,
not paths. One finding this commit could NOT close because `test/fixtures/` is outside its allowed
edit surfaces: **`test/fixtures/src-tree.ts` exports `SRC_DIR = …/../../src`**, a real path walker
aimed at the deleted directory. It is dead code — `git grep src-tree` finds only the file itself —
so nothing fails today, which is exactly the shape L13 recorded for `core-tree-fingerprint.ts`: a
false green waiting to be wired, not a live one. It needs its own commit.

**The sentence that outlives this commit.** The fast gates are structurally blind to "a test walks a
directory that moved": `tsc` type-checks the import graph, `lint` reads file globs, `build` copies
what its config enumerates, and `fallow` attributes by path — none of them *executes* a walk, and the
classifier's own `existsSync` guard converts the one place that would complain into silence. Only the
full suite covers it, which is why the delivery shipped red behind six green gates, and why the
verifier ran it once, alone, after the commit.

**Gates of record for this commit.** `tsc --noEmit` 0; `typecheck:tests` 0 (1770 files, 260/94
baseline, no regression); `typecheck:kg` 0 (357 files); `lint` 0 at the literal triple
**643 / 466 / 496**; `build` 0; `node dist/cli.js --version` → `1.4.0-dev.20260919` exit 0;
`grep -o '@repo/[a-z-]*' dist/*.js` empty; `fallow:ci` 0 (0 dead-code, 0 complexity, 0 duplication
introduced); `fallow:kg` 0; and the three new/touched test files 22/22 green together with
`test-partition-coverage.test.ts`. The full suite was deliberately **not** run here — the independent
verifier runs it once, alone, after this commit.

L15 (closing record for the `@repo/wiki` slice: the verifier's failure classes turned into durable probes,
and the arithmetic repaired).

**Why this entry exists.** Independent verification certified the delivery GREEN and then found that this
document could not be used to reconstruct it: `d3fb36ceb8d0eed13109b1816115a84bdf7eee05` and
`3a0c70d9da1c8f82c08723478763975a4367a56e` — the two commits that closed L14's blockers — appeared
**nowhere** as SHAs, and both `S3`'s and `S6`'s cells referred to a third commit only as "the commit
carrying L13". All three are now in `## Tasks` as full 40-character SHAs, appended to the existing cell
text, with nothing deleted. A reader following the cells can now walk the slice commit by commit.

**The gate of record, certified by the verifier on this tree.** `pnpm test` exit **0** — **6,861 passed /
7 skipped**, **480 s**, with the database-backed suites RUNNING (no `LLMWIKI_TEST_ALLOW_NO_DATABASE`), which
is the only tier that proves the `apply-schemas.sh` dual contract L13 recorded. This closing commit does
**not** repeat that run, and the omission is deliberate rather than an oversight: what it changes is three
new test files plus this markdown append, so a second 480-second run would re-prove the same tree at the
price of the whole tier. The probes' own gates are listed at the end of this entry.

**The final arithmetic, superseding L13's wider range.** **560 renames, 0 deletions**; **2,694 added /
2,269 deleted** authored lines against **101,202** relocated lines = **37.6:1**. L13 recorded 2,417 /
2,242 / ≈42:1, and that figure was **correct for its own narrower range** — it predated the final fixtures
and both residue repairs. The order of magnitude is unchanged; what was wrong was the brief's assumption
of three orders, never L13's measurement of the range it actually covered.

**The census, re-derived through the ratchet's own collector in this commit.** **79 sites / 41 files** —
`no-restricted-imports` **43 sites / 31 files** plus `local/dimension-boundary` **30 literal / 11 files**
and **6 non-literal / 1 file** — with **`kg → wiki` = 0** and **`wiki|kg → api` = 0**. The whole house
violation set the same collector returns is 643 sites / 466 files / 1838 files scanned, which is exactly
the literal lint triple below: the probes added **0** boundary sites, so the freeze and the reach agree.

**P1 — `test/gate-zone-paths-exist.test.ts`: a zone that names a directory the tree does not have.** The
config is **parsed**, not regex-scanned, because its own comments quote the pre-move spelling
(`tree("api/")`) while explaining the repair — a text scan would fail on the explanation. Every
`tree("<path>")` literal is extracted with its owning constant and resolved against the tree, and a second
case pins that `WIKI_ZONE`, `KG_ZONE` and `API_ZONE` were all read, so the extraction cannot pass
vacuously. RED, proved by temporarily restoring the pre-`8d3d4a4` spelling (the parent's method):
`zone API_ZONE = tree("api/") names a directory the tree does not have`, reverted with
`git status --short eslint.config.mjs` empty. GREEN after the revert, 2/2.

**P2 — `test/build-stamp-source-coverage.test.ts`: a cache that silently stops watching the moved tree.**
`INPUT_DIRS` is read out of the script's own source and at least one entry must exist AND hold a `.ts` file
anywhere below it. It asserts **coverage**, not the absence of the deliberate dead `"src"` entry, which is
documented in the file and which `test/build-stamp.test.ts` depends on for its scratch fixture. RED,
proved by temporarily narrowing the list to the dead root alone (`INPUT_DIRS = ["src"]`):
`INPUT_DIRS covers no directory holding .ts files: src`, reverted with `git status --short
scripts/build-stamp.ts` empty. GREEN after the revert, 2/2, plus a permanent synthetic case over an
`mkdtemp` tree holding no sources.

**P3 — `test/no-executable-root-src-walks.test.ts`: the class that shipped two defects past six green
gates.** The scanned estate is `scripts/**/*.{ts,js,mjs}` and `test/fixtures/*.ts`; violations fail as
`path:line: stale root src walk`. Two shapes count, and the second is why the allowlist names
`scripts/build-stamp.ts:47`: a filesystem call whose first string argument names root `src`, and a
**walk-root list** — a `*_DIRS`/`*_ROOTS` array literal a walker iterates — naming one. The parent brief
specified only the call shape, under which that line is **not** an argument (`INPUT_DIRS` reaches
`readdirSync` two hops later through `hashDir`), and the allowance it names would then have been dead
weight documenting a site nothing could ever report. RED was therefore observed on the real tree by
running the probe **before** setting its allowlist: `scripts/build-stamp.ts:47: stale root src walk`, one
violation, GREEN after the entry and its reason landed, 2/2 + a synthetic case proving the detector fires.
The relative-walk spelling (`"../../src"`, the shape `test/fixtures/src-tree.ts` carried before
`3a0c70d9`) is **not** in either shape and stays uncovered, stated here so nobody reads this probe as
total.

**Two advisories left open, and neither is closed by this commit.** (1) `AGENTS.md:93,95,104,124` still
carries stale prose about a root `src/` — `test:unit` covering `src/`, the build stamp hashing the `src/`
tree, and the lint ratchet naming `src/` ↔ `packages/llmwiki-kg` — all of which stopped being true at
`61cee9c`. It was **undisclosed until now**: L14 listed the surviving prose as
`.github/workflows/ci.yml`, `Dockerfile`, `scripts/kg-typecheck.ts`, `scripts/lint-ratchet.ts` and
`scripts/test-keyless.sh`, and `AGENTS.md` was not on that list. It is outside this slice's edit surfaces
and is recorded, not fixed. (2) `test/` was **not** relocated: only its import specifiers were rewritten,
so this document's `S5` remains `pending` and no `## Tasks` cell moves for it.

**This commit's SHA is a placeholder in this entry — `<recorded when read back>`. History rewriting is
prohibited, so `--amend` was not used to fill it; the parent's record sweep reads it from the branch.**

**Gates of record for this commit.** `tsc --noEmit` 0; `typecheck:tests` 0 — **1774 files checked; 260
baseline diagnostics in 94 files; no regression**, so `test-typecheck-baseline.json` was **not touched**
(the three new files added 4 files to the checked set and 0 diagnostics); `lint` 0 at the literal triple
**643 / 466 / 496** with **1838 files scanned** (the rise is the three new files, the triple is
unchanged); `fallow:ci` 0 — 0 dead-code, 0 complexity, 0 duplication introduced; `build` 0;
`node dist/cli.js --version` → `1.4.0-dev.20260919` exit 0; `grep -o '@repo/[a-z-]*' dist/*.js` empty;
and the three new probes 6/6 green together.

### L16 — S4b: the composition root moves to `@repo/api` (Manager ruling, A)

Design obstacle found before any write: `eslint.config.mjs` composes `WIKI_BOUNDARY = [...WIKI_TO_KG.patterns, ...WIKI_TO_API.patterns]` over `WIKI_SIDE = [...WIKI_ZONE, ...tree("test/"), ...tree("scripts/")]`, so no file under `packages/wiki/**`, `test/**` or `scripts/**` may name `@repo/api`. The authorised construction sites (`packages/wiki/src/cli.ts`, `packages/wiki/src/index.ts`, `packages/wiki/src/commands/host.ts`, a vitest setup file) were therefore each a forbidden `wiki → api` site, and "wiki → @repo/api = 0 with a falling census" was unsatisfiable as written. Reported with the gate text and the call graph before writing.

Ruling (A):
- The composition root moves into `@repo/api`: `git mv` of `cli.ts`, `index.ts`, `commands/host.ts`, `host/server.ts`; re-point both tsup entries, root `bin`/`main`, the `llm-wiki-compiler` path alias and the matching vitest alias. `api → wiki` and `api → kg` become exercised, which is the first live proof of S2.
- `wiki → api` narrows to the production zones (`packages/wiki/**`, `scripts/**`); `wiki → kg` keeps the full `WIKI_SIDE` width, so all 79 sites stay counted and the narrowing cannot manufacture the census drop.
- The allowance is counted: a durable pin names the test-side `@repo/api` files and their exact count, and fails when that set grows or shrinks without the pin being updated. Follow-up when the test estate relocates: the pin goes to 0 and the narrowing is removed.
- `activation.ts` splits rather than moves. Its configuration vocabulary stays wiki-side — `createDimensionsDatabase` (11 wiki importers), `AKS_STACK_ID_ENV_VAR` (10), `AKS_DATABASE_URL_ENV_VAR` (2), `DIMENSIONS_ENV_VAR`, `resolveStackId`, `DimensionsDatabase` — because a wholesale move would invert 15 intra-wiki imports into forbidden edges. Only the kg construction moves, behind the port.
- No test constructs the port unless its assertion cannot be expressed otherwise; each such edit is named with its reason.
- Census prediction corrected from 62/35 to **63/36** (static 33): `createDimensionsDatabase` keeps `activation.ts` at one `@repo/kg` static site because it builds the handle with the KG package's client factory and 11 wiki files call it.

Subtasks: W1 foundation `DimensionsPort` + `MissingDimensionsPortError`; W2 `activation.ts` split, `dimensions/kg/**` → api, port implemented in api; W3 composition root → api, eslint narrowing, counted pin, threading through compile/ingest/host/MCP; W4 delete `utils/stack-id.ts`; W5 gates, artifact proof, full suite, independent verification.

### L17 — S4b handed back: the removal slice is a prerequisite, not a parallel task

The composition root of the shipped container is the CLI, so the port's construction site cannot exist in production until the CLI's replacement entry lives in `@repo/api`.

Measured, not assumed. `docker/entry.sh:64` is `set -- node /app/dist/cli.js host --port "$port"`, `docker/entry.sh:84` is `exec node /app/dist/cli.js serve`, and `docker-compose.yml:104` / `docker-compose.hub.yml:79` set `LLMWIKI_DIMENSIONS: wiki,kg`. `packages/wiki/src/cli.ts` reaches the host through `@atomicstrata/llmwiki-core/compiler-cli` → `packages/wiki/src/compiler-cli.ts:44` (`export { default as hostCommand } from "./commands/host.js"`) → `packages/wiki/src/commands/host.ts:28` (`import { startHost } from "../host/server.js"`).

Consequence, and the reason this slice stops here: with `cli.ts` frozen, the only legal composition root is inside the wiki package, which may not name `@repo/api`. So the port has no production construction site, and the loud-failure rule this slice exists to install would fire inside the shipped image — `MissingDimensionsPortError` on `host`, the `kg` dimension unusable in the product, every gate green. A silent fallback would be worse. Both were refused.

Order of work is therefore: the CLI-removal slice first (it recreates the `host` and `serve` entries in `@repo/api`, re-points `docker/entry.sh`, and drops `compiler-cli.ts`'s `hostCommand` re-export, which is what frees the composition root); then the inversion resumes with the S4b ruling holding verbatim.

Landed from this attempt and independent of the blocked move: the `DimensionsPort` seam at the bottom layer (`DimensionsRequest`, `DimensionsPort<TDimension>`, `MissingDimensionsPortError`, `requireDimensionsPort`, with in-package tests), and the deletion of `packages/wiki/src/utils/stack-id.ts` with its single importer re-pointed at `@repo/foundation`.

The rule the inversion installs when it resumes is keyed on file kind, not on directory: `wiki → api` is forbidden in production (`packages/wiki/src/**` excluding `*.test.ts`, plus `scripts/**`) and counted rather than forbidden in tests (`test/**` plus `packages/wiki/src/**/*.test.ts`). A directory-based rule would let a colocated test count as production while an identical test under `test/` counted as debt — same code, same treatment. `wiki → kg` stays at the full `WIKI_SIDE` width in both cases, so the 79-site census is unaffected by the narrowing.

### L18 — S4b: DimensionsPort gets its first real consumer (inversion)
Base `e34ad5988a58ac600634a42593aaef3141553033`. Predecessor: L16 (S4b plan, ruling A) and L17 (handed back pending the removal slice). The prerequisite is gone: the container launcher is `node /app/dist/api.js host|serve` (`docker/entry.sh:64,66,84`), so a non-CLI executable exists in `dist/` at last.

#### Specs
L18.S1. The port implementation lives in `@repo/api` — the only package permitted to join `wiki` and `kg`. (`packages/api/src/host/server.ts` already imports `@repo/kg/server`; `packages/api/package.json` declares `@repo/foundation` as a devDependency.)
L18.S2. `@repo/wiki` must receive the port as an explicit option, typed against foundation's interface. `git grep "@repo/api" -- packages/wiki/src/` must stay empty, verified including `--untracked`.
L18.S3. `MissingDimensionsPortError` must fire at construction, loudly, when a caller that needs dimensions does not get a port.
L18.S4. The ambient `LLMWIKI_DIMENSIONS` read is what gets replaced; decide where the variable is read now and do not leave two readers of the same variable. `docker-compose*.yml` still sets `LLMWIKI_DIMENSIONS: wiki,kg`.
L18.S5. In scope, this slice only: the tests that set `LLMWIKI_DIMENSIONS=kg` (re-derived: 3 sites in one test file) and `test/fixtures/env-stack.ts`. They may be edited here and nowhere else.
L18.S6. No ambient `LLMWIKI_DIMENSIONS` read remains on the host/MCP ingest path; the SDK facade and the compile-retirement path keep internal resolution as named gaps.
L18.S7. A caller without a port fails with `MissingDimensionsPortError` — proven by EXECUTING it, not by reading the code.
L18.S8. The image still starts in both modes, proven inside the built image: `host` → `/health` 200 and `/` 200; `serve` → stdio `initialize` returning `serverInfo.name: "llmwiki"`, exit 0. `docker build` green, and the runtime image still contains `dist/api.js`, the 48 viewer assets, both dimension trees and the 6 KG `.sql` files.
L18.S9. The `kg`-dimension tests still run and still assert something; if a test can no longer mean anything, say why it died rather than deleting it quietly.

#### Re-derived census (base e34ad598; verify each before relying on it — every prior census in this feature was stale)
- Foundation port, zero consumers today: `packages/foundation/src/dimensions-port.ts` — `DimensionsRequest { only: readonly string[]; env: NodeJS.ProcessEnv }`, `DimensionsPort<TDimension> { resolve(request): readonly TDimension[] }`, `MissingDimensionsPortError`, `requireDimensionsPort`. Exported from `packages/foundation/src/index.ts`. `git grep` outside `packages/foundation/` for those four names: ZERO, including `--untracked`.
- Resolution today: `packages/wiki/src/dimensions/activation.ts` → `resolveDimensions({root, db, env, only?, stackId?, kgDryRun?})`, reading `env[LLMWIKI_DIMENSIONS]` via `parseNames`; `DIMENSIONS_ENV_VAR = "LLMWIKI_DIMENSIONS"` is defined there. Handle factory `createDimensionsDatabase(env)` is also there.
- Call site 1: `packages/wiki/src/services/ingest/service.ts` — `writeToDimensions` builds `createDimensionsDatabase(env)` itself, resolves the Stack via `resolveStackForCommand`, then `resolveDimensions({root, db, env, stackId})`.
- Call site 2: `packages/wiki/src/compiler/index.ts` — `graphRetirementDimensions(root, db, env)` runs `resolveStackForDimensions(db, env, RETIREMENT_DIMENSIONS)` as a DB-touching pre-check, returns `[]` when it yields `undefined`, else `resolveDimensions({..., only: RETIREMENT_DIMENSIONS, stackId})`. Called from `forgetDeletedSources`.
- `DimensionsPort.resolve` as specified carries only `{only, env}`: it cannot receive `root`, the DB handle, or the Stack the pre-check resolved. That gap is the open architectural question (see Tasks T2).
- Subpath exports that matter: `@repo/wiki/dimensions-activation`, `@repo/wiki/ingest-service`, `@repo/wiki/compiler` exist; `@repo/api` exports only `.` → `./src/index.ts`; `@repo/foundation` exports `.` and `./stack-id`.

#### Tasks
L18.T1 — Port implementation in `@repo/api`, typed against foundation's `DimensionsPort<Dimension>`, delegating resolution to wiki's machinery. New files only; no wiki call-site change yet. (L18.S1, L18.S2)
L18.T2 — Decide and document the interface gap: `resolve({only, env})` cannot carry `root`, `db` or the pre-resolved `stackId` that `graphRetirementDimensions` depends on, and the Stack pre-check is async and DB-touching. Either capture at construction or correct `DimensionsRequest` — if foundation's shape changes, report the correction and reason, and note Risk item 3. (L18.S2, L18.S4)
L18.T3 — Thread the port through the api-owned ingest callers only: `packages/api/src/host/api.ts`, `packages/wiki/src/mcp/tools.ts`, `packages/wiki/src/services/ingest/jobs/run.ts`, and `writeToDimensions`. The port is REQUIRED at those entry points. The shared function's port is OPTIONAL and its omission is VALID — absent means "resolve internally", never "throw"; the code comment must say which. `sdk/core.ts` (and `commands/ingest.ts` only if step 0 proves it still exists) keeps internal resolution as a named gap. (L18.S1, L18.S4, L18.S6)
L18.T4 — Loud failure: prove by execution that a caller without a port raises `MissingDimensionsPortError` (RED observed before the fix), and that rejected input leaves stored rows and counters unchanged. (L18.S3, L18.S7)
L18.T5 — Container proof inside the built image, both modes, plus the asset-presence assertion (`dist/api.js`, 48 viewer assets, both dimension trees, 6 KG `.sql`). (L18.S8)
L18.T6 — Full gate set + the `kg`-dimension test disposition. (L18.S9)
L18.T7 — Prove the port is USED, not merely accepted: a fake port whose `resolve` records its calls, driven through the api ingest path, asserting the call happened AND the request it received (root, db, env, only, stackId). A threaded-but-never-invoked port is the decorative consumer this slice exists to disprove; the loud-failure proof alone cannot catch it. (L18.S6, L18.S7)
L18.T8 — eslint boundary narrowing + derived pin, IN THE SAME COMMIT: `wiki → api` narrows to the production zones (`packages/wiki/**` excluding `*.test.ts`, plus `scripts/**`); the test side is permitted with a DERIVED pin that names the `@repo/api`-importing test files and its exact count (a list plus count, not an editable number). Narrowing and pin must land together or the lint ratchet fails on the very violation the narrowing permits. Production-side zero proven with `git grep "@repo/api" -- packages/wiki/src/ --untracked`. (L18.S2)

#### Log
L1 (verbatim, Manager brief): "S4b: give `DimensionsPort` its first real consumer and invert the pipeline. This was blocked for a week on CLI removal — the container's only launcher had no non-CLI executable in `dist/`, so the port's construction site could not exist in production. **That blocker is gone as of `e34ad598`**, and the container entry now lives in `@repo/api` (`docker/entry.sh:64,66` → `node /app/dist/api.js host --port …`, `:84` → `exec node /app/dist/api.js serve`)."
L2 (baseline measured at HEAD `e34ad598` before any write): `gates:static` exit 0, all six passed in 21.8 s; lint prints literally "566 baseline violations in 402 files across 429 rule/file entries"; `tsc --noEmit` 0; `typecheck:kg` 357 files, no regression; `dist/` ABSENT and nothing tracked under it; docker 29.7.2 reachable; KG package holds 6 `.sql`; tracked files 1953; `*.test.ts` = 800 (the brief said 799 — stale).
L3 (census corrections, base `e34ad598`): the brief's "3 tests that set `LLMWIKI_DIMENSIONS=kg`" are 3 sites in ONE test file, not three files; the brief's `compiler/index.ts:1411` is the `resolveDimensions` return inside `graphRetirementDimensions`, not the function head. Every line number in this entry is a lead, not authority — re-verify before editing.
L4 (open decision, escalated to Manager): S5's test-edit fence conflicts with S6+S3. A required port on `writeToDimensions` reaches `ingestSource`/`ingestTextSource`, and `ingestTextSource(root, input)` has no options object and is called directly by `test/commands/ingest-text.test.ts`, `test/commands/ingest-status.test.ts`, `test/commands/ingest-lock.test.ts`, `test/sdk/facade.test.ts`, `test/quickstart-shared-steps.test.ts`, `test/services/ingest/default-stack-ingest.test.ts`, `test/mcp/ingest-root.test.ts`. Every ingest writes the `wiki` dimension, so a loud refusal fails all of them. Resolution pending; T3 is blocked on it.
L5 (Manager ruling, verbatim): "(Y), with three conditions that keep it honest". The api-owned ingest callers get a REQUIRED port and `MissingDimensionsPortError` fires at construction there; the shared function's port is OPTIONAL with a VALID omission ("resolve internally", never "throw"), and the code comment must say which; and the port must be proven USED by a recording fake driven through the api ingest path, because a threaded-but-never-invoked port is the decorative consumer this slice exists to disprove.
L6 (why (X) cannot ship — recorded because it reclassifies a follow-up): `CreateWikiOptions.dimensionsPort` REQUIRED would put a `@repo/foundation` type in the published `.d.ts`, and `@repo/foundation` is `"private": true` and absent from `publish.yml:71 PACKAGE_DIRS: "packages/llmwiki-core ."`. An external embedder would receive a required field whose interface they cannot import, with no factory to obtain an implementation (the only one lives in `@repo/api`, also unpublished). (X) does not make `createWiki` breaking, it makes it uncallable by its audience — strictly worse than a gap.
L7 (three gaps queued, not one — each named with its size so none can become "later"): (1) `feature/compile-port-threading` — `CompileOptions` + 15 test files + 5 production files + the `compileAndReport` call sites. (2) `feature/published-entry-port` — the 22-file published-entry move, now recorded as the PRECONDITION of any required port for `createWiki`, because it must publish foundation's type and a port factory before such a field can exist; it is no longer a "nice follow-up". (3) The SDK facade's internal resolution until both land.
L8 (evidence that a green build is not proof): retargeting `tsup.config.ts:26` at a file with no exports builds EXIT 0 and produces a 33-byte `dist/index.js` with `createWiki` undefined; only `test/artifact/entries-load.test.ts:224` catches it ("expected 'undefined' to be 'function'"). A green build producing a 33-byte library is the false-green class this feature must keep naming.
