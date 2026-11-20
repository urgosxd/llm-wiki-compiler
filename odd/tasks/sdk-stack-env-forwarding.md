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

S11. The OKF bundle's `log.md` HEADER is bundle content like any page: a handle naming Stack B must not take it from the ambient Stack. The residual is `readJournalMarkdown` (`packages/wiki/src/export/okf/bundle.ts:129`), which reads `withJournalSource(process.env, …)` while every page document, the `index.md` and the report are correctly the handle's Stack, so a Stack B `exportOkf` currently hands one tenant's journal heading to another tenant's caller. The thread is ADDITIVE, the way `exportJson`'s optional `env` was: an optional `env` threaded `runOkfExport` (`packages/wiki/src/export/okf/run.ts:17` already holds `const env = opts.env ?? process.env;`) → `buildOkfBundle` (optional `env: NodeJS.ProcessEnv = process.env`, appended after `onWarn` so the EXPORTED signature stays callable exactly as it is today) → `buildLog` → `readJournalMarkdown`, with no other `process.env` left on that read path. No facade change (the facade already forwards `env` into `runOkfExport`, `packages/wiki/src/sdk/core.ts:253`, commit `a6174eaab5f4f33d9b9bd37797e915b55ad28f51`), no caller change. The seam selects Stack rows through `journalStackId(env)` → `readJournalEntries(handle.db, stackId)` (`packages/wiki/src/dimensions/wiki/activity-log-source.ts:26-34`) and `parseLlmwikiLog` (`packages/wiki/src/export/okf/index-log.ts:23-34`) reads date/action/text out of each `## [ISO] operation | description` heading, so two Stacks holding different journal entries yield different `log.md` content.

S12. `packages/wiki/src/commands/export.ts:213`'s hardcoded `process.env` inside `runExport` is CORRECT by design and must not be "fixed", and not because it is unreachable: it is the CLI pipeline, and a CLI process serves one stack, so `process.env` there is the operator's own environment rather than an ambient selection standing in for a caller's argument. No facade door reaches `runExport`. Recorded because the next reader will find that hardcoded `process.env` and wonder whether it is the same bug.

S13. The shared two-Stack harness (`test/sdk/two-stack-env.ts`) must THROW when no database reached the worker, and that refusal is itself pinned so it stays durable rather than merely observed once: a suite body that reached its assertions with no database would prove nothing, and a void cross-tenant proof reported as passed is worse than a red one.

### Facade enumeration (S10) — baseline, measured at `7411a198`

The facade is the object returned by `createWikiCoreAtRoot` (`packages/wiki/src/sdk/core.ts:75`, object literal `:88-268` at the branch tip); its contract is `WikiCore` (`packages/wiki/src/sdk/core-types.ts:180`), 17 exported keys.

**The three baseline columns are the historical finding, measured on `7411a198` before any fix, and they are left as measured.** A reader checking the tree at the branch tip will NOT find four of them: the `env` column's "absent" and the verdict's "leaks" describe the defect this feature closes, not the current code. The last column is that current state, re-measured at `f0285234`.

| # | Key | `env` at the door (baseline `7411a198`) | Baseline verdict | Current state at `f0285234` |
|---|-----|-------------------|------------------|-----------------------------|
| 1 | `ingest` | forwarded, `core.ts:96-97` → `ingestSource(…, env, …)` | clean | unchanged, `core.ts:96-97` |
| 2 | `ingestText` | forwarded, `core.ts:99-100` → `ingestTextSource(root, input, env, …)` | clean | unchanged, `core.ts:99-100` |
| 3 | `compile` | forwarded, `core.ts:116` → `compileAndReport(root, { ...opts, env, dimensionsPort })` | clean | unchanged, `core.ts:116` |
| 4 | `search` | forwarded, `core.ts:132-133` → `withEmbeddingStoreSource(env, …)` + `withRegistrySource(env, …)` | clean | unchanged, `core.ts:132-133` |
| 5 | `query` | forwarded, `core.ts:159` → `generateAnswer(root, question, { ...opts, registrySource, env })` | clean (fixed by `4f00ac37`) | unchanged, `core.ts:159` |
| 6 | `getPage` | forwarded, `core.ts:167` → `withPageSource(env, …)` | clean | unchanged, `core.ts:167` |
| 7 | `listPages` | forwarded, `core.ts:170` → `withPageSource(env, …)` | clean | unchanged, `core.ts:170` |
| 8 | `listSources` | not threaded, `core.ts:172`; `listSources` (`packages/wiki/src/sources/store.ts:23`) takes no environment and reads the on-disk sources tree | does not touch Stack | unchanged, `core.ts:172` — still resolves no Stack |
| 9 | `getSource` | not threaded, `core.ts:182`; takes no environment, reads text through `resolveSourcesDir` → `confinedRegularFile` → `readFile` | does not touch Stack | unchanged, `core.ts:182` — still resolves no Stack |
| 10 | `status` | forwarded, `core.ts:192-194` → `withPageScan(env, …)`, `withSourceDocuments(env, …)`, `collectStatus(…, env)` | clean | unchanged, `core.ts:192-194` |
| 11 | `lint` | forwarded, `core.ts:205` → `lint(root, env)` | clean | unchanged, `core.ts:205` |
| 12 | `lintByTier` | forwarded, `core.ts:207` → `lintByTier(root, env)` | clean | unchanged, `core.ts:207` |
| 13 | `getContextPack` | absent, `core.ts:212-222` — `buildContextPack({ root, prompt, budget?, depth?, topPages?, topChunks? })` | **leaks** (S3) | **fixed** — forward at `core.ts:224` (door opens `core.ts:219`) |
| 14 | `exportJson` | absent, `core.ts:224` — `exportJson(root, opts)` | **leaks** (S3) | **fixed** — forward at `core.ts:239` |
| 15 | `runEval` | not threaded, `core.ts:227-231`; `runEval` (`packages/wiki/src/eval/index.ts:57`) takes no environment | does not touch Stack | shifted to `core.ts:242-247` by the comments the other doors gained; still resolves no Stack |
| 16 | `exportOkf` | absent, `core.ts:233` — `runOkfExport(root, opts)` | **leaks** (S3) | **fixed** — forward at `core.ts:253`; the journal header thread landed in `export/okf/bundle.ts` (S11, `readJournalMarkdown` at `bundle.ts:137`) |
| 17 | `importOkf` | absent, `core.ts:235` — `runOkfImport(root, dir, opts)` | **leaks** (S3) | **fixed** — forward at `core.ts:260` |

No exported key other than these four leaked, so the fix stayed at four doors plus the one journal-header thread inside `exportOkf`, and no detection widening was required. The three rows that never touched Stack are untouched on purpose and are not a residual: `getSource` (`core.ts:182`), `listSources` (`core.ts:172`) and `runEval` (`core.ts:242-247`) still resolve no Stack, and a door that resolves no Stack cannot leak one — there is no env seam for a caller's argument to reach, so an unforwarded argument would change no answer while implying a tenant the door never consults.

## Tasks

T1. Feature document and the facade enumeration — S1, S10 — route: gentle-ai-worker — commit: `f9868968a689a7bc3b3a7d9c71f598d7edde5943` — done.
T2. `getContextPack` forward plus its Stack-versus-ambient proof and revert proof — S1, S3, S4, S5, S7 — route: gentle-ai-worker — commit: `aa1344c221b6891525874d76d3dd49504baebeec` — done.
T3. `exportOkf` and `importOkf` forwards plus proofs and revert proofs (coherent pair) — S1, S3, S4, S5, S7 — route: gentle-ai-worker — commit: `a6174eaab5f4f33d9b9bd37797e915b55ad28f51` — done.
T4. `exportJson` forward, plus the optional `exportJson` options field, plus proof and revert proof — S1, S3, S4, S5, S7 — route: gentle-ai-worker — commit: `fe1782f893ad5b4ab1a7fac36efa77bc17d2979e` — done.
T5. Independent verification of all four proofs and the gate run — S4, S5, S6, S10 — route: gentle-ai-verify — commit: none (verification only; no source change) — evidence: L6 — done.
T6. The OKF journal header thread, its Stack-versus-ambient proof and revert proof, the S6 durable guard, and the S11/S12/S13 record — Specs S11, S12, S13, S4, S5, S7 — route: gentle-ai-worker — commits: `43daab8960d476e1cf280c2622045bdd36993479` (the S11/S12/S13 document record), `ccad156d431d01d1a2cbc215aa04531c64deaf85` (the durable no-database guard), `c5c98a2a2f081910011dda6f4f78b4667e7e9e19` (the journal door itself) — done.

Also on the branch, closing verification's finding rather than a task of its own: `f0285234cfa2c1ac50dc995be09109cb08f3e9b6` is the type-narrowing and journal-date repair that made `pnpm run typecheck:tests` green (see L6).

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

L2. Correction of the Manager's brief, not a finding of this branch: the brief named `packages/api/src/sdk/core.ts:212,224,233,235`, and that path does not exist — `packages/api/src/sdk/` was never there and `packages/api/src/` re-exports no `sdk/core`. This branch introduced no second facade and never saw one; the brief's path was simply wrong, while its line numbers were right against `packages/wiki/src/sdk/core.ts`: the doors are `core.ts:212` (`getContextPack`), `:224` (`exportJson`), `:233` (`exportOkf`), `:235` (`importOkf`) — see S2. The capture is `core.ts:86`, not `:81`, and `getSource` is `core.ts:182`, not `:161`.

L3. Finding: `exportJson` needs one optional internal options field beyond a pure forward. `packages/wiki/src/commands/export.ts:270` hardcodes `process.env` inside `exportJson`, so forwarding an argument from the facade cannot reach it; `ExportJsonOptions` (`packages/wiki/src/export/json-export.ts:78-84`) today carries only `projectId?: string`. The Lead judged the added optional `env?: NodeJS.ProcessEnv` in scope because it is backwards-compatible and changes no public contract — no facade signature and no `WikiCore` member changes (S7) — and the deviation from "one forwarded argument" will be reported to the Manager.

L4. Evidence correction from authoring this document on base 7411a198: three of the baseline `path:line` facts supplied with the assignment do not match the tree, and the measured values are what S2, S3 and S7 record. Facade capture: supplied `core.ts:81`, measured `core.ts:86`. Doors: supplied `208,215,223,226`, measured `212,224,233,235` (which also matches the original request's own numbers, see L2). `getSource`: supplied `:161`, measured `:182`. `context/build.ts`: supplied `119-122` for the `env` consumption, measured declaration at `:117` and consumption at `:129` and `:146`. `import/run.ts`: supplied `:331`, measured `:131`. `ExportJsonOptions`: supplied `json-export.ts:44-49`, measured `:78-84`. The supplied "8 existing call sites" of `ExportJsonOptions` was also measured: the type has two real users (SDK facade `core.ts:224`, CLI export command `commands/export.ts:268`) plus re-exports in `core-index.ts:18` and `core-types.ts:177,211`; an optional added field is backwards-compatible for all of them.

L5. The Manager's ruling for T6, verbatim:

> **The `bundle.ts:129` residual closes here, not later.** A Stack-B OKF export that takes its `log.md` header from `withJournalSource(process.env, …)` is a cross-tenant read, even though every page document, the index and the report are correctly B's. `Risk: item 2` does not come in degrees: either the door hands one stack's data to another's caller or it does not, and right now it hands over a journal header. So widen the branch once, deliberately, and say why in the commit: closing it needs a three-signature thread (`runOkfExport` → `buildOkfBundle` → `buildLog` → `readJournalMarkdown`), `buildOkfBundle` is exported, and leaving it would make the `exportOkf` commit claim a fix it does not deliver. **Keep the thread additive the way `exportJson` was: an optional `env` threaded through, no facade change, no caller change.** **If threading it forces a breaking change to the exported `buildOkfBundle`, stop and report** — then it is a real separate door and I will take that answer. **Same proof shape as the others, and the proof must be specific to this line: an export against Stack B whose `log.md` header comes from B, with a revert proof that shows the ambient header returning.**

> `commands/export.ts:213` is the CLI pipeline and no facade door reaches it — but 'unreachable' is not why it is fine. It is fine because a CLI process serves one stack: `process.env` there is the operator's own environment, not an ambient selection standing in for a caller's argument. **Say that in the document**, because the next reader will find the hardcoded `process.env` and wonder whether it is the same bug.

> **Log it as a correction of my brief, not as your finding** — referring to the brief naming `packages/api/src/sdk/core.ts`, which does not exist; the facade is `packages/wiki/src/sdk/core.ts` and the brief's line numbers were right.

Both rulings are recorded as S11 (the door), S12 (why `runExport` stays as it is) and S13 (the durable guard), and the brief correction as the reframed L2.

L6. Verification evidence for the closed feature, as measured at `f0285234cfa2c1ac50dc995be09109cb08f3e9b6` — T5's record, and T5 changes no code, so its evidence is this entry. It states what was observed, not that every reachable path was exercised; the limits are named at the end.

**Five revert proofs**, independently re-observed by a read-only verifier in a scratch copy checked out at `f0285234`. Each removes exactly one forwarded member and each then fails with the AMBIENT Stack's own data where the handle's was expected — the `alpha-a resolved / alpha-b broken` shape `4f00ac37` established for `query`:

- `getContextPack` — remove `env` at `core.ts:224`: the pack built from a Stack B handle ranks the ambient Stack's page, `concepts/alpha-a` where `concepts/alpha-b` was expected (`test/sdk/context-pack-env.test.ts`).
- `exportJson` — remove `env` at `core.ts:239`: the JSON export from a Stack B handle describes the ambient corpus (`test/sdk/export-json-env.test.ts`).
- `exportOkf` — remove `env` at `core.ts:253`: the bundle from a Stack B handle writes the ambient page, `concepts/alpha-a.md` (`test/sdk/okf-export-env.test.ts`).
- `importOkf` — remove `env` at `core.ts:260`: the imported page lands in the ambient Stack, so B is missing the page it just imported while A gained it (`test/sdk/okf-import-env.test.ts`).
- OKF journal header — revert `readJournalMarkdown`'s environment to the hardcoded `process.env` (`export/okf/bundle.ts:138` at this HEAD; `:129` on the baseline `7411a198`): the written `log.md` carries the ambient heading `## 2024-03-01` where the handle's `## 2024-03-02` was expected (`test/sdk/okf-export-journal-env.test.ts`).

The pre-existing `query` pin was re-observed rejecting too, after its refactor onto the shared two-Stack harness (`test/sdk/two-stack-env.ts`): that diff moved the fixture and changed no `expect(...)` (`test/sdk/query-citation-env.test.ts`).

**Gate of record, run at `f0285234`:**

- `turbo run test --filter=//` — exit 0, `Test Files 959 passed | 5 skipped (964)`, `Tests 6951 passed | 12 skipped (6963)`, `Tasks: 1 successful`, `Cached: 0 cached`.
- All twelve skips are pre-existing, in files this branch never touched: `vendor-contract` (7, no `TYPESAFE_API_KEY`, expected), `pages-gateway` (2), `ingest-gateway` (1), `aks-gateway` (1), `hatch-worker-env-probe` (1). Branch-introduced skips: zero.
- Static gates at the same HEAD, all exit 0: `tsc --noEmit`; `typecheck:tests` (`1764 files checked; 237 baseline diagnostics in 85 files; no regression`); `lint` (`1846 files scanned; 556 baseline violations in 394 files across 421 rule/file entries; no regression`); `fallow:ci` (0 dead-code, 0 complexity, 0 duplication introduced); `build`.

**Defects verification found, and what the branch did about them:**

- `pnpm run typecheck:tests` was RED at `c5c98a2a2f081910011dda6f4f78b4667e7e9e19`: two branch-added test files left `exportOkf`'s `Promise<unknown>` unnarrowed. Repaired in `f0285234cfa2c1ac50dc995be09109cb08f3e9b6`, inside the tests — no contract change.
- Known blemish, recorded rather than hidden: the intermediate commit `ccad156d431d01d1a2cbc215aa04531c64deaf85` added a test file without re-freezing `test/module-graph-crawl.test.ts`, so that ONE commit is red on the pair oracle until `c5c98a2a` re-freezes it at 30. No commit is red at the branch tip.

**Deliberate limit of this evidence:** the no-database scenario is pinned by `test/sdk/two-stack-env-guard.test.ts` — observed rejecting a void proof — and not by executing a run without a database, because `LLMWIKI_TEST_ALLOW_NO_DATABASE` is forbidden by the standing constraints (S6, S13).
