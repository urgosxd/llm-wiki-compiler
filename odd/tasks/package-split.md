# Feature: package-split

The authorized monorepo split of llm-wiki-compiler: four packages — `@repo/wiki`, `@repo/kg`,
`@repo/api` and a bottom `@repo/foundation` — carved behind a boundary gate that can actually see
the boundary. Status: slice **S0** (widen the dimension boundary gate) is specified and is the
first write of this feature; **S1–S6** are planned and unstarted.

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

S1 — Create `@repo/foundation` and relocate the dimension-agnostic shared modules into it with `git mv`. — specs: S1, S2, S3, S6 — commit: pending

S2 — Carve `@repo/kg` from `packages/llmwiki-kg`, landing `ontology-store.ts` and `embedding-model-bridge.test.ts` there per D1. — specs: S1, S2, S3, S4, S6 — commit: pending

S3 — Carve `@repo/wiki` from `src/dimensions/wiki`. — specs: S1, S2, S3, S6 — commit: pending

S4 — Carve `@repo/api`, absorbing `src/dimensions/kg` per D1. — specs: S1, S2, S3, S4, S6 — commit: pending

S5 — Place unit tests in their owning package, module integration in-package with Testcontainers, cross-module integration in `@repo/api`. — specs: S5 — commit: pending

S6 — Re-point the boundary gate at package names, verify the allowed edges `api → wiki`, `api → kg`, `{wiki,kg,api} → foundation` and that `wiki ↔ kg` is rejected both ways, and bring all gates green. — specs: S2, S3 — commit: pending

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
