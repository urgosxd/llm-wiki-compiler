# Published entry composition — the SDK ingest seam

Branch `feature/published-entry-composition`. Base `0aa749384af3b40aeea5706c0d2aaffd824b7590`. This slice closes the SDK ingest path's dimension seam. It does **not** move the published entry; that is recorded as `feature/published-entry-port`, an ergonomics-after-a-release change, never a capability.

## Specs

Spec IDs are `S1`–`S11`; task IDs are `T0`–`T6` plus `T2b`. Lines marked `Consequence:` are derived, not quoted.

S1. ENV IS HONOURED ON THE SDK INGEST PATH. Manager ruling, verbatim: "**FOLD IN, as its own commit, RED first**" and "`sdk/core.ts:84` passing neither `port` **nor** `env` is not a gap to record — it is a **multi-tenant data bug already in the shipped product**." Proven by "a RED test first that an embedder passing `env` for stack B lands its rows on B and not on A." Changelog: "Mark it in the CHANGELOG as a **fix**, not a breaking change — but say plainly in the body that row placement changes for embedders who were passing `env`".

Consequence: category Risk item 1 (wrong-tenant writes to stored data), not item 3.

S2. THE PUBLISHED PORT TYPE IS SELF-CONTAINED. Manager ruling, verbatim: "Declare a self-contained `DimensionsPort`/`DimensionsRequest` beside `core-types.ts`, name it from the optional `CreateWikiOptions.dimensionsPort`, and assert **mutual assignability** with foundation's interface so drift is a `tsc` failure."

Consequence: `@repo/foundation` is `private: true` and absent from `publish.yml` `PACKAGE_DIRS: "packages/llmwiki-core ."`, so naming its type in the published `compiler-sdk.d.ts` would hand embedders a specifier they can never import.

S3. THE FIELD IS OPTIONAL AND OMITTING IT IS VALID. Manager ruling, verbatim: "the field stays **optional and omitting it is valid**".

Consequence: omission means the composed default or the ambient fallback, never a throw.

S4. THE ASSIGNABILITY GUARD IS PROVEN TO BITE. Manager ruling, verbatim: "the assignability guard must be **proven to bite** — inverse-edit one side of the shape, observe RED, restore, observe GREEN. A drift test nobody has seen fail is a comment with syntax."

S5. INGEST-TEXT TAKES THE PORT. Manager ruling, verbatim: "`ingestTextSource:303` gets the `port?` that `ingestSource:241` already takes."

S6. PORT THREADING RIDES WITH THE PUBLISHED TYPE. Manager ruling, verbatim: "Port threading in `core.ts:84/:86` rides with the published-type commit, since the type exists to carry the port. `env` rides alone."

S7. THE SUPPLIED PORT IS PROVEN CALLED. Manager ruling, verbatim: "The `typeof createWiki === "function"` plus recording-fake proof stays the fast deterministic layer."

Consequence: a port accepted and never invoked is the decorative consumer this chain exists to disprove; the recording fake asserts both the call and the request it received.

S8. `MissingDimensionsPortError` IS PROVEN AT THE INTERNAL SEAM AND DECLARED PUBLICLY UNREACHABLE. Manager ruling, verbatim: "If the composing entry supplies the default, no public path can omit it, so `MissingDimensionsPortError` is **unreachable from the published surface by design**. Prove it at the internal seam, executed, and state plainly that the public default makes it unreachable. Do not dress an internal proof as a public one".

S9. PACKED-ARTEFACT PROOF, EACH IN ITS TIER. Manager ruling, verbatim: "`test:pack` stays **DB-free**; do not make it network-dependent. The DB-backed packed-artefact ingest goes in the artefact/integration tier, and if the database is unavailable it **skips loudly with its reason**, not silently".

S10. THE ENTRY MOVE IS RECORDED, NOT CARRIED. Manager ruling, verbatim: "A composing entry that passes a port the shipped core drops on the floor *is* the decorative consumer. The entry move is recorded as ergonomics-after-a-release, never as capability."

Consequence: `feature/published-entry-port` must record what it has to do, the coordinated `packages/llmwiki-core` → `.` release with `publish.yml` `PACKAGE_DIRS` ordering, that a required port on `CreateWikiOptions` stays blocked until publication exists, and that it buys embedder ergonomics rather than capability.

S11. THE ARTEFACT TIER'S LIMIT IS WRITTEN DOWN. Manager ruling, verbatim: "the root `dist/index.js` is 108 KB and does not contain the engine, so `test/artifact/entries-load.test.ts`'s in-process proof of the published entry has never been proving what it appears to prove about the engine — it proves the façade exports."

## Tasks

T0 · S10-S11 · route: worker · this document · commit: fcfcc15bac6bb0e743152a6205141bec465a9a59
T1 · S2-S4 · route: worker · self-contained published `DimensionsPort`/`DimensionsRequest` beside `core-types.ts`, the optional `CreateWikiOptions.dimensionsPort`, and the mutual-assignability guard proven to bite · commit: 9122cffc1ec1e2d03d1aca7272d07e3c75fafe83
T2 · S5-S7 · route: worker · port threading in `core.ts:84/:86` and the `port?` on `ingestTextSource:303` · commit: <pending>
T2b · S1 · route: worker · `env` forwarding in `core.ts:84/:86`, RED FIRST, own commit so the behaviour change is revertable alone · commit: 3089859777e68324385c948af3797a134d4b1b67
T3 · S7-S8 · route: worker · recording fake proving the port is CALLED, plus `MissingDimensionsPortError` at the internal seam · commit: <pending>
T4 · S9 · route: worker · packed-artefact proof, each tier in its proper place · commit: <pending>
T5 · S11 · route: worker · artefact-tier note recording the façade-only limit · commit: <pending>
T6 · all · route: verify · gates, `pnpm test` in full and alone, container both modes · commit: <pending>

## Log

L1 (Manager, verbatim): "Move the published library entry to a layer that can actually compose, and close the SDK's ambient dimension resolution without a breaking change. This is the S6 core slice, and it is the **precondition** recorded by S4b for any required `DimensionsPort`." — followed by the defect report (`tsup.config.ts:26` builds `dist/index.js` from `packages/wiki/src/index.ts`), the four numbered targets, the six acceptance items, the gate list, the hard prohibitions, and the required report contents.

L2 (census, re-derived at `0aa74938`, every figure from the tree and not from the brief): lint ratchet literal triple **566 / 402 / 429**, 1630 files scanned, zero headroom; `git ls-files '*.test.ts'` = **803** (the brief said 799, earlier records said 800); tracked files **1957**; `tsup.config.ts:26` `entry: ["packages/wiki/src/index.ts"]` confirmed; `packages/wiki/package.json` `private: true`, **22** subpath exports, no `"."`, confirmed; AC6 baseline `git grep '@repo/api' -- packages/wiki/src/ --untracked` empty.

L3 (the finding that reorders this slice — measured, not inferred). `dist/index.js` at `0aa74938` is **108,001 B / 3061 lines** and contains `sdk/core.ts` **0**, `services/ingest` **0**, `resolveDimensions` **0**, `LLMWIKI_DIMENSIONS` **0**. The engine lives in `packages/llmwiki-core/dist/chunk-SIHJYM7U.js` (**848,656 B**): `resolveDimensions` ×3, `LLMWIKI_DIMENSIONS` ×1, `ingestSource` ×2, and its source map names `packages/wiki/src/services/ingest/service.ts`, `dimensions/activation.ts`, `dimensions/kg/index.ts`. `packages/wiki/src/sdk/wiki.ts:7` imports `createWikiCoreAtRoot` from the externalized `@atomicstrata/llmwiki-core/compiler-sdk` (`tsup.config.ts:17`), and `packages/llmwiki-core` has no `src/` — its `tsup.config.ts:8-12` compiles `../../packages/wiki/src/core-index.ts` and `../../packages/wiki/src/sdk/compiler-composition.ts`. Therefore a composing root entry that passes a port would have the shipped core drop it, which is the decorative consumer this feature exists to disprove. The entry move is not a precondition for the port; it is ergonomics after a coordinated two-package release.

L4 (the seam that already landed, and the three real holes). `packages/wiki/src/services/ingest/service.ts:207` is the ambient fallback and `:208` is `port.resolve({ only: INGEST_DIMENSIONS, env, root, db, stackId })`; `writeToDimensions` is module-private at `:165` with `port?: DimensionsPort<Dimension>`; `ingestSource` at `:241` accepts it and `ingestTextSource` at `:303` does not. `sdk/core.ts:84/:86` pass neither `port` nor `env`, so `CreateWikiOptions.env` is silently ignored on the ingest path — a multi-tenant data bug, S1. `CreateWikiOptions` (`sdk/core-types.ts:52`) is `{root, env?}` with no `dimensionsPort`.

L5 (a correction to the brief's own citation). `odd/tasks/package-split.md` contains no S6 forward-plan paragraph naming `CreateWikiOptions.dimensionsPort`: `grep -n 'createWiki'` over its 409 lines returns only `:407` (L6). The only real record of this work is L6 (why a required port cannot ship while `@repo/foundation` is private and unpublished) and L7's `feature/published-entry-port` gap. This document therefore creates the record rather than pointing at one.

L6 (the published type identity, measured). `dist/index.d.ts` (6,844 B / 159 lines) line 1 is `import { WikiCore, CreateWikiOptions } from '@atomicstrata/llmwiki-core/compiler-sdk'`, so the option type is **not** inlined into the root artefact. `packages/wiki/src/sdk/core-types.ts` is published through `packages/wiki/src/sdk/compiler-composition.ts`'s `export type * from "./core-types.js"`. Two `CreateWikiOptions` declaration identities exist and both derive from that one file.

L7 (Manager rulings, verbatim). "**Ruling 1 — published type: YES, with the guard proven to bite**" and "**Ruling 2 — the `env` defect: FOLD IN, as its own commit, RED first**". Also: "`env` rides alone." and "Proceed. Report the `env` RED/GREEN as its own unit."

L8 (prohibitions in force). No history rewriting (no `git reset`, `git restore --staged`, `--amend`). No hook bypass of any kind. No push. `odd/tasks/**` is append-only except the task/tracker lines.

L9 (Manager, verbatim, four corrections to the parent's framing): "**Lint has zero headroom.** `566/402/429` with any new file adding rule/file entries means the new code must be **violation-free, not absorbed**. **`lint:update` is forbidden on this slice**"; "**`PACK_DISTRIBUTION = ["packages/llmwiki-core", "."]`, so `test:pack` installs the local core tarball beside the root one.** That corrects what I told you: **the packed proof exercises the changed core today — it is real evidence, not staged.** What publication gates is a *registry* consumer against the old pinned core, not the proof."; "**Two `CreateWikiOptions` declaration sites** is the mechanism by which the `@repo/foundation` leak would reach `compiler-sdk.d.ts`. Write that in the report as the reason the duplication exists, so a future reader does not collapse the two shapes as redundancy."; "**`@repo/api`'s `index.ts` is a 44-line docstring with zero exports** belongs in the `feature/published-entry-port` record: the parked move could not have reused `"."` as-is, so its cost was always larger than a file move." Also: "**`sdk/core.ts` reads no `LLMWIKI_DIMENSIONS`; the ambient reader is `activation.ts:106`.** Note it, because it means the SDK defect is purely 'a computed value not forwarded', which is why the fix is small and why leaving it would have been indefensible." And: "**803 test files, not 799 or 800** — the third correction to that one number."

L10 (Manager, verbatim, the split): "**Slice shape approved with one split:** `T2` covers the port field and the `core.ts` threading; the `env` forwarding is **`T2b`, its own commit, RED first**, because it changes where rows land for embedders who were already passing `env` and must be revertable alone." Consequence: the `env` fix carries Risk item 1 (wrong-tenant writes), not item 3, and is executed before the type work so that no type ergonomics are built on a known wrong-tenant write.
