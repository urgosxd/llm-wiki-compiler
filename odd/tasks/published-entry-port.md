# Published entry port — the record that was living inside someone else's document

This record exists because a finding stored as a Consequence line inside another feature's document is where findings go to be lost. It promotes `S10` of [published-entry-composition.md](published-entry-composition.md) into a feature of its own: the parked move of the published library entry to a layer that can compose. It is **ergonomics after a coordinated two-package release, never capability**.

## Specs

Spec IDs are `S1`–`S5`; task IDs are `T1`–`T2`. Every figure here is measured, not derived; lines marked `Consequence:` are derived.

S1. MOVING THE ROOT ENTRY IS INERT FOR THE SDK PATH. Measured at `0aa74938`: `dist/index.js` is **108,001 B** with `resolveDimensions` **0**, `LLMWIKI_DIMENSIONS` **0**, `sdk/core.ts` **0**, while the engine ships in `packages/llmwiki-core/dist/chunk-*.js` at **848,656 B** (**849,299 B** for a fresh build of `2c81bfcf`, `chunk-EASDPJWH.js`; the size is build-dependent, so both measurements are recorded and neither supersedes the other). A composing entry that moved and passed a port would have the shipped core drop it.

Consequence: the entry move is not a precondition for a port; it is ergonomics. Anyone reading a moved entry as new capability is over-reading the diff.

S2. THE ENGINE REACHES EMBEDDERS THROUGH THAT SECOND PUBLISHED ARTEFACT. `tsup.config.ts:17` externalizes it, and `packages/llmwiki-core` has no `src/` and compiles `packages/wiki/src/core-index.ts` plus `sdk/compiler-composition.ts`.

Consequence: any change to the engine's published surface is a **two-package** release, because the artefact consumers actually load is not the root one.

S3. THE COST WAS ALWAYS LARGER THAN A FILE MOVE. `packages/api/src/index.ts` is a 44-line docstring with **zero exports**, so a composing entry could not reuse `"."` as-is.

Consequence: the parked work is not "point the entry somewhere else"; a composing entry needs an entry that actually exports something to compose.

S4. WHAT PUBLICATION GATES IS REGISTRY CONSUMERS AGAINST THE OLD PINNED CORE, NOT THE EVIDENCE. `test:pack` installs the local core tarball beside the root one, so packed evidence is real today.

Consequence: nobody should read "not published yet" as "not proven"; the proof runs, and what is missing is a registry consumer's ability to receive the coordinated pair.

S5. A **REQUIRED** PORT ON `CreateWikiOptions` STAYS BLOCKED UNTIL PUBLICATION EXISTS. The published type must not name a private specifier, so the field cannot become required while the type it names is unpublished.

Consequence: `T2` is blocked, not pending, and its unblock condition is the coordinated `packages/llmwiki-core` → `.` release with `publish.yml` `PACKAGE_DIRS` ordering.

## Tasks

T1 · S1-S5 · route: gentle-ai-worker · record promotion (this file) · commit: pending (this documentation commit; a commit cannot carry its own SHA, so the full SHA is filled by the next tracker update)
T2 · S5 · route: blocked · unblock condition: publication of the coordinated `packages/llmwiki-core` → `.` release via `publish.yml` `PACKAGE_DIRS` ordering · commit: pending

## Log

L1 — original request (verbatim):

```text
## 4. Promote the record to its own file

Create `odd/tasks/published-entry-port.md`. Right now S10 exists only as a Consequence line inside another feature's document, which is where findings go to be lost. It must carry four measured facts:
- Moving the root entry is **inert for the SDK path**: `dist/index.js` is 108,001 B with `resolveDimensions` 0, `LLMWIKI_DIMENSIONS` 0, `sdk/core.ts` 0, while the engine ships in `packages/llmwiki-core/dist/chunk-*.js` at 848,656 B.
- The engine reaches embedders through that **second published artefact** (`tsup.config.ts:17` externalizes it; `packages/llmwiki-core` has no `src/` and compiles `packages/wiki/src/core-index.ts` + `sdk/compiler-composition.ts`).
- The cost was always **larger than a file move**: `packages/api/src/index.ts` is a 44-line docstring with **zero exports**, so a composing entry could not reuse `"."` as-is.
- What publication gates is **registry consumers against the old pinned core**, not the evidence — `test:pack` installs the local core tarball beside the root one, so packed evidence is real today.
Add that a **required** port on `CreateWikiOptions` stays blocked until publication exists, because the published type must not name a private specifier.
```

L2 — provenance: the Consequence line this record came from, quoted verbatim from [published-entry-composition.md](published-entry-composition.md), line 39:

```text
Consequence: `feature/published-entry-port` must record what it has to do, the coordinated `packages/llmwiki-core` → `.` release with `publish.yml` `PACKAGE_DIRS` ordering, that a required port on `CreateWikiOptions` stays blocked until publication exists, and that it buys embedder ergonomics rather than capability.
```

L3 — measured where: `test/artifact/entries-ingest-port.test.ts:46-63` writes down the same ceiling in prose (S11: the root `dist/index.js` is ~105 KB with `resolveDimensions`, `LLMWIKI_DIMENSIONS`, `sdk/core.ts` and the ingest service all ABSENT), and `test/artifact/entries-load.test.ts:229-244` proves the root `dist/index.js` exports only the facade — it imports the literal artefact path, then imports `packages/llmwiki-core/dist/index.js` separately, so the two are distinguishable at the only place a reader can check. Both are cited by `path:line`, not by prose reference.

L4 — first correction to the composition record: this document supersedes `S10`'s forward-pointer prose, but **not** `S10` itself. `S10` stays in [published-entry-composition.md](published-entry-composition.md) as the ruling that recorded the entry move as ergonomics; this file is where that ruling's obligations are tracked to completion. `S11` remains where it is, because it is a limit on that slice's artefact tier.

L5 — cross-reference: the slice that produces this measurement is [packed-manifest-guard.md](packed-manifest-guard.md), whose `T5` promotes this record. `S1`–`S4` here are its `L1` item 4 verbatim; nothing in that document changes the facts above.

L6 — re-measurement: a fresh build of base `2c81bfcfed05cb8b9d2fe183f1ce213df234f0ab` measures the engine chunk at **849,299 B** (`packages/llmwiki-core/dist/chunk-EASDPJWH.js`), against the **848,656 B** recorded in `S1` at `0aa74938`; `S1` now carries both figures because the size moves with the build. `dist/index.js` measured **108,001 B**, confirming `S1`'s root-entry figure unchanged. And `packages/llmwiki-core/dist` was **byte-identical across 41 files** (sha256 over every `dist/*.js` and `*.d.ts`) between the repo build and the same code installed from the packed tarball — which is the mechanical reason `S2`'s "second published artefact" claim holds: the artefact consumers load is not re-derived from the root entry, it is the same bytes that the workspace build produced.
