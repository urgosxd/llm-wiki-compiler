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
6. The compile calls the resolver exactly once per run, and both call sites of
   `mergeExtractions` (`src/compiler/index.ts:224` and `:680`) observe the same
   grouping, so the progress denominator equals the real page count.
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

- [ ] **5. BLOCKED — wire `mergeExtractions` to the resolver.**
  Owner: `orchestrator-main`, under `unrestrictedWrite`. Outside
  `orchestrator-a`'s ownedPaths; the contract hook refuses an edit from this
  session and should. Requires:
  - `mergeExtractions` becomes async, or the resolver result is injected by the
    caller at `src/compiler/index.ts:224`.
  - The `:680` progress-denominator call site must consume the SAME grouping.
  - `ExtractedConcept.concept` (`src/utils/types.ts:79`) maps to
    `ConceptCandidate.name`; `summary` and `tags` map directly.
  Blocked until orchestrator-main accepts the `work_request`.

- [x] **6. Verify end to end and close.** (partial: blocked on task 5 for the true end-to-end)
  `npx tsc --noEmit`, `npm run test:affected`, and a compile over a corpus with
  a known synonym pair, asserting one page instead of two.

## Evidence

- Work-unit commit `bf9f47d` — `feat(wiki): rank concept similarity above the
  normalization rules`. Touches only `orchestrator-a`'s owned paths.
- `npx tsc --noEmit` exit 0 after every task.
- `npx vitest run test/dimensions/wiki-concept-{resolution,identity,merge-plan,aliases,embeddings}`
  → 80 passed, 0 failed.
- `npm run test:affected` → 707 files passed, 4 failed / 5196 passed, 7 failed.
  The 7 failures are PRE-EXISTING: reproduced identically at HEAD with this work
  stashed (`test/mcp/{unknown-stack-refusal,stack-id-guard,read-page-registry,multi-stack-addressing}`).
  They are outside this feature and were not caused by it.
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
