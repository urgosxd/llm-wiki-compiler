# Feature: Stack id inline readers — every reader takes the identity the run already resolved

Branch: `refactor/stack-id-inline-readers`, base commit `031f84a0d42976922640c1efc755bb793b50ffc7`. Tracking document written BEFORE any source write, per ODD step 5. Predecessor: `odd/tasks/single-stack-authority.md`, whose Log L5 records T11 as this branch's L1.

Invariant: **the authority answered correctly and the reader never asked it.** `refactor/single-stack-authority` closed the sites that asked the variable about an **absent** id. These readers ask the variable about an id that **has already been resolved** — a different invariant, therefore a different RED and a different branch. HIGH-RISK: item 3 across T1–T4 and T7 (internal function contracts consumed across the compiler), item 4 on T6 (concurrency). No data is migrated, `public.stacks` is unchanged, and nothing in `packages/wiki/src/dimensions/stack-authority.ts` changes.

## Specs

**S1 — the invariant (verbatim).** "Each of those must take its Stack identity from the authority the run already resolved — threaded, not re-derived."

**S2 — the headline defect, and it is the one to LEAD with (verbatim).** "a row-backed run that resolved its Stack from the database still takes the FILE custody branch." — "`compiler/candidate-custody.ts:209` reads ambient `process.env` — it caches a resolved answer and then ignores it."

That sentence is the headline of this whole feature and the first thing every task reads. Measured at base: `candidateQueueIsRows(env: NodeJS.ProcessEnv = process.env)` at `packages/wiki/src/compiler/candidate-custody.ts:208` returns `(env[AKS_STACK_ID_ENV_VAR] ?? "").trim() !== ""` at `:209`, and is called with **no argument** at `:217` (`assertCandidateNamespacesHealthy`) and `:231` (`assertMutationTargetWritable`). A run that resolved its Stack from the database, holding `{ kind: "stack", stackId }`, therefore takes the file branch: it demands a candidate **DIRECTORY** of a row-backed queue. The assertion is **where the result lands, not an error message** — the RED observes which backend answered, never the wording of a refusal, because asserting a message would pin prose instead of the defect.

**S3 — the four exclusions (verbatim).**

- "Not a new resolver call per site. If a site cannot reach the resolved authority, threading it is the fix and a second resolution is the defect you were sent to remove."
- "Not a fork of the authority. No local copy of the precedence, no local `isDatabaseConfigured`."
- "Not a behaviour change to `tenant-db.ts:157`. S3 holds." (S3 is `odd/tasks/single-stack-authority.md` S3: "Do not touch the MCP tool path's behaviour — tenant-db.ts:157 is correct as written.")
- The authority module itself is excluded: **nothing in `packages/wiki/src/dimensions/stack-authority.ts` changes.** It is the answer, not a site. This document records its type and both entry points (S13) only so a worker can consume it, never to re-cut it.

**S4 — test-first (verbatim).** "Write the RED that shows a run whose Stack was resolved from the database still taking the file branch at `candidate-custody.ts:209`." — "Report the literal failure." — "And a touched-behaviour pin for each reader whose file branch is legitimately reachable in file mode — file mode must keep working, with a name, exactly as it does now."

The pin requirement is not decoration. Measured at base, the six live-reach readers reach file mode *by absence*: their existing pins leave `AKS_STACK_ID` unset, and `withFileMode` (`test/fixtures/file-mode.ts:160`) blanks only the DSN variables, so a leaked `AKS_STACK_ID` still yields a `stack` authority with the DSNs blanked. Threading the authority turns file mode into a **NAMED value** instead of an absence, which is exactly what a pin must prove with the same strength it has today.

**S5 — census by behaviour, before any change (verbatim).** "Re-measure all of them before changing any — the list is a starting point, not a census, and a missing twelfth is worth more than a fixed eleven." — "Enumerate every remaining reader of the variable that is not the authority and not `tenant-db.ts:157`."

**S6 — constraints (verbatim).**

- "Never print a connection string, URL with userinfo, token, key, env value or model value."
- "Do not read or edit `.env`. Do not contact `aks`. Do not push."
- Gate of record: "`PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" corepack pnpm exec turbo run test --filter=//`" and "pre-commit the expected population BEFORE running it and compare against the run, not after."
- "Base this branch on `031f84a0` — the branch is not merged and this work stacks on it."
- "The suite has a known red on that base: five graph-retirement failures in row mode, T15, a row-store defect that cannot record a removal. Do not fix it and do not treat it as yours; report the population with and without those five."

**S7 — the deliverable, verbatim, one line.** "The re-measured census (not just the eleven) · the RED literal · the threading on each reader with the authority passed in rather than re-derived · the file-mode pins · the full 40-char SHA · the gate counts against the pre-committed number, with T15's five named separately · and one sentence: does removing `AKS_STACK_ID` from `.env` now change any behaviour anywhere, and if not, what is still reading it."

**S8 — the operator's goal (verbatim).** "kill the fallbacks and the variables."

The closing sentence S7 demands exists to answer that goal and not a narrower one. It is not answered by "the eleven are threaded"; it is answered by naming **every** remaining reader of the variable, including the ones deliberately left in place — which is why S12 exists and why T8 may not close on a partial enumeration.

**S9 — the census is reported as THREE numbers, never one.** Each number answers a different question, and a report that gives only one of them cannot be re-measured or argued with:

| number | question it answers | measured at `031f84a0` |
| --- | --- | --- |
| **61** raw non-test hits | how many lines mention the variable in TypeScript source at all | `git grep -c 'AKS_STACK_ID' -- 'packages/*' ':!*test*'` summed |
| **19** consumer sites | how many places actually *decide something* about the variable | classified below in L4 |
| **9** defect-shaped inline readers | how many places re-derive a Stack identity they were already given | table in L4 |

### A constant-grep census misses readers by construction

A grep for the shared constant `AKS_STACK_ID_ENV_VAR` (48 non-test hits at base) over-counts comments and imports and **under-counts readers**, because two of the readers do not spell the constant at all:

1. **A forked literal.** `packages/wiki/src/dimensions/wiki/project-config-seam.ts:37` declares `const STACK_ID_ENV = "AKS_STACK_ID";` and reads it at `:53` as `(env[STACK_ID_ENV] ?? "").trim()`. Grepping `AKS_STACK_ID_ENV_VAR` cannot see this reader; it is invisible to the constant by construction. This is the fork T7 owns (S11).
2. **A string literal.** `packages/wiki/src/mcp/wiki-read-tools.ts:271` writes `const env = { ...process.env, AKS_STACK_ID: stackId };` — the variable name as a bare string, no constant involved. It is a test-only seam in production code (S12), not in scope, but a census that cannot see it cannot say so either.

So the corpus strings a complete census must grep are three, and only the third finds the behavioural readers:

- the **shared constant**: `AKS_STACK_ID_ENV_VAR`;
- the **literal string form**: `"AKS_STACK_ID"` and `AKS_STACK_ID:` (property-key form);
- the **behavioural shape**: a function that picks a backend from a Stack identity while carrying `env: NodeJS.ProcessEnv = process.env` as a default. This is the shape that actually defines a defect-shaped reader, and it is not a string at all: `candidateQueueIsRows`, `eventsAreRowBacked`, `readEventsFromRows`, `appendEventToRows`, `lintStackId`, `markerStackId`, `candidateStackId`, `journalStackId`, `artifactStackId` all match it. Every one of the nine is found by the shape and only seven of the nine by the constant.

**S10 — the six/three split, and why the split decides the commit shape (verbatim).** "a RED that has to construct the omission is not observing a defect."

Of the nine defect-shaped readers, **six** have live ambient reach (they are called with no argument inside their own file, so ambient `process.env` is really consulted at run time) and get **RED-then-fix**. **Three** have a dead default in-file (the parameter exists, nothing in the file omits it) and get **"their defaulted `env` parameter removed so the omission becomes a type error, in one mechanical commit, with a test that the parameter is required."**

The reason is the quoted sentence itself: to write a RED for a default nothing omits, the test would have to construct the omission artificially, and a test that manufactures its own defect observes nothing about the shipped code. Those three are therefore recorded as a **latent hazard, not a live defect** — the finding is that the hazard exists, and the remedy is a type error, not a behavioural test. S10 names them: `activity-log-source.ts:25`, `candidate-source.ts:56`, `derived-artifact-source.ts:27`.

**S11 — the fork at `project-config-seam.ts:37` (verbatim).** Either the leaf-module move or "the missing measurement produced and the literal retained with it." — "Do not delete on reasoning alone."

The comment above that literal claims a measurement: *"Declared here rather than imported from `dimensions/activation.ts`: that module imports `wiki/database`, and importing it from inside the wiki layer closes a dependency cycle through the store (measured: four cycles)."* That claim is **not re-measurable in this tree**, and that is recorded here as a finding in its own right:

> a justification nobody can re-measure is a justification that will never be revisited.

Measured: **no dependency-cruiser or madge configuration exists in the tree** (`git ls-files` matching `madge|dependency-cruiser|depcruise` returns nothing), and the only crawl test — `test/module-graph-crawl.test.ts` — measures `vitest related` **parity**, not cycles. So "four cycles, measured" is an unevidenced number in a comment, and deleting the literal on the strength of the comment would be deleting on reasoning alone. T7 must produce the measurement before the literal moves, or keep the literal and ship the measurement alongside it.

The structure the measurement already establishes, verified here: the back-edge is a **call-time dynamic** `import()` at `packages/wiki/src/project/config.ts:141` (`const { readStackProjectConfig } = await import("../dimensions/wiki/project-config-seam.js");`), reached from the static chain `packages/wiki/src/dimensions/activation.ts:45-49` → `wiki/database.ts` → `store-dimension` → `source-projection` → `utils/source-writer` → `sources/selection` → `project/config.ts`. A call-time dynamic import **cannot deadlock ESM evaluation**, because module evaluation of `config.ts` completes without evaluating the seam. The reading to record with it:

> an edge that cannot deadlock is not an argument for a forked literal, it is an argument for a cheaper remedy.

**S12 — `wiki-read-tools.ts:271` (verbatim).** "A test-only seam in production code writing a string literal of the variable name is not an S3 violation and not in scope."

Out of the fixes, and yet the closing sentence of S7 "must name it rather than round it away." A census that silently omits the one site a grep cannot see would be exactly the rounding-away this feature exists to prevent; naming it as out-of-scope is a different act from failing to see it.

**S13 — the chosen fix shape, with its evidence.** The authority is threaded as a **VALUE, required, at each reader's boundary** — not resolved, not re-derived, not imported ambiently at the site. That is the shape `fd8d61bf` already applied to the sister sites in this same tree (measured: 4 files, `compiler/index.ts` 153 lines and `page-source-seam.ts` 339 lines, leaving **zero** `stackId === ""` guards in both).

The authority's actual type, verbatim from `packages/wiki/src/dimensions/stack-authority.ts:64-66`:

```ts
export type StackAuthority =
  | { readonly kind: "stack"; readonly stackId: string }
  | { readonly kind: "file"; readonly reason: FileBackedReason };
```

There is **no `"row"` variant**: rows and file are two outcomes of one precedence, not two authority kinds. The existing converters are `stackIdOf(authority)` (`:256`) and `requireStackId(authority, context)` (`:272`) — a reader that needs an id calls one of these, it does not read a variable. The two entry points are `resolveStackAuthority({ stackId, env, db })` (`:164`) and `resolveStackAuthorityWithoutLookup(request, context)` (`:203`); a reader never calls either, because calling one would be the second resolution S3 forbids.

The canonical diff to copy, taken from the shape `fd8d61bf` applied:

```ts
-  env: NodeJS.ProcessEnv = process.env,
+  authority: StackAuthority,
-  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
-  if (stackId === "") return undefined;
+  if (authority.kind === "file") return undefined;
```

Note what the substitution preserves and what it destroys: the *file* answer survives as a named kind, and the ambient default is gone. The `undefined` in that diff is that site's own file-mode answer and stays; only its **subject** changes.

**The recorded exception: `utils/lock.ts`.** The lock is taken at `packages/wiki/src/compiler/index.ts:362` (`const locked = await acquireMutationLock(root, "ordinary", { env: options.env });`), **before** `runCompilePipeline` resolves the authority at `:1103` (`const stackAuthority = await resolveStackAuthority({ env, db });`). **No authority can exist at that point, by construction** — the lock is what makes the resolution safe to perform, so requiring one there would be a cycle in the argument, not a refinement of it. That site therefore removes the ambient default and **threads the env its caller already holds**, and the reason is written down here rather than pressed into the general shape, so that a future reader does not "fix" it into a dependency it cannot satisfy. Its key derivation is unchanged: `stackIdOf`-by-env → `realpath(root)` fallback, one identity wherever it is looked up.

## Tasks

- [ ] **T1** — candidate custody leads: RED (a row-resolved run must not demand a candidate DIRECTORY) then thread the authority through `candidate-custody.ts` → `candidates.ts` → `review-pipeline.ts` → `compiler/index.ts` · S1,S2,S4,S10,S13 — worker then independent verify — commit: pending — `Risk: item 3` (changes internal function contracts consumed across the compiler)
- [ ] **T2** — pending-embeddings: thread from `finalizeWiki` (`compiler/index.ts:1816`) down through `utils/embeddings-refresh.ts`, `utils/embeddings-retry.ts`, `utils/pending-embeddings.ts` · S1,S4,S10,S13 — worker then independent verify — commit: pending — `Risk: item 3`
- [ ] **T3** — events: `events/store.ts` append and `events/store-read.ts` read/prepare/verify; update `linter/rules-events.ts`, `profile/block.ts`, `events/store-version.ts` callers · S1,S4,S10,S13 — worker then independent verify — commit: pending — `Risk: item 3`
- [ ] **T4** — lint cache: `linter/cache.ts` read/write; caller `viewer/health.ts` · S1,S4,S10,S13 — worker then independent verify — commit: pending — `Risk: item 3`
- [ ] **T5** — the three dead defaults: remove the defaulted `env` on `activity-log-source.ts:25`, `candidate-source.ts:56`, `derived-artifact-source.ts:27` so omission is a type error; one mechanical commit with a test proving the parameter is required · S1,S10 — worker — commit: pending — `Risk: item 3`
- [ ] **T6** — lock: delete the ambient default on `releaseLock`/`acquireLock`/`acquireLockBlocking` and thread the env each caller already holds, at the six omitting call sites; key derivation unchanged · S1,S13 — worker then independent verify — commit: pending — `Risk: item 4` (concurrency) and `item 3`
- [ ] **T7** — the forked literal at `project-config-seam.ts:37`: produce the missing cycle measurement, then either move the constant to a leaf module both sides import or retain the literal WITH that measurement as evidence · S11 — worker then independent verify — commit: pending — `Risk: item 3`
- [ ] **T8** — the gate: pre-commit the population, run the gate of record, and write the closing sentence naming every remaining reader · S6,S7,S8,S12 — verify — commit: pending — `Risk: none`

### Sequencing

**T1 first.** It proves the shape and needs no database: the custody row branch is a pure early return, so the headline RED is observable without Postgres and the pattern the other seven tasks copy is settled before any of them spends a runner.

**T2–T4 run SEQUENTIALLY, never in parallel.** Each of them touches `packages/wiki/src/compiler/index.ts`, so they are overlapping writers on one file; one writer at a time, in the order listed.

**T6 must follow T3**, because both touch `events/store.ts`, and a lock threaded into an append whose signature is mid-change is a conflict, not a task.

**T5 and T7 are independent of the rest** and of each other — T5 is a type-level deletion in `dimensions/wiki/`, T7 is a measurement in `dimensions/wiki/` and `project/` — so either may run at any time without waiting on the custody chain.

## Log

L1 — The requester's original T11 assignment, verbatim and in full, in a fenced block so its own emphasis survives intact:

```text
T11: the eleven subsystems that read `AKS_STACK_ID` inline instead of asking the authority. This is the change that makes removing the line from `.env` actually change nothing — which is the operator's stated goal. **a row-backed run that resolved its Stack from the database still takes the FILE custody branch.** **`compiler/candidate-custody.ts:209` reads ambient `process.env` — it caches a resolved answer and then ignores it.** **That is the defect to lead with.** **Re-measure all of them before changing any — the list is a starting point, not a census, and a missing twelfth is worth more than a fixed eleven.** **Enumerate every remaining reader of the variable that is not the authority and not `tenant-db.ts:157` (S3 says that one is correct and must not change).** **Each of those must take its Stack identity from the authority the run already resolved — threaded, not re-derived.** **The pattern to copy is what `1a6ee68a` did for `freshness/index.ts`: read the compile state from the caller's env, not ambient.** **Not a new resolver call per site.** **Not a fork of the authority.** **Not a behaviour change to `tenant-db.ts:157`.** **Write the RED that shows a run whose Stack was resolved from the database still taking the file branch at `candidate-custody.ts:209`.** **The assertion is where the result lands, not an error message.** **Report the literal failure.** **And a touched-behaviour pin for each reader whose file branch is legitimately reachable in file mode** — **file mode must keep working, with a name, exactly as it does now.** **Never print a connection string, URL with userinfo, token, key, env value or model value.** **Do not read or edit `.env`. Do not contact `aks`. Do not push.** **Gate of record: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" corepack pnpm exec turbo run test --filter=//`; pre-commit the expected population BEFORE running it and compare against the run, not after.** **Base this branch on `031f84a0` — the branch is not merged and this work stacks on it.** **The suite has a known red on that base: five graph-retirement failures in row mode, T15, a row-store defect that cannot record a removal. Do not fix it and do not treat it as yours; report the population with and without those five.** The re-measured census · the RED literal · the threading on each reader · the file-mode pins · the full 40-char SHA · the gate counts against the pre-committed number, with T15's five named separately · and one sentence: does removing `AKS_STACK_ID` from `.env` now change any behaviour anywhere, and if not, what is still reading it.
```

L2 — Recovery note: the branch was found at `17ea3de1` — the merge base of `031f84a0`, **24 commits behind** (`git rev-list --count 17ea3de1..031f84a0`), with `stack-authority.ts` **absent** at that commit (verified: `git cat-file -e 17ea3de1:packages/wiki/src/dimensions/stack-authority.ts` fails) — and was moved to `031f84a0d42976922640c1efc755bb793b50ffc7` by `git merge --ff-only` (the harness refused `git reset --hard`), the branch carrying zero own commits and a clean tree. The catch-up diff the move applied is `156 files changed, 3286 insertions(+), 524 deletions(-)` (verified: `git diff --shortstat 17ea3de1 031f84a0`). The consequence for this document is that **the base it is written against is the authority-complete tree**: the module the other twenty sites consume exists here, and every anchor below is measured against it rather than inherited.

L3 — The four rulings, recorded because they decide T5, T7, S12 and the shape of the census report:

1. **The census is reported as three numbers, never one** (S9). One number cannot distinguish "how many mentions" from "how many decisions" from "how many defects", and the collapse recorded in L4 is only legible as three numbers moving together.
2. **The six get RED-then-fix and the three get a mechanical commit**, because "a RED that has to construct the omission is not observing a defect" (S10). The three are a latent hazard, and the honest remedy for a default nothing omits is a type error, not a behavioural test.
3. **The fork gets the measurement produced or the literal retained with evidence**, and "do not delete on reasoning alone" (S11). The comment's "four cycles, measured" is not re-measurable in this tree, so it is a reason to measure, never a reason to delete.
4. **`wiki-read-tools.ts:271` stays out of the fixes and inside the closing sentence** (S12). It is a test-only seam writing a string literal, not an S3 violation; naming it out of scope is required, silently dropping it is not permitted.

L4 — The measured evidence, produced on this branch at base `031f84a0` while writing this document. Every anchor below was read at its line, not inherited from the brief.

**The three census numbers.** **61** raw non-test hits (`git grep -c 'AKS_STACK_ID' -- 'packages/*' ':!*test*'`, summed: TypeScript source only — the same grep over the whole tree including `docs/`, `docker/` and `scripts/` yields 76). **19** consumer sites, each verified at its line and classified below. **9** defect-shaped inline readers, tabled below; under the narrower definition that excludes the 3 write sites and the 2 authority-chain sites, the non-write, non-authority population is **14** — the 9 readers plus 3 authority call-arguments, 1 fork and 1 lock threading, so the two figures measure different things and are reported together rather than as one. At the pre-reset head the same measurements were 76 / 37 / 32, so the collapse is real and is the effect of `fd8d61bf` landing the twenty sites: measured, that commit leaves **zero** `stackId === ""` guards in `compiler/index.ts` and `page-source-seam.ts` (the one remaining match in `compiler/index.ts` at `:1570` is a comment describing the guard that was removed).

**The nineteen, classified.**

| class | count | sites |
| --- | --- | --- |
| defect-shaped inline readers | 9 | table below |
| writes that must not change | 3 | `mcp/tenant-db.ts:157`, `services/ingest/ingest-env.ts:42`, `mcp/wiki-read-tools.ts:271` |
| legitimate authority call-arguments | 3 | `api/src/host/server.ts:208`, `dimensions/wiki/page-source-seam.ts:81` and `:484` |
| inside the authority chain | 2 | `dimensions/activation.ts:256`, `dimensions/stack-selection.ts:75` |
| the config-seam fork | 1 | `project-config-seam.ts:53` |
| threading a required `env` | 1 | `utils/lock.ts:307` |

**Already delegated and NOT to be re-touched.** `fd8d61bf` ("refactor(wiki,api): route the Stack guards through the resolved authority") converted 17 of the 19 sites the first brief named, in 4 files. `packages/wiki/src/compiler/index.ts` now resolves **once** at `:1103` and threads the result. `page-source-seam.ts` retains only `:81` and `:484` as authority *arguments*. No task in this document may reopen those sites.

**The nine defect-shaped readers with their ambient reach** (every call-site line verified):

| site | live reach |
| --- | --- |
| `compiler/candidate-custody.ts:209` | `candidateQueueIsRows()` called bare at `:217` and `:231` |
| `events/store-read.ts:440` | `eventsAreRowBacked()` called bare at `:211` and `:455` |
| `events/store-read.ts:240` | `readEventsFromRows()` called bare at `:281` |
| `events/store.ts:232` | `appendEventToRows(input)` at `:251` and `:278` |
| `linter/cache.ts:157` | `lintStackId()` called bare at `:189` |
| `utils/pending-embeddings.ts:329` | via `readMarkerFromRows(markerFile)` at `:299` and `writeMarkerToRows` at `:528`, `:544`, `:615` |
| `dimensions/wiki/activity-log-source.ts:25` | dead in-file — hazard only |
| `dimensions/wiki/candidate-source.ts:56` | dead in-file — hazard only |
| `dimensions/wiki/derived-artifact-source.ts:27` | dead in-file — hazard only |

**Reachability: none of the six live-reach modules can currently reach a resolved authority.** Verified signatures: `readEvents(root)` (`store-read.ts:280`), `prepareEventStoreForAppend(root)` (`store-read.ts:443`), `appendEvent(root, input)` (`store.ts:296`), `readLintCache(root)` (`linter/cache.ts:240`), `writeLintCache(root, summary)` (`linter/cache.ts:210`), `readPendingMarker(root)` (`pending-embeddings.ts:295`) — all take only `root`. `assertCandidateMutationAccess` (`candidate-custody.ts:239`) has **no production caller** (`git grep` finds only its declaration and one `odd/` document), so its signature changes without breaking a caller. `utils/lock.ts` acquires before resolution (`compiler/index.ts:362` versus `:1103`), recorded as the S13 exception.

**RED feasibility, so T1 cannot be blocked on infrastructure.** `StackAuthority` is a hand-buildable data union — precedent `test/stack-authority.test.ts:155`, where a case constructs `const settled: StackAuthority = { kind: "file", reason: NO_DATABASE_CONFIGURED };` — and `resolveStackAuthority({ stackId, env })` settles precedence 1 through `settledAuthority` without any `db`. The custody row branch is a pure early return at `:217`/`:230` touching no database, so **the headline RED needs no database at all**. The other five row branches dial Postgres; their database-free form is the refused-DSN precedent at `test/sdk/facade-lint-unreachable-db.test.ts:59` — a `REFUSED_DSN` constant pointing at a closed loopback port, its value deliberately not reproduced here because S6 forbids printing a URL with userinfo — asserted as `rejects.toThrow(/ECONNREFUSED/)` at `:84-85`.

**File-mode pin hazard, recorded as a finding.** Verified: `withFileMode` (`test/fixtures/file-mode.ts:160`) saves and blanks only `DATABASE_URL_ENV_VARS`. The six readers' existing file-mode pins therefore reach file mode by leaving `AKS_STACK_ID` **unset**, which is absence, not a named mode: precedence 1 beats file mode, so a leaked `AKS_STACK_ID` yields a `stack` authority even with the DSNs blanked and the pin stops testing what it says. Threading the authority makes file mode a **NAMED value** instead of an absence — which is the point, and also the reason each pin must be re-proved rather than assumed to still hold.

**T15, the known red, quoted from `odd/tasks/single-stack-authority.md:139`:** "The five red cases are `test/compiler/graph-retirement-port-invocation.test.ts` (1), `graph-retirement-retires-source.test.ts` (3) and `graph-retirement-tenant-scope.test.ts` (1)." Test **titles** are not recorded in that document, and this one does not invent them; T8 reports the five by file and count. The mechanism is named at `:43`/`:44`: "The row store structurally cannot record a removal." Nothing in that document says T15 blocks removing `AKS_STACK_ID`, so T8 treats the five as a named pre-existing loss and not as this branch's work.

**Pre-committed gate population at base `031f84a0`: 857 test files** — `git ls-files '*.test.ts'` = 681 under `test/`, 170 under `packages/`, 6 under `scripts/`. (The same grep without the `.ts` restriction returns 858 because it also matches `tsconfig.test.json`, which is a config file and not a test; the population T8 pre-commits is 857.) T8 compares the run's own summary against **857** and reports the failure population with and without T15's five.

**The fork's cycle, measured structurally.** `packages/wiki/src/dimensions/activation.ts:45-49` statically pulls `wiki/database.ts` → `store-dimension` → `source-projection` → `utils/source-writer` → `sources/selection` → `project/config.ts`, and the chain closes at `config.ts:141` with a **call-time** `await import(...)`. No dependency-cruiser or madge configuration exists in the tree, and the only crawl test (`test/module-graph-crawl.test.ts`) measures `vitest run`-related **parity**, not cycles — so the "four cycles" in the seam comment is unmeasured by anything in this repository, and T7 owns producing the number.

<!-- The three facts this document could not settle from the tree are listed here rather than guessed: the literal text of T15's five failing test TITLES (nothing in `odd/tasks/single-stack-authority.md` records them; measuring them requires running the three named files on the gate of record, which is T8's job); the dependency-cycle COUNT the seam comment asserts as "four" (UNMEASURED — a cycle measurement has to be built, since no cruiser or madge config exists); and the gate's own file/test counts on this base (UNMEASURED until T8 runs the gate of record, and deliberately pre-committed at 857 files rather than guessed). -->
