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

**The `utils/lock.ts` site, and the correction T6 forced on this section.** `utils/lock.ts` removes its ambient default and **threads the env its caller holds**; its key derivation is unchanged — `stackIdOf`-by-env → `realpath(root)` fallback, one identity wherever it is looked up. What this section used to say about the ordering is **inverted by T6** and is recorded here in its corrected form, because a premise that stays inverted is a premise a future reader will "restore": it said *"No authority can exist at that point, by construction — the lock is what makes the resolution safe to perform"*, and that is no longer true of this tree. Measured now: `compileAndReport` resolves at `packages/wiki/src/compiler/index.ts:389` (`const stackAuthority = await resolveStackAuthority({ env, db: dimensionsDb.db });`) and locks at `:399` (`const locked = await acquireMutationLock(root, "ordinary", { env: stackEnv });`), so **the lock no longer covers the resolution**, and what makes the resolution safe is its own idempotent provisioning — `services/stacks/default-stack.ts:76-79`, the `insert into stacks (name, domain) … on conflict (domain) do nothing`. **The cost, recorded plainly rather than hidden:** a contended run now performs that idempotent write before it refuses, and a database-configured run with no resolvable Stack raises `StackAuthorityError` instead of returning `busy: true` — a configuration fault outranking contention, which is the intended direction, because a run that cannot name its tenant has a worse problem than a peer holding the lock. The key is the Stack's on every path for a mechanical reason worth keeping: the env passed to acquire and to release is the run's own `stackEnv`, the same object in both calls, so the two cannot derive different keys.

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

**S15 is CLOSED by T9, and observed.** A database-resolved compile now leaves `wiki/index.md` and `wiki/MOC.md` **absent from disk while writing both derived rows**: proven in `test/compile-resolved-stack-published.test.ts` by `expect(filesWritten(root)).toEqual([])` at `:158`, and by the revert probe reproducing `expected [ 'log.md', 'wiki/index.md', …(1) ] to deeply equal []`. The split was never in these two functions' logic; it was in the env they were handed, and publishing the resolved id at the boundary is what reunites the scan and the write.

**S16 — the lock was a concurrency defect, and it ships in this branch fixed by T6.** Measured BEFORE the fix: `acquireMutationLock` ran at `packages/wiki/src/compiler/index.ts:362`, **before** the authority resolved at `:1114`, so the lock key fell back to `realpath(root)` (`utils/lock.ts:330`, `lockKeyFor`) and `databaseUrlFor` (`utils/lock.ts:345`) returned `undefined` — because it refuses a DSN without a Stack — which made `acquireDatabaseLock` (`lock.ts:277`) return `undefined` and sent the acquisition down the **file** path. **No advisory lock was attempted at all** on a database-resolved compile. After T6 the ordering inside `compileAndReport` is resolve `:389` → lock `:399` → release `:430`, and the env the lock receives is the run's own `stackEnv`; the pre-fix anchors `:362`/`:1103`/`:1114` are kept here as the measurement's own coordinates, not as current line numbers.

The framing, quoted: "a lock that silently does not happen reads exactly like a lock held."

Required fix direction, recorded so a worker does not invent a third shape: **resolution must happen before the lock is taken, or the lock must re-key once the authority is known.** A key that is computed from an environment the resolution has not yet written into is a key for the wrong Stack.

It also corrects an earlier reading in this document: "concurrency is permitted by the database, not validated, because only `pg_try_advisory_lock` guards it" was **optimistic** if the lock is never attempted on the CLI path. That measurement assumed the advisory lock was reached; S16 measures that on a database-resolved compile it is not reached at all.

**Status: FIXED and independently verified** — T6, `8085696bfc58057a661838bfcfe949cb7574726d`, verdict S16 **VERIFIED** (L10). One residual is recorded there rather than claimed as covered: nothing empirically pins the unsafe-journal row-mode release path.

## Tasks

- [x] **T1** — candidate custody leads: RED (a row-resolved run must not demand a candidate DIRECTORY) then thread the authority through `candidate-custody.ts` → `candidates.ts` → `review-pipeline.ts` → `compiler/index.ts` · S1,S2,S4,S10,S13 — worker then independent verify — commit: `c6366b95aae2e170a195cbce35359be22626ae6f` — `Risk: item 3` (changes internal function contracts consumed across the compiler)
- [x] **T1b** — require the resolved authority at the delete entry points and pin the file branch's acceptance path · S1,S4,S10,S13 — worker — commit: `4908d962539816f7af4c985ce7450442076d895e` (`refactor(candidates): require the resolved authority at the delete entry points`) — `Risk: item 3`
  The S13 correction written above is this task's whole content: remove the `UNRESOLVED_AUTHORITY` default from `deleteCandidate` (`candidates.ts:114`) and `deleteCandidateBySlug` (`:154`) so omission is a type error, and add the pin the independent verification found missing — the file branch's **acceptance** path, not only its refusal, so a wrong-polarity branch cannot stay green.
  **Shipped** as `4908d962`, which is also the commit that added `test/candidate-custody-authority-ambient-disagreement.test.ts`. Both defaults are gone, so the shape S13 permits tomorrow is closed at the two entry points that carried it.
- [x] **T2** — pending-embeddings: thread from `finalizeWiki` (`compiler/index.ts:1816`) down through `utils/embeddings-refresh.ts`, `utils/embeddings-retry.ts`, `utils/pending-embeddings.ts` · S1,S4,S10,S13 — worker then independent verify — commit: `5a7d5f7de69c892aa199e9283807f847be167895` — `Risk: item 3`
  **Outcome.** The last ambient-Stack reader on the compile path now takes the run's own environment. Measured on HEAD before the change: `markerStackId(env: NodeJS.ProcessEnv = process.env)` at `pending-embeddings.ts:329` and its callers one level out omitting the argument (`readMarkerFromRows(markerFile)` and the three `writeMarkerToRows(...)` calls), reached from `finalizeWiki` → `safelyUpdateEmbeddings` → `refreshEmbeddingsDrainingPending` → `readPendingMarker`. A database-resolved compile therefore drained and wrote `.llmwiki/pending-embeddings.json` while every other seam on that path took the row branch.
  **Shape: thread the env the compile already derived.** `finalizeWiki` already receives the run's `stackEnv` (T9) and now hands it to `safelyUpdateEmbeddings(root, slugs, env, …)` → `refreshEmbeddingsDrainingPending(…, env)` → `EmbeddingRetry` (held for the whole lifecycle) → the marker helpers. **No new ambient default:** the three inner defaults were REMOVED (`markerStackId`, `readMarkerFromRows`, `writeMarkerToRows` now REQUIRE `env`), so an omission further in is a type error, and exactly ONE `process.env` read remains in `pending-embeddings.ts` — `markerEnv(env)` (`:349`), the single, named fallback for callers with no resolved Stack of their own. No second `resolveStackAuthority` anywhere (`compiler/index.ts` keeps its one import and its one call).
  **Signature churn, counted.** The public helpers have **100 test call sites across 10 pre-existing test files** (`loadPendingEmbeddings` 52/7, `writePendingEmbeddings` 36/9, `clearPendingEmbeddings` 4/2, `loadEmbeddingRetry` 3/1, `refreshEmbeddingsDrainingPending` 5/3) plus 10 production call-site lines. Making `env` required there would have rewritten all of them and they are outside this task's surfaces, so the design is: `env` is REQUIRED on the path the compile threads and OPTIONAL only at the public boundary, in the trailing position, with the fallback named once. **The compile path never relies on it** — the affected suites were run (below) and the focused RED case proves the row branch is taken with `AKS_STACK_ID` absent.
  **RED, observed before the fix** (`test/compile-pending-embeddings-resolved.test.ts:147`):

  ```text
  AssertionError: expected [ 'concepts/pending-marker-topic' ] to include 'concepts/earlier-run'
  ```

  i.e. the refresh core received only this run's fresh page id: the page queued in the Stack's rows by an earlier run was never read, and the run recorded its retry state in the file marker instead. **GREEN after the fix**: `2 passed (2)`.
  **File mode pinned by name** (`usePerCaseFileMode` + `withFileMode`), green before AND after: with no database configured the same compile records the changed page id in `.llmwiki/pending-embeddings.json` and no row is touched — a FILE authority publishes nothing, so the pin also proves the threading is conditional.
  **Assertions are where the result LANDED:** the Stack's marker is read through the marker STORE (`readRefreshMarkers`), never through the helpers under test, and the file marker's absence is asserted separately, so the run cannot pass by writing both backends.
  **Evidence:** focused `test/compile-pending-embeddings-resolved.test.ts` RED literal above then GREEN `2 passed (2)`; prior slices `test/compile-resolved-stack-published.test.ts`, `test/compile-advisory-lock-signature.test.ts`, `test/compile-candidate-seam-resolved.test.ts`, `test/compiler/compile-busy-signal.test.ts` → `9 passed (9)`; `vitest related packages/wiki/src/utils/pending-embeddings.ts --run` → `Test Files 3 failed | 151 passed (154)`, `Tests 5 failed | 755 passed (760)`, the five being exactly T15's (1 / 3 / 1 in the three `graph-retirement` files); `tsc --noEmit` clean; `typecheck:tests` "1634 files checked; 238 baseline diagnostics in 86 files; no regression"; `fallow:ci` "0 dead-code, 0 complexity, 0 duplication introduced since main (verdict pass)"; lint "1714 files scanned; 558 baseline violations in 396 files across 423 rule/file entries; no regression".
  **S# covered: S1, S4, S10, S13, S14.** `mcp/tenant-db.ts`, `dimensions/stack-authority.ts`, `utils/lock.ts` and every dimension seam are untouched.
  **Commits:** the fix is `5a7d5f7de69c892aa199e9283807f847be167895`; the document update that recorded it is `557dd56d` (`docs(odd): record T2's commit in the feature document`), which changes no source.
- [ ] **T3** — **DOWNGRADED — reachability VERIFIED, therefore not implemented.** Neither T3 nor T4 is reachable from the compile path: "no compiler module imports the linter", and `appendEvent`/`appendEventLocked` (`events/store.ts:296`, `:242`) have no production caller. Both statements re-checked at this branch's HEAD; the ambient read at `events/store.ts:232` therefore never decides anything a compile does. **Not to be implemented until a production path is found** — a reader nothing calls is documented, not threaded. · S5 — worker — commit: none (no code changes) — `Risk: item 3` (only if the reachability check authorises a fix; the verification itself is read-only)
- [ ] **T4** — **DOWNGRADED — reachability VERIFIED, therefore not implemented.** Same measurement as T3, re-checked at HEAD: "no compiler module imports the linter", so `linter/cache.ts` (ambient read at `:157`) is not on the compile path. **Not to be implemented until a production path is found.** · S5 — worker — commit: none (no code changes) — `Risk: item 3` (only if the reachability check authorises a fix; the verification itself is read-only)
- [x] **T5** — the three seams whose omission happens at the OUTER boundary: these are **not** latent hazards. The measured fact, quoted: "the compile's env is `options.env ?? process.env` with no resolved id merged in", so `candidate-source.ts:55` (consumed at `:91` by `withCandidateSource`), `activity-log-source.ts:45` and `derived-artifact-source.ts:26` (consumed at `:50`) all take the FILE branch in a database-resolved compile. S10's framing is corrected with this quote: "the default being dead in-file is not evidence the omission cannot happen, because the caller one level out is the caller who omits." · S1,S5 — worker — commit: `5943b0fb407afc4e6a122788c2727627bdac374d` (`fix(compile): reach the candidate seam through the published Stack`) — `Risk: item 3`
  **Outcome — the candidate seam, which is the outer consumer T9 could not observe.** T9 published the resolved id into the env handed downstream and proved it at the journal and the derived artifacts; it recorded explicitly that "nothing on the compile path calls `withCandidateSource` (its callers are the review/approve delete and read entry points), so this task has no evidence for it in either direction". That claim was **wrong about the compile path and right about the seam**: the page-generation boundary hands `deleteCandidateBySlug` a **second** environment, re-derived from `options.env ?? process.env` at `review-pipeline.ts:66`, so the publication never reached it. Measured before this task: duplicate-candidate search and deletion ran against `.llmwiki/candidates` on a database-resolved compile, and the Stack's `wiki.review_candidates` row survived the live write that superseded it.
  **Shape: thread, do not re-resolve.** The published `stackEnv` (the one `compileAndReport` derives ONCE at the resolution) is now threaded into the generation stage as `GenerationStageInput.stackEnv` → `generatePagesPhase` → `generateMergedPage`. `review-pipeline.ts` no longer computes an environment at all, and its `options: CompileOptions` parameter was **removed** rather than kept: the ONLY thing it read from those options was `options.env`, so nothing else in that file reads an env and nothing else in it read `options`. The file keeps one env parameter and it now receives the PUBLISHED one (the seam under it selects its backend from that env and opens a connection with it), while `authority` remains what the custody branch reads — one resolution, two transports of one answer.
  **Same reader, one stage earlier.** `collectPendingSourceStates` read the pending queue through `listCandidates(root)`, which falls back to `process.env`; the caller now passes the published env (`listCandidates(root, {}, env)`). `listCandidates` already carried an optional `env` parameter, so **no signature changed**: it has 6 production callers (`compiler/index.ts`, `import/okf-collision.ts`, `citations/answer-index.ts` and three internal ones in `candidate-read.ts`, plus ~35 test call sites), and only the compile path's one had the published env to give it.
  **RED, observed before the fix**, in `test/compile-candidate-seam-resolved.test.ts` — the row case, at `:127:62`:

  ```text
  FAIL  test/compile-candidate-seam-resolved.test.ts > a compile that resolved its Stack from the database > clears the duplicate in the Stack's row queue and writes no candidate file
  AssertionError: expected [ { …(10) } ] to deeply equal []
  ```

  where the surviving element is the planted `candidate-seam-topic-row` — the duplicate the run's own live write superseded, still pending in the Stack after the compile. **GREEN after the fix**: `2 passed (2)`.
  **File mode pinned by name, and it was green both before and after the fix**: with no database configured the same compile clears the same duplicate out of `.llmwiki/candidates` and adds no candidate row — a FILE authority publishes nothing, so the pin also proves the publication is conditional. It is a PRESERVE case, not a RED: file mode was never broken, which is what S4 asks a pin to prove.
  **Reachability measured, not assumed.** S13's ban on a second resolution is respected: no `resolveStackAuthority` call was added (`git grep` shows one in `compiler/index.ts`, in `compileAndReport`). `dimensions/wiki/candidate-source.ts` was **not** edited — the seam keeps its env read and only the VALUE it receives changed. `mcp/tenant-db.ts`, `dimensions/stack-authority.ts` and `utils/lock.ts` are untouched.
  **Evidence:** focused `test/compile-candidate-seam-resolved.test.ts` RED literal above then GREEN `2 passed (2)`; prior slices `test/compile-resolved-stack-published.test.ts`, `test/compile-advisory-lock-signature.test.ts`, `test/compiler/compile-busy-signal.test.ts` → `7 passed (7)`; the candidate suites (`candidate-namespace-final9`, `candidate-deletion-final11`, `review-candidate-lifecycle`, `review-candidate-durability`) → `31 passed (31)`, none of T15's five among them; the two suites that share the changed code and were not named by the task (`compile-request-stack-candidate-env`, `compile-candidate-preflight`) → `11 passed (11)`; `tsc --noEmit` clean; `typecheck:tests` "1633 files checked; 238 baseline diagnostics in 86 files; no regression"; `fallow:ci` "0 dead-code, 0 complexity, 0 duplication introduced since main (verdict pass)"; lint "1713 files scanned; 558 baseline violations in 396 files across 423 rule/file entries; no regression".
  **S# covered: S1, S2, S13, S14.** S2's headline is now fixed on BOTH halves — custody (T1) and the source seam (this task) — and S14's third seam is reached from the compile path at last. **Left open deliberately:** the stale docstring in `test/compile-request-stack-candidate-env.test.ts` still says "`generateMergedPage` resolves the request env ONCE", which is no longer where the env comes from; that file is outside this task's edit surfaces and its ASSERTIONS are unaffected (all 7 stay green), so the sentence is reported rather than rewritten.
- [x] **T6** — lock, and it was a concurrency defect measured at its worst severity: `acquireMutationLock` ran at `compiler/index.ts:362` **before** the authority resolved at `:1114`, so the lock key fell back to `realpath(root)` and `databaseUrlFor` (`utils/lock.ts:345`) returned `undefined` — **no advisory lock was attempted on a database-resolved compile.** Fixed at `:389` → `:399` → `:430` (resolve → lock → release). Quoted: "a lock that silently does not happen reads exactly like a lock held." Fix direction per S16: **resolution must happen before the lock is taken, or the lock must re-key once the authority is known**; the ambient default goes from `releaseLock`/`acquireLock`/`acquireLockBlocking` and the env each caller already holds is threaded at the six omitting call sites · S1,S13,S16 — worker then independent verify — commit: `8085696bfc58057a661838bfcfe949cb7574726d` (`fix(compile): key the mutation lock on the resolved Stack`) — `Risk: item 4` (concurrency) and `item 3`
  **Outcome. Shape chosen: RESOLVE-BEFORE-LOCK, not publish-earlier.** The resolution moved out of `runCompilePipeline` and into `compileAndReport`, before `acquireMutationLock`, and its value is THREADED in as `{ stackAuthority, stackEnv }`. Why this shape over the acceptable alternative: the two are the same ordering, and the pipeline cannot keep a second resolution, so the only real question was whether to re-key the lock after the fact — which would mean releasing a lock and re-acquiring it, i.e. a window in which the Stack is unlocked. Measured: `compiler/index.ts` now contains exactly ONE `resolveStackAuthority` call (it was at `:1130` in the pipeline; it is now in `compileAndReport`) and ZERO in `runCompilePipeline`. `utils/lock.ts` and `utils/mutation-lock.ts` were NOT changed: no signature moved, so `acquireLock`, `acquireLockBlocking`, `releaseLock` and `acquireMutationLockBlocking` keep their behaviour for the events/trust/embeddings/query-publication call sites (S16 requirement 3), and the fix is entirely "what env the compile passes".
  **Acquire and release receive the SAME OBJECT.** One `const stackEnv` in `compileAndReport`, handed to `acquireMutationLock(root, "ordinary", { env: stackEnv })` and to `releaseLock(root, stackEnv)` in the `finally` — not a re-derived copy, so the two cannot disagree about the key. `test/mutation-lock-env-release.test.ts` (4 cases, green) is the existing pin for that agreement.
  **The cost, recorded rather than hidden.** Resolution now precedes the journal-recovery gate, so a run with an UNSAFE journal resolves (and may provision the default Stack) before refusing. The refusal itself is unchanged — same `JournalUnsafeError`, nothing written, no lock left held — but the property "an unsafe journal refuses before any lock is taken and before anything is provisioned" is **UNTESTED**: `test/compile-marker-ordering.test.ts:113-128` asserts the rejection and that no state/page was written, and asserts nothing about the lock or about provisioning. Stated plainly rather than claimed as covered.
  **The boundary flip, recorded as EVIDENCE.** The fix flipped `test/compiler/compile-busy-signal.test.ts` from green to red: its contention case held the per-root PATH lock while the compile, in a worker that seeds a database, now locks on the RESOLVED Stack — so the path lock no longer contends. That file's own docstring declares its subject ("The lock is contended here through the real filesystem lock, because that is the only contention that matters"), and it was reaching that lock only because its environment happened to name no Stack while a database was configured — the same implicit-mode drift as T9's three config cases. It now declares file mode BY NAME (one bare `import "../fixtures/file-mode.js"`, its documented form) with **every `expect` byte-identical**, and both its cases stay green — including the negative pin ("does not set busy on a run that acquired the lock"), which is not vacuous: the pipeline really ran under the acquired path lock. Row-mode contention is pinned in `test/compile-advisory-lock-signature.test.ts`, so both lock backends stay covered with no duplication. **This flip is the proof the lock key really changed**, not an incident.
  **Location:** `packages/wiki/src/compiler/index.ts` — `compileAndReport`, immediately after the dimensions handle is opened; helper `stackEnvWith(env, authority)`; new `ResolvedStackRun` value threaded into `runCompilePipeline`.
  **Evidence:** focused `test/compile-advisory-lock-signature.test.ts` RED literal `AssertionError: expected undefined to be true // Object.is equality` then GREEN `3 passed (3)`; the five lock suites `35 passed (35)`; T9 `test/compile-resolved-stack-published.test.ts` `2 passed (2)`; `tsc --noEmit` clean; `typecheck:tests` "1631 files checked; 238 baseline diagnostics in 86 files; no regression"; lint "1711 files scanned; 558 baseline violations in 396 files across 423 rule/file entries; no regression".
- [ ] **T7** — the forked literal at `project-config-seam.ts:37`: produce the missing cycle measurement, then either move the constant to a leaf module both sides import or retain the literal WITH that measurement as evidence · S11 — worker then independent verify — commit: pending — `Risk: item 3`
  **Where it stands, measured at HEAD, and why it stays open.** The cycle is **REAL as a module-graph dependency**: the closing edge is a call-time dynamic `import()` at `packages/wiki/src/project/config.ts:141` (`const { readStackProjectConfig } = await import("../dimensions/wiki/project-config-seam.js");`), reached from the static chain through `dimensions/activation.ts` → `wiki/database.ts` → the store → `source-writer` → `sources/selection` → `project/config.ts`. And **no cycle gate exists in the tree** — `git ls-files | grep -iE 'madge|dependency-cruiser'` returns nothing — so the "four cycles, measured" in the seam's own comment is still unverifiable by anything this repository runs. **Verdict: the fork is RETAINED with its measurement, and cannot be proved removable today.** Nothing in it is a defect the operator experiences: the literal is correct on the compile path (the run publishes the resolved id into the env this seam reads) and the FILE config on the eight other `loadSourceSelection`-without-env paths.
- [x] **T8** — the gate: pre-commit the population, run the gate of record, and write the closing sentence naming every remaining reader · S6,S7,S8,S12 — verify — commit: this pass's document commit (`docs(odd): close the T11 census with the gate, the surface and the answer`; a commit cannot hold its own SHA) — `Risk: none`
  **Delivered.** The population was pre-committed at **862** and the run collected **861**; the full numbers, the delta and its arithmetic are in **L13**, recorded verbatim rather than paraphrased. Split against T15: `Test Files 3 failed | 853 passed | 5 skipped (861)` and `Tests 5 failed | 6427 passed | 12 skipped (6444)`, the five failures being `graph-retirement-port-invocation.test.ts` (1), `graph-retirement-retires-source.test.ts` (3), `graph-retirement-tenant-scope.test.ts` (1) — **zero failures outside them**. The closing sentence is **L14**, quoted verbatim.
- [x] **T9** — publish the resolved authority into the env the downstream seams receive, at the compile boundary — the same mechanism `mcp/tenant-db.ts:157` uses and S3 blesses — so CLI and SDK compiles stop degrading to the file backend · S1,S4,S7,S8,S14,S15 — worker then independent verify — commit: `54bfa67762c75e89af5e596f9e897f6d66da1866` (RED/pin pin `2cf4c358f5346a7220c426a3d2b7fae1fcecbede`) — `Risk: item 3`
  **Outcome.** `stackEnv` is derived ONCE after the resolution at `compiler/index.ts:1128` and every consumer below it takes that value: `resolvePageSeams`, `detectChanges`, `forgetDeletedSources`, `logCompile`, and `seedThenFinalize` (which reaches `regenerateIndices`). A `file` authority publishes nothing, so file mode stays bit-identical. The six seams keep their signatures; no second `resolveStackAuthority`, no second precedence, `tenant-db.ts` untouched. **Confirmed by observation, not by reading:** the journal seam (`log.md` on disk and no activity-log row before, the row and no file after) and the derived-artifact seam (`wiki/index.md` + `wiki/MOC.md` on disk before — S15's split, scan from rows and write to disk — both renders as rows and no file after). The candidate seam (`candidate-source.ts:55`) was NOT observed flipping: nothing on the compile path calls `withCandidateSource` (its callers are the review/approve delete and read entry points), so this task has no evidence for it in either direction. **S15 is CLOSED by the publication, and the evidence is the suite itself:** before the fix the row-resolved compile left `log.md`, `wiki/index.md` and `wiki/MOC.md` on disk (RED: `expected [ 'log.md', 'wiki/index.md', …(1) ] to deeply equal []`); after it, no file exists and both derived renders are rows of the Stack the run resolved — the scan and the write now agree because both are handed the same environment. The residual is structural only: `generateIndex`/`generateMOC` still decide their write backend from the env they are given rather than from the scan source, so a future caller that hands them a resolved authority WITHOUT the id in its env would split the pair again — none does today, because the compile now publishes and the other two callers (`query-save`, `okf-refresh`) pass no authority and let the seam resolve from the same env.
  **The boundary flip, recorded as EVIDENCE.** Publishing at the boundary flipped THREE pre-existing cases from green to red, in `test/project-config-review-key-refused.test.ts` (2) and `test/compile-hold-policy-retired.test.ts` (1). The cause was the config seam (`dimensions/wiki/project-config-seam.ts:53`) finally reading the Stack's `wiki.project_config` row instead of the checkout's `.llmwiki/config.json` in a database-resolved compile. **That flip is the proof S14 reached the config seam** — the three cases plant a retired `review` key in the FILE and expect the refusal, so they assert the file backend and were passing only while the compile kept reading the checkout. They were therefore adapted to declare file mode by name (`withFileMode`, `test/fixtures/file-mode.ts`, declared per case because both files also have a case that must keep its environment) with every assertion unchanged; no sibling case was touched. The row-mode counterpart of that refusal is pinned at the selection level (`loadSourceSelection` with a mocked `readProjectConfig`), not through a full compile — recorded as an observation, deliberately not widened here.
  **Location:** `packages/wiki/src/compiler/index.ts`, immediately after the resolution at `:1114` — the resolved id is published into the env handed downstream, instead of each seam learning a new signature.
  **Ruled (L8): publish at the boundary, NOT S1-literal.** S1 as written is satisfied by this shape: "Transport by env is not derivation: the seam reads the authority's answer instead of asking the variable." Threading the value into six seam signatures would satisfy a stricter reading that was never intended, for the mechanical reason quoted in L8: "MCP, host and job already transport the resolved id through env … Threading the value into six seams would give one fact two transports, chosen by entry point. … One transport, or none."
  **Consequences to record:** the six seams need no signature change; the SDK (`sdk/core.ts:86,116`) is fixed for free; and the CLI path stops silently running the file backend. Its result must also state whether it fixed S15's split backend (rows in, disk out) or left it open as a named defect.
  **Verdict on S15: CLOSED**, observed in `test/compile-resolved-stack-published.test.ts` (`expect(filesWritten(root)).toEqual([])`) against the revert probe's `expected [ 'log.md', 'wiki/index.md', …(1) ] to deeply equal []`.
- [ ] **T10** — **the lock-before-resolve pattern, enumerated.** Five known instances, and **this branch fixes NONE of them**. The one that matters is the ingest WRITE path: `services/ingest/service.ts:240` acquires via `tryWithOrdinaryMutationLock` and resolves its Stack at `:242`, **inside the lock** — so the race is over `document_chunks`, page rows and KG writes taken under a key that was never the Stack. That is **a tenant-isolation question, not a tidiness one**, and it is the reason this task exists at all. The other four take the lock without resolving a Stack at all: `import/run.ts:145`, `trust/executor.ts:303`, `events/store.ts:297`, `utils/embeddings.ts:61`. S16 by analogy — worker then independent verify — commit: pending — `Risk: item 4` (concurrency)
  **State explicitly: the lock-before-resolve pattern survives on the ingest write path after this branch fixed it on the compile path,** and it must not close with this branch. T6 moved the ordering for `compileAndReport` and for nothing else: `tryWithOrdinaryMutationLock` keys on the env it is handed before any authority exists, so an ingest that resolves a Stack from a database writes under a lock keyed by `realpath(root)`. The four no-resolution sites are the same shape with a weaker consequence — nothing there pretends to key on a Stack — and they are listed so nobody mistakes the census for closed.
- [x] **T11** — **DESIGN RECORD, not a task to implement.** `POST /api/compile` (`packages/api/src/host/api.ts:452`) takes **no per-request Stack**, so it can only run on the ambient environment; it was the most wrong of the surviving surfaces and the least visible — a compile route with nobody to ask. What it resolves to now, measured: on a database-configured project it reaches **precedence 2** and resolves the **DEFAULT Stack** (`dimensions/stack-authority.ts:176` → `defaultStackOrRefuse`, provisioning `DEFAULT_STACK_DOMAIN` through `services/stacks/default-stack.ts:76-79`). **The design statement, recorded in these terms: a route that cannot name a Stack is a route whose tenant comes from configuration**, and an operator should read that rather than discover it. No code change is prescribed here; the record exists so the next person to ask "which tenant does `POST /api/compile` serve?" finds the answer written down instead of inferring it from a missing argument.

### Sequencing

**T1 first.** It proves the shape and needs no database: the custody row branch is a pure early return, so the headline RED is observable without Postgres and the pattern the other seven tasks copy is settled before any of them spends a runner.

**T2 runs SEQUENTIALLY with T5, T6 and T9, never in parallel with them.** It touches `packages/wiki/src/compiler/index.ts`, and so do T6 and T9, so they are overlapping writers on one file; one writer at a time, in the order T9 → T2 → T6 → T5. T3 and T4 are out of that queue entirely since the downgrade below: they are read-only reachability checks until a production path is found.

**T6 no longer follows T3.** That ordering existed because both touched `events/store.ts`; with T3 downgraded to a reachability check, nothing writes that file before T6, and the sequencing constraint it imposed goes with it.

**T1b before T2**, because it is the second half of what T1 opened and leaves the delete entry points in the same shape as the rest of the custody chain before another reader copies the defaulted form.

**T3/T4 are blocked on reachability.** Neither leaves the downgrade until a production path to it is found; a reader nothing calls is documented, not threaded. Reachability was re-checked at this branch's HEAD and found unchanged, so they carry no commit and are not pending work.

**T10 is out of this branch's queue, deliberately and permanently.** It is the same shape T6 fixed, on the ingest write path, and it is recorded here because the census is not closed while it survives. It must not be folded into this branch's close: it is `Risk: item 4` with a tenant-isolation consequence, and T6's evidence does not reach it.

**T11 is a design record and enters no queue at all.** Nothing in it is actionable now; it is the written answer to a question the missing argument used to leave to inference.

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

L9 — **The owner's ruling on the flip T6 produced**, quoted verbatim from its reply, because it decides an edit surface and a rejected alternative that must not be re-opened:

> "Authorized: **option (2)**. Add `test/compiler/compile-busy-signal.test.ts` to your allowed edit surfaces."
>
> "that file's own docstring declares its subject — \"The lock is contended here through the real filesystem lock, because that is the only contention that matters.\" It was reaching the path lock only because its environment happened to name no Stack while a database was configured, which is the same implicit-mode drift as the three config cases in T9. Declaring file mode aligns the file with what it says it tests."
>
> "Option (1) is rejected: it would make a database-free file database-backed to preserve a premise the file never claimed, it would add a `perRunDatabase` skip path to a suite that needs none, and the row-mode contention case is ALREADY pinned by your own `test/compile-advisory-lock-signature.test.ts` — both backends stay covered with no duplication. Option (3) is rejected: a regression we caused does not go into an expected-failures list."

The guardrails it set are recorded in T6's Outcome: mode declaration only, every assertion byte-identical, both cases green including the negative pin, and the flip recorded as evidence that the lock key changed.

L10 — **T6 and T5, and the independent verdicts.** Two outcomes, both moving a claim this document had made.

**T6 — `8085696bfc58057a661838bfcfe949cb7574726d`**, `fix(compile): key the mutation lock on the resolved Stack`. The resolution moved before the lock inside `compileAndReport`: resolve `:389`, publish `:390`, lock `:399`, release `:430`. One resolution for the whole run; acquire and release receive **one `stackEnv` object**, not two derivations of it, so they cannot disagree about the key; and the dimensions handle is closed on **every** path — including a resolution that refuses before any lock exists. **RED, observed when the fix is neutralised** (`test/compile-advisory-lock-signature.test.ts:103`):

```text
AssertionError: expected undefined to be true
```

**Verdicts: S1 VERIFIED · S13 VERIFIED · S16 VERIFIED.** The three together say the thing worth recording: the resolution is single and threaded, the reader boundary takes the value rather than asking the variable, and the lock is keyed on the Stack the run resolved.

**T5 — `5943b0fb407afc4e6a122788c2727627bdac374d`**, `fix(compile): reach the candidate seam through the published Stack`. **RED**, observed before the fix, with the planted candidate surviving the compile that had just superseded it:

```text
expected [ { …(10) } ] to deeply equal []
```

`review-pipeline.ts` no longer computes an environment at all — its `options: CompileOptions` parameter was removed rather than kept, because `options.env` was the only thing it read — and it now receives the published one. `listCandidates`' signature is unchanged (it already carried an optional `env`), with **6 production callers**, so the fix reached the one caller that had a resolved answer to give. T5's own independent verdicts are not recorded in this entry: this pass was given T6's three and does not invent others.

L11 — **T2 — `5a7d5f7de69c892aa199e9283807f847be167895`**, `fix(embeddings): drain the pending marker of the Stack the run resolved`. **RED literal**, observed before the fix at `test/compile-pending-embeddings-resolved.test.ts:147`:

```text
AssertionError: expected [ 'concepts/pending-marker-topic' ] to include 'concepts/earlier-run'
```

The failure is the defect in one line: a marker row queued by an **earlier run** was invisible, because the marker helpers took the **file** branch — a row-backed run drained its own page and wrote its retry state to disk. **Design:** `env` is REQUIRED on the threaded path (`finalizeWiki` → `safelyUpdateEmbeddings` → `refreshEmbeddingsDrainingPending` → `EmbeddingRetry` → the marker helpers) and OPTIONAL, in the trailing position, only at the public boundary, with `markerEnv` (`utils/pending-embeddings.ts:348-349`) the **sole remaining ambient read in `pending-embeddings.ts`**.

**Two residuals, recorded rather than rounded away.** (1) The public helpers keep `env` optional because they have **~100 test call sites across 10 files outside this task's surface** — so a **FUTURE** compile-path caller could still omit it and type-check; the type system now protects the inside of the path, not the boundary of it. (2) `import/okf-refresh.ts` still calls `refreshEmbeddingsDrainingPending(root, pageIds)` at `:52` **without** an env, so the OKF import keeps reading the ambient environment for the marker. Neither is reachable from a compile; both are named so the next census inherits them and does not re-discover them.

L12 — **The surviving surface, and the CLI's death.** The surface this feature had to reason about was smaller than the brief assumed, and the reason matters more than the count.

**The CLI is gone, and it was gone before this branch started.** `packages/wiki/src/commands/compile.ts` was deleted by `fec50896 refactor(cli)!: remove the CLI and the eighteen commands it reached`, which is an **ancestor** of this branch (`git merge-base --is-ancestor fec50896 HEAD` → true). Measured at HEAD: zero `"bin"` entries in any `package.json`; no CLI package (`packages/` holds `api`, `foundation`, `llmwiki-kg`, `wiki`); **no `--stack` option definition** — the string survives only inside comments that describe a command line nobody can type any more (`dimensions/stack-selection.ts:15`, `services/stacks/resolve-stack.ts:16`); and a guard test, `test/no-removed-cli-adverts.test.ts`, keeps the adverts from coming back. The single in-tree launcher is `dist/api.js` (`tsup.config.ts:118`), with subcommands `host` and `serve` only (`packages/api/src/main.ts`).

**The five reachable compile surfaces**, each verified at its call:

| surface | anchor | what it can name |
| --- | --- | --- |
| SDK | `packages/wiki/src/sdk/core.ts:116` | `CreateWikiOptions.env` — may omit the Stack |
| host ingest | `packages/api/src/host/api.ts:411` | `buildIngestEnv(request.stackId)` (`:399-411`) |
| `POST /api/compile` | `packages/api/src/host/api.ts:452` | **nothing per request** (T11) |
| MCP tool | `packages/wiki/src/mcp/tools.ts:120` | `withRequestEnv(stackId, …)` |
| ingest job | `packages/wiki/src/services/ingest/jobs/run.ts:216` | `buildIngestEnv(input.stackId)` (`:260`) |

**The three DEAD entry points, named so nobody counts them** as surfaces: `compile()` (`compiler/index.ts:299`), `compileRecompiling()` (`:326`) and `compileDelta()` (`compiler/delta.ts:63`) — **no importer in the tree**, and none of the three is its own entry in the published `exports` map (`packages/wiki/package.json:12-32`); `compileDelta` lives in a module that map does not publish at all, while `compile`/`compileRecompiling` sit inside the module published as `./compiler`, so "dead" here means exactly "no in-tree caller".

**The corrected reach.** The pre-T9 degradation affected the **SDK** — when `CreateWikiOptions.env` omits the Stack — plus **`POST /api/compile`**, which has no per-request Stack at all. It never affected MCP or the host/ingest surfaces, because those already injected through `withRequestEnv` and `buildIngestEnv`. That correction is the one to carry forward: three surfaces were already correct and two were not, which is a different shape from "the CLI and the SDK".

**Ordering confirmation, measured in source:** `:389` resolve → `:399` lock → `:430` release, all inside `compileAndReport` (`packages/wiki/src/compiler/index.ts:342`) — and **every one of the five reachable surfaces calls `compileAndReport`**, so no surface can enter below the resolution any more.

L13 — **The gate of record, with the pre-committed population.** Pre-committed **before** the run: **862** test files. **Collected: 861.** The one-file delta is `test/sdk/packaging.test.ts` — tracked, and excluded by the repo's own `vitest.config.ts:82` — so `862 tracked − 1 excluded = 861 collected`, the 862 being this branch's 857 at base plus the 5 test files its commits had added by then.

**Result, verbatim:**

```text
Test Files  3 failed | 853 passed | 5 skipped (861)
Tests  5 failed | 6427 passed | 12 skipped (6444)
Tasks: 0 successful, 1 total
```

(the turbo line as emitted). **The five failures, named separately:** `graph-retirement-port-invocation.test.ts` (1), `graph-retirement-retires-source.test.ts` (3), `graph-retirement-tenant-scope.test.ts` (1) — **exactly T15, and zero failures outside them.** Database present; nothing skipped for lack of one; `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` never set.

**Re-measured at this pass's HEAD, and reconciled rather than asserted.** The tree now tracks **863** test files: the base's `857` plus **six** added on this branch — `test/candidate-custody-authority.test.ts` (T1), `test/candidate-custody-authority-ambient-disagreement.test.ts` (T1b), `test/compile-resolved-stack-published.test.ts` (T9), `test/compile-advisory-lock-signature.test.ts` (T6), `test/compile-candidate-seam-resolved.test.ts` (T5), `test/compile-pending-embeddings-resolved.test.ts` (T2). `863 − 1 excluded = 862` collectable, so a re-run at HEAD should collect **862**: the gate's 861 reflects a tree one file smaller, and the file it is short of is T2's, which landed after the run. A different reading — that the run saw all six and silently did not collect one — cannot be excluded from here without re-running the gate, which this documentation pass did not do.

**Named gaps, not glossed.** (1) `test/sdk/packaging.test.ts` was **never executed** by the gate, before or after this branch. (2) **Nothing empirically pins the unsafe-journal row-mode path**: the advisory lock release there is source-confirmed (`:411` try → `:419` `JournalUnsafeError` → `:430` release in the `finally`), not observed.

L14 — **The deliverable's answer, quoted verbatim, one paragraph:**

> "Removing `AKS_STACK_ID` from `.env` no longer changes behaviour on any compile surface: `compileAndReport` resolves the Stack once (`compiler/index.ts:389`) and publishes that answer into one environment (`:390`/`:456`) that every seam below consumes, so custody, the journal, the derived artifacts, the candidate queue and its seam, the lock key and the pending-embeddings marker all serve the Stack the run resolved. What still reads the variable: `dimensions/wiki/project-config-seam.ts:53` through a forked literal at `:37` (correct on the compile path, the file config on eight other `loadSourceSelection`-without-env paths); `events/store.ts:232` and `events/store-read.ts:240,440`; `linter/cache.ts:157` — none of the last two reachable from the compile; and `utils/pending-embeddings.ts`'s optional boundary plus `import/okf-refresh.ts`. And `mcp/wiki-read-tools.ts:271` still spells the variable as a bare string literal in a test-only seam in production code, which S12 keeps out of scope but inside this sentence."

<!-- Two facts this document still does not settle from the tree, listed here rather than guessed: the literal text of T15's five failing test TITLES (nothing in `odd/tasks/single-stack-authority.md` records them; L13 reports the five by file and count, which is what the gate printed); and the dependency-cycle COUNT the seam comment asserts as "four" (UNMEASURED — a cycle measurement has to be built, since no cruiser or madge config exists). The gate's file/test counts and its population delta, previously listed here as unsettled, are measured in L13. -->
