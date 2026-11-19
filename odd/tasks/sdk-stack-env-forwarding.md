# Feature: sdk-stack-env-forwarding

The SDK facade binds one request `env` per handle and forwards it to every door that has a Stack seam — except four. Commit `4f00ac376951500177be3ed09f725949e0cd8c9f` closed this defect for `query`; this feature closes the same captured-but-unforwarded `env` defect at `getContextPack`, `exportJson`, `exportOkf` and `importOkf`. A cross-tenant leak class: `Risk: item 2`. Branch `fix/sdk-stack-env-forwarding`, base `main` @ 7411a198.

## Specs

S1. The four doors `getContextPack`, `exportJson`, `exportOkf`, `importOkf` in `packages/wiki/src/sdk/core.ts` must forward the handle's captured `env` into the inner call, in the same shape as `4f00ac37` did for `query` (`generateAnswer(root, question, { ...opts, registrySource, env })`). One forwarded argument per door; the inner functions already accept it (`BuildContextPackOptions.env` at `packages/wiki/src/context/build.ts:117`, `OkfExportOptions.env` at `packages/wiki/src/export/okf/run.ts:14`, `OkfImportOptions.env` at `packages/wiki/src/import/run.ts:46`).

S2. Verified baseline facts (measured on base 7411a198, do not re-derive): the facade `env` is bound once per handle at `packages/wiki/src/sdk/core.ts:86` as `const env = options.env ?? process.env;`. The four doors are at `packages/wiki/src/sdk/core.ts:212` (`getContextPack`), `:224` (`exportJson`), `:233` (`exportOkf`), `:235` (`importOkf`). `getSource` (`packages/wiki/src/sdk/core.ts:182`) resolves no Stack and cannot leak: it reads through `resolveSourcesDir` → `confinedRegularFile` → `readFile` and takes no environment. `runEval` (`packages/wiki/src/eval/index.ts:57`) resolves no Stack. Every other facade method already forwards `env`.

S3. The ambient fallback that makes each leak real — without it the missing forward would be theoretical, and a door with no fallback must not be "fixed":
- `getContextPack` → `buildContextPack` consumes `options.env` at `packages/wiki/src/context/build.ts:129` (`buildViewerSnapshot(options.root, options.env)`) and `:146` (`collectProjectState(options.root, options.env)`); omitting it makes both describe whichever Stack the process is bound to.
- `exportJson` → `packages/wiki/src/commands/export.ts:270` hardcodes `process.env`: `withRawPageSource(root, process.env, (source) => collectExportPages(root, source, process.env))`.
- `exportOkf` → `packages/wiki/src/export/okf/run.ts:17` is `const env = opts.env ?? process.env;`.
- `importOkf` → `packages/wiki/src/import/run.ts:131` is `const env = opts.env ?? process.env;`.

S4. Per-door proof shape: two Stacks with distinguishable pages; a call against Stack B must never return Stack A's page, id, slug or body; the positive half too — the call against Stack B must return Stack B's own page, so a fix returning nothing cannot pass. Each test asserts every observable effect of the rule it covers (exit code, exact stdout and stderr where the door emits them, and that a rejected or failed call leaves stored data and counters unchanged), through the public SDK interface, never internal storage.

S5. Revert proof per door: comment the forwarded line out, observe the test fail with the same shape as the existing `alpha-a resolved / alpha-b broken` pin from `4f00ac37`. A pin whose rejection power was never observed is a guess.

S6. Tests hard-fail when no database is reachable — never skip, never return silently (a harness that passes with no database proves nothing). `TESTCONTAINERS_REUSE_ENABLE=false`; refuse a server this run did not create; never adopt `crazy_heyrovsky` on `:5434` (schema-stale).

S7. No new mechanism: one forwarded `env` argument. Single recorded exception: `exportJson` additionally needs one optional field `env?: NodeJS.ProcessEnv` on the internal `ExportJsonOptions` (`packages/wiki/src/export/json-export.ts:78-84`, today only `projectId?: string`), because its callee hardcodes `process.env`. That field is backwards-compatible for every existing user of the type — the SDK facade (`packages/wiki/src/sdk/core.ts:224`), the CLI export command (`packages/wiki/src/commands/export.ts:268`), and the re-exports in `packages/wiki/src/core-index.ts:18` and `packages/wiki/src/sdk/core-types.ts:177,211` — and changes no facade signature and no `WikiCore` interface member.

S8. One commit per door or per coherent pair, each commit carrying a `Risk: item 2` line and a Conventional Commit message.

S9. Out of scope: a door needing a different resolution path, a missing parameter, or any other API change; anything beyond these four doors; push, pull request, merge. If one of the four needs more than a forwarded argument, stop and report it rather than widening this branch.

S10. Enumeration deliverable: every exported key of the facade with a verdict of clean / leaks / does not touch Stack. The enumeration below is the T1 deliverable and the baseline T5 verifies against.

### Facade enumeration (S10)

The facade is the object returned by `createWikiCoreAtRoot` (`packages/wiki/src/sdk/core.ts:84-243`); its contract is `WikiCore` (`packages/wiki/src/sdk/core-types.ts:180`), 17 exported keys.

| # | Key | `env` at the door | Verdict |
|---|-----|-------------------|---------|
| 1 | `ingest` | forwarded, `core.ts:96-97` → `ingestSource(…, env, …)` | clean |
| 2 | `ingestText` | forwarded, `core.ts:99-100` → `ingestTextSource(root, input, env, …)` | clean |
| 3 | `compile` | forwarded, `core.ts:116` → `compileAndReport(root, { ...opts, env, dimensionsPort })` | clean |
| 4 | `search` | forwarded, `core.ts:132-133` → `withEmbeddingStoreSource(env, …)` + `withRegistrySource(env, …)` | clean |
| 5 | `query` | forwarded, `core.ts:159` → `generateAnswer(root, question, { ...opts, registrySource, env })` | clean (fixed by `4f00ac37`) |
| 6 | `getPage` | forwarded, `core.ts:167` → `withPageSource(env, …)` | clean |
| 7 | `listPages` | forwarded, `core.ts:170` → `withPageSource(env, …)` | clean |
| 8 | `listSources` | not threaded, `core.ts:172`; `listSources` (`packages/wiki/src/sources/store.ts:23`) takes no environment and reads the on-disk sources tree | does not touch Stack |
| 9 | `getSource` | not threaded, `core.ts:182`; takes no environment, reads text through `resolveSourcesDir` → `confinedRegularFile` → `readFile` | does not touch Stack |
| 10 | `status` | forwarded, `core.ts:192-194` → `withPageScan(env, …)`, `withSourceDocuments(env, …)`, `collectStatus(…, env)` | clean |
| 11 | `lint` | forwarded, `core.ts:205` → `lint(root, env)` | clean |
| 12 | `lintByTier` | forwarded, `core.ts:207` → `lintByTier(root, env)` | clean |
| 13 | `getContextPack` | absent, `core.ts:212-222` — `buildContextPack({ root, prompt, budget?, depth?, topPages?, topChunks? })` | **leaks** (S3) |
| 14 | `exportJson` | absent, `core.ts:224` — `exportJson(root, opts)` | **leaks** (S3) |
| 15 | `runEval` | not threaded, `core.ts:227-231`; `runEval` (`packages/wiki/src/eval/index.ts:57`) takes no environment | does not touch Stack |
| 16 | `exportOkf` | absent, `core.ts:233` — `runOkfExport(root, opts)` | **leaks** (S3) |
| 17 | `importOkf` | absent, `core.ts:235` — `runOkfImport(root, dir, opts)` | **leaks** (S3) |

No exported key other than these four leaks, so the fix stays at four doors and no detection widening is required.

## Tasks

T1. Feature document and the facade enumeration — S1, S10 — route: gentle-ai-worker — commit: this commit (full SHA returned in the task handoff).
T2. `getContextPack` forward plus its Stack-versus-ambient proof and revert proof — S1, S3, S4, S5, S7 — route: gentle-ai-worker — commit: pending.
T3. `exportOkf` and `importOkf` forwards plus proofs and revert proofs (coherent pair) — S1, S3, S4, S5, S7 — route: gentle-ai-worker — commit: pending.
T4. `exportJson` forward, plus the optional `exportJson` options field, plus proof and revert proof — S1, S3, S4, S5, S7 — route: gentle-ai-worker — commit: pending.
T5. Independent verification of all four proofs and the gate run — S4, S5, S6, S10 — route: gentle-ai-verify — commit: pending.

## Log

L1. The user's original request, verbatim:

Four SDK entry points share the cross-tenant defect that `4f00ac3769` fixed for answer generation. Close them the same way.

## What was found, and why it is `Risk: item 2`
**In `fix/query-wiki-citations-row-backed-index`, the SDK facade captured `env` but did not forward it into answer generation.** **Result: Stack B's report resolved Stack A's `pageId`, while the grounded page stayed `broken`.** **Caught by independent verification, fixed in `4f00ac376951500177be3ed09f725949e0cd8c9f`, and pinned with a revert proof — without the one forwarded line the test fails `alpha-a resolved / alpha-b broken`.**

**The same defect class is reported still open at four other doors, at or near `packages/api/src/sdk/core.ts:212,224,233,235`: `getContextPack`, `exportJson`, `exportOkf`, `importOkf`.** **Pre-existing, unrelated to citations, and each needs its own Stack-versus-ambient proof.**

**A cross-tenant leak in a shipped SDK is not a hardening task.** **One stack's caller receiving another stack's data is the failure this repository must not ship.**

## Step 1 — do not trust the list; verify it, then widen it
**Read `sdk/core.ts` and every sibling of those four calls.** **The list came from a report and every brief in this campaign has had wrong premises.**
1. **For each SDK entry point, does it accept an `env` (or a per-call Stack) and does it forward it to the layer that resolves Stack?** **`path:line` for the capture and for the forward, or the absence of the forward.**
2. **Is the leak reachable, or theoretical?** **A captured-but-unforwarded `env` leaks only if the inner layer falls back to an ambient Stack.** **Show the fallback that makes it real. If there is none for a given door, say so and do not fix it.**
3. **Are there more than four?** **Enumerate every export of that module and say which are clean, which leak, and which do not touch Stack at all.** **A door that resolves no Stack cannot leak one.**

## Step 2 — fix, in the shape that already worked
**Forward the caller's `env`/Stack exactly as `4f00ac37` did. Do not invent a new mechanism: the fix that exists is the one the repository has already proven, and a second pattern is a second thing to keep in step.**

**Each door gets the same proof shape, and the proof is the deliverable:**
- **Two stacks with distinguishable pages; a call against Stack B must never return Stack A's page, id, slug or body.**
- **The positive half too: the call against Stack B must return Stack B's own page**, so a fix that returns nothing cannot pass.
- **A revert proof: comment the forwarded line out and watch the test fail with the same shape as `alpha-a resolved / alpha-b broken`.** **A pin whose rejection power you never observed is a guess.**

## Step 3 — say what is out of scope
**If any door needs more than a forwarded argument — a different resolution path, a missing parameter, an API change — stop and report it rather than widening this branch.** **A contract change on four entry points at once is how a reviewer stops reading.**

## Standing constraints
- **Node 24 on PATH for `git commit`.** Never `--no-verify`, never `HUSKY=0`.
- **No `.env`, no keys, no tokens, no provider spend.**
- **Test database isolation in force:** `TESTCONTAINERS_REUSE_ENABLE=false`, and **refuse a server this run did not create.** **Do not adopt `crazy_heyrovsky` on `:5434` — it is schema-stale.**
- **This defect class has a trap you must avoid:** a harness that returns silently when no database is reachable makes a no-database run pass while proving nothing. **Your tests must hard-fail on unreachability rather than skip.**
- **Nothing pushed, no PR, no merge.**

## Deliverables
- **`odd/tasks/sdk-stack-env-forwarding.md`** with `## Specs`, `## Tasks`, `## Log`, L1 = this task verbatim.
- **One commit per door or one commit per coherent pair, each with a `Risk: item 2` line.**
- **Report: the full enumeration of SDK entry points with each one's verdict, which doors leak and the fallback that makes it real, the four revert proofs, the full 40-character SHA, and the gate scope with its counts.**

L2. Correction to the request's premises: it names `packages/api/src/sdk/core.ts:212,224,233,235`, but the facade lives at `packages/wiki/src/sdk/core.ts`. `packages/api/src/sdk/` does not exist and `packages/api/src/` re-exports no `sdk/core`, so there is no second facade to fix. The line numbers the request gave are correct inside the `wiki` package: the doors are `core.ts:212` (`getContextPack`), `:224` (`exportJson`), `:233` (`exportOkf`), `:235` (`importOkf`) — see S2. The capture is `core.ts:86`, not `:81`, and `getSource` is `core.ts:182`, not `:161`.

L3. Finding: `exportJson` needs one optional internal options field beyond a pure forward. `packages/wiki/src/commands/export.ts:270` hardcodes `process.env` inside `exportJson`, so forwarding an argument from the facade cannot reach it; `ExportJsonOptions` (`packages/wiki/src/export/json-export.ts:78-84`) today carries only `projectId?: string`. The Lead judged the added optional `env?: NodeJS.ProcessEnv` in scope because it is backwards-compatible and changes no public contract — no facade signature and no `WikiCore` member changes (S7) — and the deviation from "one forwarded argument" will be reported to the Manager.

L4. Evidence correction from authoring this document on base 7411a198: three of the baseline `path:line` facts supplied with the assignment do not match the tree, and the measured values are what S2, S3 and S7 record. Facade capture: supplied `core.ts:81`, measured `core.ts:86`. Doors: supplied `208,215,223,226`, measured `212,224,233,235` (which also matches the original request's own numbers, see L2). `getSource`: supplied `:161`, measured `:182`. `context/build.ts`: supplied `119-122` for the `env` consumption, measured declaration at `:117` and consumption at `:129` and `:146`. `import/run.ts`: supplied `:331`, measured `:131`. `ExportJsonOptions`: supplied `json-export.ts:44-49`, measured `:78-84`. The supplied "8 existing call sites" of `ExportJsonOptions` was also measured: the type has two real users (SDK facade `core.ts:224`, CLI export command `commands/export.ts:268`) plus re-exports in `core-index.ts:18` and `core-types.ts:177,211`; an optional added field is backwards-compatible for all of them.
