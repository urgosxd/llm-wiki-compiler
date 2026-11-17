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

> **Measured correction (L6).** The canonical shape is **required-at-the-boundary**, and T1 shipped two defaulted authority params: `deleteCandidate` (`packages/wiki/src/compiler/candidates.ts:114`) and `deleteCandidateBySlug` (`:154`), both defaulting to `UNRESOLVED_AUTHORITY` (`candidates.ts:76`), which is a file-branch constant — `const UNRESOLVED_AUTHORITY: StackAuthority = { kind: "file", reason: NO_DATABASE_CONFIGURED };`. The independent verification rated S13 **PARTIAL** for exactly that reason, and **T1b closes it.**

**S14 — a row-resolved compile must not degrade to the file backend.** The measured statement, quoted verbatim: "the compile's env is `options.env ?? process.env` with no resolved id merged in".

Three seams are proven to take the FILE branch because of it, each read at its line in a database-resolved compile:

| seam | the reader | the file-branch decision |
| --- | --- | --- |
| `dimensions/wiki/candidate-source.ts:55` | `candidateStackId(env: NodeJS.ProcessEnv = process.env)` | consumed at `:91` by `withCandidateSource` |
| `dimensions/wiki/activity-log-source.ts:45` | `journalStackId(env)` | consumed by `withJournalSource` |
| `dimensions/wiki/derived-artifact-source.ts:26` | `artifactStackId(env: NodeJS.ProcessEnv = process.env)` | consumed at `:50` by `withDerivedSource` |

Two further readers are **unreachable from the compile** and therefore are not instances of S14: `events/store*` and `linter/cache.ts`. Their unreachability is recorded under T3 and T4 as a downgrade, not as a fix.

Note on the anchor: an earlier transcription of this measurement wrote `derived-artifact-source.ts:116`. That file is 63 lines long, so the anchor is corrected here to the lines actually read — `:26` for the reader and `:50` for the decision.

**S15 — a named defect of its own: a split backend inside a single function.** `generateIndex` (`compiler/indexgen.ts:42`) and `generateMOC` (`compiler/obsidian.ts:116`) scan **rows** when they are given a row-backed `PageScanSource`, which they receive together with the authority through `regenerateIndices` (`dimensions/wiki/page-source-seam.ts:291-299`; the `authority?: StackAuthority` option at `:294`, threaded at `:299`) — and then write `index.md` / `MOC.md` **to disk** whenever `withDerivedSource` hands them `undefined`: `indexgen.ts:73` → `atomicWrite` at `:80`, `obsidian.ts:134` → `atomicWrite` at `:140`, both reached through `derived-artifact-source.ts:50`.

That is one function reading one backend and writing another. It is a named defect with a downstream obligation attached: **T9 may fix it, and the T9 result must state whether it did** — it must not be left implied by the commit. If publishing the authority into the env does not fix it, it stays open as this named defect.

**S16 — the lock is a concurrency defect and it ships in this branch.** Measured: `acquireMutationLock` runs at `packages/wiki/src/compiler/index.ts:362`, **before** the authority resolves at `:1114`, so the lock key falls back to `realpath(root)` (`utils/lock.ts:330`, `lockKeyFor`) and `databaseUrlFor` (`utils/lock.ts:345`) returns `undefined` — because it refuses a DSN without a Stack — which makes `acquireDatabaseLock` (`lock.ts:277`) return `undefined` and sends the acquisition down the **file** path. **No advisory lock is attempted at all** on a database-resolved compile.

The framing, quoted: "a lock that silently does not happen reads exactly like a lock held."

Required fix direction, recorded so a worker does not invent a third shape: **resolution must happen before the lock is taken, or the lock must re-key once the authority is known.** A key that is computed from an environment the resolution has not yet written into is a key for the wrong Stack.

It also corrects an earlier reading in this document: "concurrency is permitted by the database, not validated, because only `pg_try_advisory_lock` guards it" was **optimistic** if the lock is never attempted on the CLI path. That measurement assumed the advisory lock was reached; S16 measures that on a database-resolved compile it is not reached at all.

## Tasks

- [x] **T1** — candidate custody leads: RED (a row-resolved run must not demand a candidate DIRECTORY) then thread the authority through `candidate-custody.ts` → `candidates.ts` → `review-pipeline.ts` → `compiler/index.ts` · S1,S2,S4,S10,S13 — worker then independent verify — commit: `c6366b95aae2e170a195cbce35359be22626ae6f` — `Risk: item 3` (changes internal function contracts consumed across the compiler)
- [ ] **T1b** — require the resolved authority at the delete entry points and pin the file branch's acceptance path · S1,S4,S10,S13 — worker — commit: pending — `Risk: item 3`
  The S13 correction written above is this task's whole content: remove the `UNRESOLVED_AUTHORITY` default from `deleteCandidate` (`candidates.ts:114`) and `deleteCandidateBySlug` (`:154`) so omission is a type error, and add the pin the independent verification found missing — the file branch's **acceptance** path, not only its refusal, so a wrong-polarity branch cannot stay green.
- [ ] **T2** — pending-embeddings: thread from `finalizeWiki` (`compiler/index.ts:1816`) down through `utils/embeddings-refresh.ts`, `utils/embeddings-retry.ts`, `utils/pending-embeddings.ts` · S1,S4,S10,S13 — worker then independent verify — commit: pending — `Risk: item 3`
- [ ] **T3** — **DOWNGRADED — verify and document the reachability, fix only if a production path is found.** Neither T3 nor T4 is reachable from the compile path: no compiler module imports the linter, and `appendEvent`/`appendEventLocked` (`events/store.ts:296`, `:242`) have no production caller. **Not to be implemented until the reachability check finds one.** · S5 — worker — commit: pending — `Risk: item 3` (only if the reachability check authorises a fix; the verification itself is read-only)
- [ ] **T4** — **DOWNGRADED — verify and document the reachability, fix only if a production path is found.** Same measurement as T3: no compiler module imports the linter, so `linter/cache.ts` is not on the compile path. **Not to be implemented until the reachability check finds one.** · S5 — worker — commit: pending — `Risk: item 3` (only if the reachability check authorises a fix; the verification itself is read-only)
- [ ] **T5** — the three seams whose omission happens at the OUTER boundary: these are **not** latent hazards. The measured fact, quoted: "the compile's env is `options.env ?? process.env` with no resolved id merged in", so `candidate-source.ts:55` (consumed at `:91` by `withCandidateSource`), `activity-log-source.ts:45` and `derived-artifact-source.ts:26` (consumed at `:50`) all take the FILE branch in a database-resolved compile. S10's framing is corrected with this quote: "the default being dead in-file is not evidence the omission cannot happen, because the caller one level out is the caller who omits." · S1,S5 — worker — commit: pending — `Risk: item 3`
- [ ] **T6** — lock, and it is a concurrency defect measured at its worst severity: `acquireMutationLock` runs at `compiler/index.ts:362` **before** the authority resolves at `:1114`, so the lock key falls back to `realpath(root)` and `databaseUrlFor` (`utils/lock.ts:345`) returns `undefined` — **no advisory lock is attempted on a database-resolved compile.** Quoted: "a lock that silently does not happen reads exactly like a lock held." Fix direction per S16: **resolution must happen before the lock is taken, or the lock must re-key once the authority is known**; the ambient default goes from `releaseLock`/`acquireLock`/`acquireLockBlocking` and the env each caller already holds is threaded at the six omitting call sites · S1,S13,S16 — worker then independent verify — commit: pending — `Risk: item 4` (concurrency) and `item 3`
- [ ] **T7** — the forked literal at `project-config-seam.ts:37`: produce the missing cycle measurement, then either move the constant to a leaf module both sides import or retain the literal WITH that measurement as evidence · S11 — worker then independent verify — commit: pending — `Risk: item 3`
- [ ] **T8** — the gate: pre-commit the population, run the gate of record, and write the closing sentence naming every remaining reader · S6,S7,S8,S12 — verify — commit: pending — `Risk: none`
- [ ] **T9** — publish the resolved authority into the env the downstream seams receive, at the compile boundary — the same mechanism `mcp/tenant-db.ts:157` uses and S3 blesses — so CLI and SDK compiles stop degrading to the file backend · S1,S7,S8 — worker then independent verify — commit: pending — `Risk: item 3`
  **Location:** `packages/wiki/src/compiler/index.ts`, immediately after the resolution at `:1114` — the resolved id is published into the env handed downstream, instead of each seam learning a new signature.
  **Ruled (L8): publish at the boundary, NOT S1-literal.** S1 as written is satisfied by this shape: "Transport by env is not derivation: the seam reads the authority's answer instead of asking the variable." Threading the value into six seam signatures would satisfy a stricter reading that was never intended, for the mechanical reason quoted in L8: "MCP, host and job already transport the resolved id through env … Threading the value into six seams would give one fact two transports, chosen by entry point. … One transport, or none."
  **Consequences to record:** the six seams need no signature change; the SDK (`sdk/core.ts:86,116`) is fixed for free; and the CLI path stops silently running the file backend. Its result must also state whether it fixed S15's split backend (rows in, disk out) or left it open as a named defect.

### Sequencing

**T1 first.** It proves the shape and needs no database: the custody row branch is a pure early return, so the headline RED is observable without Postgres and the pattern the other seven tasks copy is settled before any of them spends a runner.

**T2 runs SEQUENTIALLY with T5, T6 and T9, never in parallel with them.** It touches `packages/wiki/src/compiler/index.ts`, and so do T6 and T9, so they are overlapping writers on one file; one writer at a time, in the order T9 → T2 → T6 → T5. T3 and T4 are out of that queue entirely since the downgrade below: they are read-only reachability checks until a production path is found.

**T6 no longer follows T3.** That ordering existed because both touched `events/store.ts`; with T3 downgraded to a reachability check, nothing writes that file before T6, and the sequencing constraint it imposed goes with it.

**T1b before T2**, because it is the second half of what T1 opened and leaves the delete entry points in the same shape as the rest of the custody chain before another reader copies the defaulted form.

**T3/T4 are blocked on reachability.** Neither leaves the downgrade until a production path to it is found; a reader nothing calls is documented, not threaded.

**Nothing in T2/T5/T6 starts until T9's ruling lands, because the ruling may subsume them.** The ruling has landed (L8): T9 is unblocked as *publish at the boundary*, and that shape subsumes the three outer-boundary seams T5 names (they stop receiving an env with no id) and silently relieves the SDK path, which is why **T9 runs before T2, T5 and T6 in practice** — those tasks must measure what is still broken *after* the boundary publishes, not before it. S16 remains T6's own defect even so: publishing into the env does not move the lock, which is taken before resolution exists.

**T9 is blocked no longer** (L8 dissolved the ruling gate) and is the last entry in this list only because it is the newest; it is first in execution order.

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

L5 — **T1 executed.** The evidence, recorded literally because ODD needs the observation and not a summary of it:

- **RED**, observed before the fix, at `test/candidate-custody-authority.test.ts:60:70`:

  ```text
  AssertionError: promise rejected "CandidateCustodyUnavailableError: candida…" instead of resolving
  ```

  caused by `CandidateCustodyUnavailableError: candidate custody is unavailable` thrown from `assertMutationTargetWritable` — a row-resolved run demanding a candidate **DIRECTORY**, which is S2's defect landed where S2 says to assert it.
- **GREEN**: `2 passed (2)` on the focused file.
- **File-mode pin**: `13 passed` — file mode still works, with a name.
- **`tsc`**: clean.
- **Lint**: "1708 files scanned; 558 baseline violations in 396 files across 423 rule/file entries; no regression".
- **Related run**: `5 failed | 1255 passed (1260)`, all five being T15 — the named pre-existing red of S6, reported separately and not treated as this branch's work.
- **Commit**: `c6366b95aae2e170a195cbce35359be22626ae6f` — `fix(custody): branch on the resolved authority, not ambient AKS_STACK_ID`, 5 files, `170 insertions(+), 25 deletions(-)`.

L6 — **Independent verification of T1, and the three findings it produced.** The verdicts, per spec: **S1 VERIFIED · S2 PARTIAL · S4 PARTIAL · S10 VERIFIED · S13 PARTIAL.**

The findings, kept because each one names a defect a green test suite was hiding:

1. **`candidate-source.ts:55/91` still decides from env**, so a database-resolved run never reaches its rows: S2's custody fix does not travel with the candidate *source*, and S2 is therefore half-fixed rather than fixed. This is the finding that produced S14.
2. **T1's pin proves only the file branch's refusal, never its acceptance**, so a wrong-polarity branch stays green. A pin that only observes one direction of a two-way branch is a pin on prose.
3. **This feature document recorded no RED literal and no commit at the time of verification** — an ODD tracking failure, and the one this Log entry repairs. The failure is recorded rather than absorbed: the verification caught the tracking gap, not the other way round.

What it also verified, as mitigation rather than as absolution: **no production caller omits the authority.** `deleteCandidate` has **zero** production callers; `deleteCandidateBySlug` has **one**, at `review-pipeline.ts:73`, and it passes `authority`. The 17 test call sites across 9 files that omit it are all file-mode tests. So the defaulted parameter T1b removes is not a live omission today — it is a **shape** that permits one tomorrow, which is exactly the distinction S13's correction records.

L7 — **The env-propagation measurement, and the plan it forced.** Measured on this branch: **`DOES NOT INJECT`.**

- `packages/wiki/src/compiler/index.ts:1109` — `const env = options.env ?? process.env;` — and the authority resolved from that env at `:1114` is **never merged back** into it. Every seam downstream receives the env the caller passed, which knows nothing about a Stack the database resolved.
- The three entry points that **do** inject, and therefore never see this degradation: `mcp/tools.ts:120` → `tenant-db.ts:157` (`{ ...process.env, [AKS_STACK_ID_ENV_VAR]: stackId }`); `api/host/api.ts:399-411` → `buildIngestEnv`; `services/ingest/jobs/run.ts:260-273` → `buildIngestEnv`.
- The broken paths are therefore the **CLI** and the **SDK**: `sdk/core.ts:86` (`const env = options.env ?? process.env;`) and `:116` (`compileAndReport(root, { ...opts, env, dimensionsPort: options.dimensionsPort })`) forward an env without injecting the resolved id. A compile reached from either one resolves a Stack from the database and then runs the file backend.
- `services/ingest/ingest-env.ts:41` — `if (stackId === undefined) return process.env;` — degrades to the ambient environment when no Stack is named, which is why the three injecting entry points are correct only for the entry points that always name one.
- **The split-backend finding**: `generateIndex`/`generateMOC` scan rows and then write `index.md`/`MOC.md` to disk — one function, two backends, named as S15.

This measurement **contradicts the primary fix shape recorded in S13** (thread a required authority value through each reader's signature): the same end is reached by publishing the authority's answer into the one transport the seams already read. The decision taken from it is L8's, and T9 carries it.

L8 — **The ruling, folded in once.** Recorded here rather than by recasting L7, because L7 is the measurement and this is the decision taken from it. This is the single application of the ruling to this document; it is not to be restated elsewhere.

**Decision: T9 is UNBLOCKED. Publish at the boundary, NOT S1-literal.**

Two reasons, quoted:

- "Transport by env is not derivation: the seam reads the authority's answer instead of asking the variable." S1 as written is **satisfied** by this shape. The record to keep straight: this is **not a reversal of S13 and not a deviation from it** — **S13's provisional framing was superseded by a correct reading of S1.** S1-literal (threading the value into six seam signatures) would satisfy a stricter reading that was never intended, and writing it down that way is what keeps a future reader from "restoring" it.
- "MCP, host and job already transport the resolved id through env … Threading the value into six seams would give one fact two transports, chosen by entry point. … One transport, or none." The mechanical reason, and the decisive one: a second transport does not add safety, it adds a way for two entry points to disagree about the same fact.

Three corrections carried by the same ruling:

1. **The split backend is named as its own defect (S15).** It is not folded into the env measurement, and T9's result must state whether it fixed it.
2. **The `candidate-source.ts` correction is accepted** — finding (a) of L6 stands as measured, S2 is half-fixed, and T9 is the shape that closes it rather than a second fix of its own.
3. **The events/linter downgrade is accepted** — T3 and T4 become reachability verification (S5) and are not implemented unless a production path is found.

The lock correction from the same ruling is recorded in S16 and carried by T6: `acquireMutationLock` at `:362` runs before the authority at `:1114`, so no advisory lock is attempted on a database-resolved compile.

<!-- The three facts this document could not settle from the tree are listed here rather than guessed: the literal text of T15's five failing test TITLES (nothing in `odd/tasks/single-stack-authority.md` records them; measuring them requires running the three named files on the gate of record, which is T8's job); the dependency-cycle COUNT the seam comment asserts as "four" (UNMEASURED — a cycle measurement has to be built, since no cruiser or madge config exists); and the gate's own file/test counts on this base (UNMEASURED until T8 runs the gate of record, and deliberately pre-committed at 857 files rather than guessed). -->
