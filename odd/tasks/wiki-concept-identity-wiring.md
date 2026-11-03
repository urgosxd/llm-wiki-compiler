# wiki-concept-identity-wiring — put concept identity on the live compile path

## Goal

Make the compiled wiki stop splitting one concept into several pages. Today the
compile identifies every concept by `slugify(concept.concept)` alone
(`src/compiler/extraction-merge.ts:45`), so `"Vector DB"` and
`"Vector Database"` become two pages that describe one thing, while the module
that would fold them (`src/dimensions/wiki/concept-identity.ts`, plus the cosine
tiers in `concept-resolution.ts`) has no production caller at all.

The human has decided the pipeline is **connected, not deleted**, and has chosen
the tier order: **slug → cosine → rules**.

That order is a deliberate inversion of the current resolver. The cosine tier
becomes the primary authority for what the slug cannot settle, and the
deterministic rules demote to the fallback that resolves whatever cosine left
undecided — or everything, when embeddings are unavailable.

## Non-goals

- No change to what a concept name the wiki *displays*. The canonical name rule
  (incumbent, then confidence, then lexicographic) is untouched.
- No new embedding provider, model, or fingerprint axis.
- No change to `slugify` itself; page slugs keep their current format.
- No LLM call added by this change.
- Not the retrieval tokenizer bug (`src/utils/retrieval.ts:180`) or the
  `BASE_SCORE_WEIGHT` calibration. Both are real, both are out of this feature.

## Acceptance criteria

1. With an embedding port available, `resolveConceptIdentity` decides cosine
   matches before deterministic rules: a pair whose score clears the auto
   threshold groups at tier `auto` even when a rule would also have matched it.
2. With no port, or with a failing port, the deterministic rules still run and
   still merge what they can. Semantic grouping is an enhancement; its absence
   must never cost a merge the rules could make.
3. Thresholds and the reversible `review` band keep their current values and
   semantics. Connections made by cosine remain independently revocable.
4. `canonicalConceptKey` folds the plural of an acronym before consulting the
   acronym table, so `"APIs"` and `"API"` share one key.
5. Order independence holds: shuffling the input candidates produces identical
   groups, aliases, and pending aliases.
6. The compile calls the resolver exactly once per run, through
   `src/compiler/identity-stage.ts` (`applyConceptIdentity`), NOT through
   `extraction-merge.ts`. That stage rewrites the extractions' concept names
   before any consumer derives a slug, so `mergeExtractions` stays synchronous,
   takes no plan, and still groups correctly. The progress denominator is the
   single merged list returned by `runGenerationStage`, so it cannot count pages
   the run never writes.
7. `npx tsc --noEmit` clean; `npx vitest related` over the touched files green.

## Owned contract

This feature crosses a surface boundary. `src/compiler/**` is a contract
`sharedPath`; `src/dimensions/wiki/**` is owned by `orchestrator-a`.

- `orchestrator-a` owns: `src/dimensions/wiki/concept-*.ts`,
  `test/dimensions/wiki-*`, this task document.
- `orchestrator-main` owns the wiring inside `src/compiler/extraction-merge.ts`
  and `src/compiler/index.ts`, and performs it under `unrestrictedWrite`.

No file is written by two sessions. The compiler side consumes the resolver as a
published function; it does not reach into the wiki dimension's internals.

## Tasks

- [x] **1. Invert the tier order in `resolveConceptIdentity`.**
  Run the cosine tier over every pair the exact-slug tier left undecided, then
  apply the deterministic rules to whatever the cosine tier left undecided. Keep
  the two-threshold policy, the per-member `joinedBy` evidence routing, and the
  incumbent-first canonical name rule exactly as they are.
  Files: `src/dimensions/wiki/concept-resolution.ts`.
  Note: this rewrites the expectation at
  `test/dimensions/wiki-concept-resolution.test.ts:74-81`, which today asserts
  `tier === "normalized"` for a pair a stub port would score as `auto`. That
  assertion encodes the OLD order and must move to the new one, not be deleted.

- [x] **2. Guarantee the rules are the fallback, not the loser.**
  When no port is supplied, or when the port reports a degradation, the
  deterministic tier must still run to completion and the returned
  `ConceptResolution` must still carry its groups and aliases. Prove it with a
  test that asserts a rule-only merge survives next to a reported
  `embeddings-unconfigured`.
  Files: `src/dimensions/wiki/concept-resolution.ts`,
  `test/dimensions/wiki-concept-resolution.test.ts`.

- [x] **3. Fix the acronym/plural order in `canonicalConceptKey`.**
  Stem the token first, then look the stem up in `ACRONYM_EXPANSIONS`, so
  `"APIs"` folds to `application programming interface` like `"API"` does.
  Today the raw token is looked up, misses `"apis"`, and only then gets stemmed —
  a plural acronym never expands.
  Files: `src/dimensions/wiki/concept-identity.ts`,
  `test/dimensions/wiki-concept-identity.test.ts`.

- [x] **4. Publish one resolver entry point the compiler can call.**
  Export a single function from the wiki dimension that takes extracted concepts
  and returns, per canonical name, the group id plus the inputs the merge needs.
  Keep it pure and sync-agnostic: it may be async, but it must not import the
  compiler.
  Files: `src/dimensions/wiki/concept-resolution.ts` (or a small adapter beside
  it), `test/dimensions/wiki-*`.

- [x] **5. Wire the resolver into the compile.**
  Done by `orchestrator-main` on branch `feat/wiki-concept-identity-wiring`,
  branched from this branch's tip, NOT from main — the seam does not exist in
  main.

  The implementation lives in `src/compiler/identity-stage.ts`,
  `src/compiler/extraction-identity.ts`, `src/compiler/index.ts` and
  `src/compiler/orphan.ts`, with tests in `test/compile-concept-identity.test.ts`
  and `test/compiler/extraction-identity.test.ts`. **Name those files and that
  branch, not a commit hash**: a hash in a document becomes a lie the moment the
  branch is rebased or squashed, and nothing in the repository can detect it. The
  hashes that existed when this feature was finished were `604db54` (the wiring)
  merged with this branch's doc correction into `d7c4297`, and this branch was
  fast-forwarded onto it, so `feat/orchestrator-a` and
  `feat/wiki-concept-identity-wiring` agreed at that moment.

  **It was NOT implemented as this task first described.** The original plan was
  “make `mergeExtractions` async, or inject the plan at `index.ts:224`”. Both were
  too narrow, and the reason is worth keeping: a concept's slug is the page
  filename, the chunk-embedding key, the link target and the unit of ownership
  persisted in `SourceState.concepts`, so SIX places derive it. Grouping only
  inside the merge would write the page under the canonical slug while ownership
  still recorded the alias, so the next run would schedule the wrong owners and
  lose the alias's evidence silently — invisible, and worse than the bug this
  feature set out to remove.

  What landed instead: one resolution per run, applied to the extractions
  themselves before any consumer runs (`src/compiler/identity-stage.ts`,
  `applyConceptIdentity`). After `bindConceptsToCanonicalNames` a folded name no
  longer exists in the run, so every downstream `slugify` lands on the canonical
  slug for free. That is why `mergeExtractions` stayed sync and argument-free.
  The seam is consumed as published: `planConceptMerge`, positionally aligned,
  `concept`→`name` with `summary`, `tags` and `confidence` passed through
  (`src/compiler/extraction-identity.ts`, `toMergePlanCandidate`).

  Additional behaviour beyond the original task, and why it is needed:
  - A page left under a folded name has no producer, so it is marked `orphaned`
    (marked, never deleted — same convention as deletion, so a wrong merge stays
    reversible by a human). Without it the motivating case ends with two files on
    the second run.
  - A folded concept keeps its evidence, takes the canonical name and is marked
    `is_new: false`; only the canonical record decides newness.

- [x] **6. Verify end to end and close.**
  Verified independently by this session against the wiring tree (see task 5 for
  why that is named by branch rather than by hash), not taken on report:
  `npx tsc --noEmit` exit 0; the 18 pipeline tests
  (`test/compile-concept-identity.test.ts`, `test/compiler/extraction-identity.test.ts`)
  pass and assert exactly the two halves that can fail silently — ONE page per
  synonym pair, a denominator equal to the generated set, and ownership recorded
  under the canonical slug rather than the alias; this branch's 63 concept tests
  still pass with the compiler wiring in place. The tree was re-verified AFTER this
  branch was fast-forwarded onto the merged wiring branch: `npx tsc --noEmit`
  exit 0 and 81 tests across the five concept and pipeline suites green, so the
  claim describes what this branch actually contains, not what a peer reported.

## Evidence

- Work unit on this branch: `feat(wiki): rank concept similarity above the
  normalization rules`. It touches only `orchestrator-a`'s owned paths —
  `src/dimensions/wiki/**` and `test/dimensions/wiki-*`. (Cited by subject, not by
  hash, for the reason given in task 5.)
- `npx tsc --noEmit` exit 0 after every task.
- `npx vitest run test/dimensions/wiki-concept-{resolution,identity,merge-plan,aliases,embeddings}`
  → 80 passed, 0 failed.
- `npm run test:affected` → 707 files passed, 4 failed / 5196 passed, 7 failed.
  The 7 were `test/mcp/{unknown-stack-refusal,stack-id-guard,read-page-registry,multi-stack-addressing}`.
- A THIRD failure appeared later: `test/okf-mcp-stdio.test.ts` (1 of 4). It was
  absent from this session's earlier selection because that run never included
  the file.

### CORRECTION — these failures are NOT pre-existing, and not ours either

Calling them "pre-existing" was wrong, and wrong in a way that hid a real fact. The
earlier check (`git stash`, re-run at the same commit) only proved they are not
caused by THIS feature. It could not prove they predate it, and they do not.

`main` has already found and fixed them. This branch was cut before that work and
is BEHIND `main`, so it does not carry the fixes:

- `test(config): seed the worker database URL instead of letting it default to
  production` — states the cause outright: production reads a MISSING
  `AKS_DATABASE_URL` as the vendored default `postgresql://aks:aks@localhost:5432/aks`,
  so "seven tests across the four mcp suites were failing that way, and the stackId
  guard took the blame" — a `ECONNREFUSED` on the wrong port, which reads like a
  product bug in whatever the suite was testing.
- `test(fixtures): point spawned CLI at a committed corpus, not the operator's .env`
  — the MCP stdio subprocess inherited the operator's real `.env` because the SDK
  passes only a handful of variables.

Measured, same worktree, same commit:

| Tree | Result on the four mcp suites |
| --- | --- |
| `main` (`1f5d5de`, checked out detached in this worktree) | 12 passed, 0 failed |
| this branch at the wiring's parent, wiring absent | 7 failed |
| this branch at `db2fd00`, wiring present | 7 failed |

So the worktree is not the variable and the wiring is not the variable: the COMMIT
is. These are upstream-fixable environment failures this branch simply lacks.

Also observed: the failure SET is not stable across runs of the same tree. Three
runs of converged `db2fd00` produced 8, 8 and 7 failures, and the 8-failure runs
each carried one DIFFERENT extra victim (`okf-mcp-stdio`, then
`viewer-sidebar-label-collision`). Both of those pass in isolation. So the extra
failure is load-dependent flakiness on top of the 7 deterministic ones — which is
why a single `test:affected` number is not sufficient evidence that nothing broke,
and why two sessions can honestly report the same count and different contents.

None of this is caused by the concept-identity work.

### RESOLVED — rebased onto main, tree now fully green

The branch was rebased onto `main` (base `1f5d5de`) and the prediction above held
exactly: every one of those failures disappeared without a single code change from
this feature. Measured on the rebased tree:

- `npm run test:affected` → **715 files passed (715), 5239 tests passed (5239), 0
  failed**. Previously 5 files and 8 tests were failing.
- `npx tsc --noEmit` → exit 0.
- `npm run build` → success (ESM + DTS).
- `npx fallow` → 0 above threshold, maintainability 90.7.
- The 81 concept and pipeline tests → all green.

That is the strongest available confirmation that the failures were the branch's
distance from `main` and not this feature: a history rewrite with zero source
changes fixed them.

**Method lesson, worth more than the fix.** "Reproduces at the same commit with the
change stashed" does NOT establish that a failure is pre-existing — it only
establishes that the change is not its cause. To call a failure pre-existing you
must test a tree that does not contain your work's ancestry at all, such as `main`.
Two sessions reported this wrong, in the same words, for several turns, because
they used the same weak check.

**Second lesson.** A single `test:affected` count is not evidence. Three runs of the
same converged tree produced 8, 8 and 7 failures with two different extra victims,
both of which pass in isolation. Only after the rebase did the count become
reproducibly zero.
- `npx fallow` → 0 above threshold, maintainability 90.7 (good), no dead code,
  no duplication.
- Implementation finding worth keeping: the rule tier originally kept running over
  pairs the cosine tier had already merged. `unionCandidates` takes
  `min(rank)`, so a `normalized` re-join (rank 1) overwrote an `auto` merge
  (rank 2) and reported the group as `normalized` — the rules silently reclaiming
  authority. Fixed by excluding scored pairs from the rule pass, and covered by a
  test asserting tier `auto` for a pair a rule could also fold.
- Layout check: `concept-resolution.ts` is 536 lines total but ~296 code lines
  excluding comments, inside the 400-line rule in `AGENTS.md`.
- Bootstrap review turn: `npx tsc --noEmit` exit 0.
- `npx vitest run test/dimensions/wiki-concept-{resolution,identity,embeddings,aliases}`
  → 69 passed, 0 failed.
- Proved the dead path by execution: `slugify` maps `"Vector DB"`/`"Vector Database"`
  to two slugs, and `canonicalConceptKey` maps `"APIs"`/`"API"` to two DIFFERENT
  keys — the acronym/plural defect in task 3.

## Agreed contract

Unset. Any shared interface this feature requires must be recorded here verbatim
as `path@version` once agreed with the peer role.
