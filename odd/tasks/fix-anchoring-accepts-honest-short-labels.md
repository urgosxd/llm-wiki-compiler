# Fix: the anchoring rule flattens honest links, and admits one wrong target

Branch `fix/anchoring-accepts-honest-short-labels`, base `main` = `054e6b16a627cc812fcc5d1454fb3b39d8730d35`.
Scope: `packages/wiki/src/compiler/link-anchoring.ts` and its tests. Large change, tracked here.

## Specs

S1. The defect, measured. `isAnchored` (via `namesTarget`) requires a wikilink's visible label to canonicalise to the target's full title or a declared alias. Of 953 links demoted as `unanchored` across both live stacks, 915 (96.0%) are leading-segment prefixes of the target's own title — `BR-DW-15` → `BR-DW-15: Feedback visual` (497), `Breadth-First Search` → `Breadth-First Search (BFS)` (175), `PDF` → `PDF Preview in Document Workspace`. 10 suffix, 1 contiguous substring, 9 same-tokens-reordered, 15 shares-one-token. 3 (0.31%) share no distinctive token. An independent blind reimplementation reproduced 953 and judged 913 honest · 37 vague-but-not-wrong · 2 wrong.

S2. Relaxation. Accept a label that is a token-contiguous run of the target's title or a declared alias — leading segment, trailing segment, or interior run — using the gate's own canonical tokenisation (`canonicalConceptKey`, which plural-stems and expands acronyms). Word-bounded. Exact strings required by the request: "Accept a label that is a token-contiguous run of the target's title or a declared alias" · "Do not invent a new tokeniser" · "a raw-token matcher reports 11 wrong cases where the canonical domain reports 3".

S3. Reordered tokens stay refused. Required string: "Do not accept reordered tokens (the 9 cases). A reordered label is not a contiguous run — it is a different claim". A reordered label must remain demoted.

S4. Ambiguity is measured, not guarded. Required strings from the requirement change: "Do not ship the contiguity guard" · "its failure mode — re-demoting 497 honest `BR-DW-15` links if bare rule-ID pages exist — is worse than the defect it prevents, which is one link in 953" · "Instead, report the ambiguity as a measurement: across both stacks, how many labels are a token-contiguous run of two or more distinct pages' titles or aliases?" · "If it is small or zero, the relaxation is complete and there is nothing else to build." · "If it is material, do not refuse those links — the resolver already chose a target, and a label honest for both is not a fabrication. Report the count and the affected pairs". No second rule is added for the `SHA-256` case: `sha 256` is not a token-contiguous run of `Checksum S3 Key Pattern ({expedienteId}/{hash}-{nombreOriginal})`, so that wrong link fails on its own grounds and stays demoted `unanchored`, while `[[sha-256-checksum|SHA-256]]` is kept because `sha 256` is a leading run of `sha 256 checksum`.

S5. Untouched reasons. `self-reference`, `redundant`, `over-budget` are untouched. `over-budget` outcomes may legitimately shift because a relaxation in `isAnchored` changes which links reach the budget counter; the shift must be measured and reported, not tuned away.

S6. Measurement, not estimation. Re-run the gate over both stacks read-only: demotions before vs after, per reason, and the per-rule delta. Prediction: `unanchored` drops from 953 to roughly 3–40. A number far from that means the tokenisation differs from the measurement's, and that discrepancy is the finding.

S7. Aliases defect, report only, do not fix. `wiki.pages.aliases` does not exist in the live database although `schema.sql:92` declares it, and `wiki.concept_aliases` has 0 rows. Every comparison is title-only. `schema.sql` and the live DB disagree — a separate defect.

S8. Counting units. The 953 demotions are ~297 distinct label→title pairs (290 + 7). Report distinct counts, not occurrence counts, when describing coverage.

S9. Scope. `link-anchoring.ts` and its tests. Not `resolver.ts`, not `import/run.ts`, not `link-repair.ts`. No migration, no dependency.

S10. Gates. `npx tsc --noEmit` · `npm run typecheck:tests` · `npm run lint` (ceiling 558 / 396 / 423) · `npm run fallow:ci` (say so if it prints "compared nothing") · the focused link-anchoring suites · the full suite under the CI form `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" corepack pnpm exec turbo run test --filter=//`, asserting the population from its own summary, not the exit code.

S11. Prohibitions. No `--no-verify`, no `HUSKY=0`, no `--amend`, no push, no `.env*` read, no provider call, no database writes, no page modification.

## Derived implementation constraints (Lead decisions, not new requirements)

D1. No new tokeniser and no new export. `canonicalConceptKey` joins its tokens with a separator; splitting a canonical key on that separator recovers the exact canonical token array, acronym expansions included. Before relying on it, read `packages/wiki/src/dimensions/wiki/concept-identity.ts` and confirm from the source whether the separator is a single space and whether it is exported. Report what you found.

D2. WITHDRAWN by L4. Was: the wrong-target guard, stated as the symmetric token-contiguity relation over every other page id. Not built. The relaxation alone handles the measured case, and the guard's failure mode costs 497 honest links to prevent one wrong one.

D3. WITHDRAWN by L4. Was: the guard evaluated on its own grounds, independent of the relaxation. There is no guard, so there is nothing to place.

D4. No new demotion reason. The union `LinkDemotionReason` stays `unresolved-target | self-reference | unanchored | redundant | over-budget`. A refused link is demoted `unanchored` — the label does not name *this* target, which is what that reason already means. Adding a reason would change `Record<LinkDemotionReason, number>` for every consumer, an unrequested contract break.

D5. WITHDRAWN by L4. Was: resolving the all-pages title/alias set from `LinkPageSet`, which `LinkAnchoringIndex` does not expose. Only the guard needed it. The relaxation needs only the resolved target's own identity, which `namesTarget` already receives.

D6. WITHDRAWN by L4. Was: warming a foreign-page index once per `validateContextualLinks` call so `isAnchored` could stay synchronous. Only the guard needed it. What still stands from it: do not reorder the existing checks in `decideLink`; keep the `unanchored` decision where it is.

## Tasks

T1 — feature document — S1–S11 — done — this commit
T2 — read-only before-measurement over both stacks: frozen corpus plus a reusable harness — S1, S6, S8 — done — this commit
T3 — tests first: prefix, suffix and interior runs RED; no-shared-token, reordered, the `SHA-256` case and the three untouched reasons GREEN-pinned — S2, S3, S4, S5 — done — this commit
T4 — implement the relaxation only: no guard, no new reason, no new tokeniser — S2, S3, S5, D1, D4 — done — this commit
T5 — after-measurement with the same harness on the frozen corpus, plus the ambiguity census — S4, S6, S8 — done — this commit
T6 — independent verification: gates, focused suites, full-suite population — S10 — done — this commit
T7 — work-unit commit on the feature branch — S10, S11 — done — this commit
T8 — boundary tests the rule names: plural-stemmed run, acronym-expanded run, alias run, label longer than the name, label skipping a token, label with no word characters — S2, S3, D1 — done — this commit

## Log

L1 — the user's original request, verbatim:

"Relax the anchoring rule so it stops flattening honest links — and keep the one wrong-target class out. Measured, with the numbers below; do not re-derive them.

Repo: primary `/home/urgosxd/Desktop/ofk/llm-wiki-compiler`, `main` = **`054e6b16a627cc812fcc5d1454fb3b39d8730d35`**. Node 24 ONLY, and **`git commit` itself must carry the PATH prefix** or the pre-commit hook refuses under v22. Read `AGENTS.md` in full. Docker is reachable; the two real stacks (`7f1b3b36…` 28 pages, `d61bf181…` 398 pages) are in `llmwiki-kg-db-1`/`aks` and may be read **only**.

## The measurement that authorises this

`isAnchored` (`link-anchoring.ts`, via `namesTarget`) requires a wikilink's visible label to canonicalise to the target's **full title or a declared alias**. Of **953** links demoted as `unanchored` across both stacks:

- **915 (96.0%) are leading-segment prefixes of the target's own title** — `BR-DW-15` → `BR-DW-15: Feedback visual` (497 cases; a rule ID standing in for its own title), `Breadth-First Search` → `Breadth-First Search (BFS)` (175; title minus its acronym gloss), `PDF` → `PDF Preview in Document Workspace`.
- **10** suffix, **1** contiguous substring, **9** same-tokens-reordered, **15** shares-one-token.
- **3 (0.31%) share no distinctive token** — the genuinely wrong ones.
- An independent blind reimplementation reproduced 953 exactly and judged **913 honest · 37 vague-but-not-wrong · 2 wrong**.

**And exactly one of those 3 is a wrong TARGET**: label `SHA-256` → target `Checksum S3 Key Pattern…`, when a page titled `SHA-256 Checksum` exists and other bodies reach it with the identical label. That one is a real defect and it must not survive the relaxation.

## The change

**Accept a label that is a token-contiguous run of the target's title or a declared alias** — leading segment, trailing segment, or an interior run — using the gate's own **canonical** tokenisation (the plural-stemmed, acronym-expanded domain `canonicalConceptKey` reasons in), word-bounded. Do **not** invent a new tokeniser: a raw-token matcher reports 11 wrong cases where the canonical domain reports 3, and the gate reasons in the canonical domain.

**Do not accept reordered tokens** (the 9 cases). A reordered label is not a contiguous run — it is a different claim — and 1% of the population does not justify the risk. If you believe they should be included, report why instead of including them.

**Add the wrong-target guard, and make it mechanical:** if the label canonicalises to **another existing page's** title or alias, the link is refused regardless of whether it also prefix-matches its own target. That is the `SHA-256` case, and it is the only wrong-target class measured. **The guard must not depend on the relaxation being present** — a label naming a different page is refused on its own grounds.

## Tests — one RED per rule, and a differential

1. **Prefix accepted**: the `BR-DW-15` shape → kept. **RED today.**
2. **Suffix and interior run accepted**, one case each. **RED today.**
3. **Wrong-target guard**: label `SHA-256` targeting the checksum-pattern page while `SHA-256 Checksum` exists → **demoted**. **RED** if the guard is absent; prove it by writing the test first.
4. **A label sharing no token is still refused** — the existing behaviour must not loosen. This one must be **GREEN before and after**; say so explicitly rather than counting it as new coverage.
5. **Reordered tokens still refused** — GREEN before and after, stated as such.
6. **`self-reference`, `redundant` and `over-budget` are untouched** — at least one test per rule proving the outcome is byte-identical. These are item 1's real risk: a relaxation in `isAnchored` can change which links reach the budget counter, so **`over-budget` outcomes may legitimately shift**. If they do, say by how much and on which corpus; if they must not, pin it.

**A test that passes on the base commit for the relaxed behaviour is not a test** — state which of your tests were RED and which were already GREEN.

## Measure the effect, do not estimate it

Re-run the gate over **both stacks, read-only**, and report: demotions before vs after, per reason, and the per-rule delta. The prediction from the measurement is that **unanchored drops from 953 to roughly 3–40**; if your number is far from that, the tokenisation differs from the one the measurement used and **that discrepancy is the finding**, not something to tune away.

## Also state
- **`wiki.pages.aliases` does not exist in the live database** although `schema.sql:92` declares it, and `wiki.concept_aliases` has 0 rows. Every comparison is therefore **title-only**, so the wrong class can only shrink on data with aliases. **The sync between `schema.sql` and the live DB is a separate defect — report it, do not fix it.**
- The 953 demotions are **~297 distinct label→title pairs** (290 + 7). Report distinct counts, not occurrence counts, when describing coverage.

## Scope
`link-anchoring.ts` and its tests. **Not** `resolver.ts`, not `import/run.ts`, not `link-repair.ts` — the ungated write paths are a separate slice and mixing them here would hide whether this change is safe. No migration, no dependency.

## Gates
`npx tsc --noEmit` · `npm run typecheck:tests` · `npm run lint` (ceiling **`558 / 396 / 423`**) · `npm run fallow:ci` — if it prints "compared nothing", say so · the focused link-anchoring suites, plus **the full suite under the CI form**, because `link-anchoring.ts` is shared by three link channels: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" corepack pnpm exec turbo run test --filter=//`. **Assert the population from its own summary, not the exit code.**

## Prohibitions
No `--no-verify`, no `HUSKY=0`, no `--amend`, no push, no `.env*` read, no provider call, no database writes, no page modification."

L2 — Lead measurement of the gate as it stands: `isAnchored` at `packages/wiki/src/compiler/link-anchoring.ts:533-556`; `namesTarget` at `link-anchoring.ts:615-624`; `LinkDemotionReason` union at `link-anchoring.ts:62-66`; `LinkPageSet` with `ids`/`graph`/`identity` at `link-anchoring.ts:145-154`; `LinkAnchoringIndex` at `link-anchoring.ts:149-176`; `validateContextualLinks(body, index)` at `link-anchoring.ts:390-398`; `canonicalConceptKey` at `packages/wiki/src/dimensions/wiki/concept-identity.ts:225-267`, which stems plurals before consulting `ACRONYM_EXPANSIONS`. Primary test file `test/compiler/link-anchoring.test.ts` (two describe blocks: "anchored contextual links — keep and demote", "anchored contextual links — redundancy and budget"); pipeline test `test/compiler/link-gate.test.ts`. No existing script in the repo recomputes demotion counts per reason, so the measurement harness is built by T2.

L3 — Lead architecture decisions D1–D6 above, derived from L1. D2 and D4 are the load-bearing ones: equality cannot catch the measured case, and a new reason is a contract change nobody asked for.

L4 — requirement change from the Manager, verbatim:

"**Finding 1 is right, and the conclusion is stronger than you took it: the relaxation already excludes the SHA-256 case. Do not build the guard.**

`SHA-256` is **not** a token-contiguous run of `Checksum S3 Key Pattern ({expedienteId}/{hash}-{nombreOriginal})`. So under the relaxation the **wrong** link fails on its own grounds and is demoted `unanchored`, while the **correct** link — `[[sha-256-checksum|SHA-256]]`, where `sha 256` *is* a leading run of `sha 256 checksum` — is kept. **That is exactly the behaviour we want, produced by the rule we already have.** The guard I wrote adds nothing to that case; it was a second rule for a defect the first rule already handles.

**My error, and it has a shape worth naming:** I designed the guard from my *description* of the defect (\"label names another page\") instead of from its *mechanism* (\"label is not a run of this page's title\"). That is the same mistake as the tautological metric earlier today — both were rules whose predicate did not match the thing they were meant to catch. Your symmetric formulation is the correct repair **of my predicate**; the point is that once the predicate is right, the relaxation alone is the whole fix.

## So: implement the relaxation, and measure the ambiguity instead of guarding against it

**Do not ship the contiguity guard**, for the reason you identify: its failure mode — re-demoting 497 honest `BR-DW-15` links if bare rule-ID pages exist — is **worse than the defect it prevents**, which is **one link in 953**. A rule that trades one bad link for five hundred is not a safety improvement.

**Instead, report the ambiguity as a measurement**: across both stacks, **how many labels are a token-contiguous run of two or more distinct pages' titles or aliases?** That number is the real question.

- **If it is small or zero**, the relaxation is complete and there is nothing else to build. Say so and close it.
- **If it is material**, do **not** refuse those links — the resolver already chose a target, and a label honest for both is not a fabrication. Report the count and the affected pairs, and I will decide what ambiguity policy is worth, if any.

## Keep both of your other decisions
**(a) No new demotion reason** — correct, and for the right reason: a refused link is `unanchored` because the label does not name *this* target, which is what the reason already means, and adding one would break `Record<LinkDemotionReason, number>` for every consumer as an unrequested contract change. **(b) No new tokeniser and no new export** — correct; confirm the separator from source and report it rather than assuming the space.

## And keep the fidelity gate
The before-run must reproduce **953** `unanchored`, or the divergence is documented as the finding. If your number lands far above the predicted 3–40, **that is the result** — report it, do not tune the rule to hit my guess. My predictions have been wrong three times today; the measurement is the authority, not the number I wrote in the brief."

L5 — Lead entry, T2 measurement harness. A read-only harness was built in `$HOME/.herdr-scratch/fix-anchoring-measure/` (outside the repository, never committed) that drives the real gate — `listLinkPageSet` → `linkIndexFor` → `validateContextualLinks`, plus `uniqueTitleMap` and `createRepairResolver`, as the production link phase assembles them — over a corpus materialised ONCE from both live stacks and re-verified by checksum on every run. Corpus fingerprint `ac747b980cfb4170be1b545dbc4eae4e8f00f9b4b7643a2ad7d9039a2b7d5c45` over 428 files; instrument `measure.ts` sha256 `39f86c4f271c292c6c7d74e7401a5de0b7c28d31953cf6935326484b266f8fe3`, pinned so before and after are provably the same instrument. Database reached read-only (`default_transaction_read_only=on` observed server-side); no `.env` read, no credential printed, no write. The harness reproduces the brief's measurement exactly: 953 `unanchored`, 297 distinct label→title pairs (7 + 290). BEFORE, per reason — 28-page stack: kept 283, unresolved-target 13, self-reference 0, unanchored 28, redundant 48, over-budget 39. 398-page stack: kept 600, unresolved-target 1228, self-reference 13, unanchored 925, redundant 69, over-budget 0. Combined: kept 883, unresolved-target 1241, self-reference 13, unanchored 953, redundant 117, over-budget 39. Two facts the report must carry: `over-budget` is 39 and ALL of it is on the 28-page stack, so it bounds any shift; and the phase of `over-budget` and `redundant` is order-sensitive and must be re-read, never assumed.

L6 — data facts from the same read-only pass, reported and NOT fixed. `wiki.pages.aliases` does not exist in the live database and `wiki.concept_aliases` has 0 rows, so every comparison in both corpora is title-only; the wrong class can only shrink on data that has aliases. Beyond the brief's schema-drift note: the production row reader cannot read this deployment at all — `createPageContentSource(db, stackId)` fails with `PostgresError 42703: column "aliases" does not exist` because `page-store.ts` selects `aliases`/`attribution_gaps` at lines 214/264/291/348, and `migration_wiki_db_parity.sql` is in the repo but was never applied to `aks`. That migration is purely additive (two `add column if not exists`, three `create table if not exists`, three non-unique `create index if not exists`, RLS policy recreation guarded by `drop policy if exists`), both new columns are `not null` WITH a constant default `'[]'::jsonb` so existing rows cannot fail, and it is registered last in `scripts/apply-schemas.sh` `SCHEMA_FILES` (entry 17, after `migration_page_embeddings.sql`). Nothing was applied. This is a separate defect with its own slice.

L7 — Lead entry, T5 ambiguity census, and the decision it settled. The census answered the question the requirement change put in place of a wrong-target guard, over the same frozen corpus. **80 distinct labels are a token-contiguous run of two or more distinct pages' titles**, carried by **1082 link occurrences** of the 3246 in the corpus; fan-out 2 pages ×26 labels, 3 ×11, 4 ×12, 5+ ×31, maximum 22 pages for the label `role`. Ten of the 80 are themselves page titles, seventy are not; none is academic (every one is carried by a real link). What settles it is the resolution breakdown: of the 554 ambiguous occurrences that resolve at all, **553 land on a page the label legitimately names and exactly 1 does not** — the brief's own `SHA-256` case — while the remaining 528 never resolve at all and are `unresolved-target`, not ambiguity. **Decision: no ambiguity policy in this slice.** A refusal rule would be the withdrawn guard under another name and would re-demote the honest `BR-DW-15` population to prevent one link in 953; ambiguity here is a choice-quality property of the resolver and belongs to that separate slice. The 528 unresolved links are the largest single defect in that corpus and do NOT get folded into this change's numbers.

L8 — Lead entry, T5 after-measurement, and the acceptance criterion. The pre-registered criterion was `unanchored` 953 → 27 (28 → 3, 398 → 24), computed independently by the census's differential against what the live gate demonstrably demotes, with 0 contradictions. The untouched instrument reproduced it exactly. AFTER, per reason — 28-page: kept 292, unresolved-target 13, self-reference 0, unanchored 3, redundant 50, over-budget 53. 398-page: kept 1475, unresolved-target 1228, self-reference 13, unanchored 24, redundant 80, over-budget 15. Combined: kept 1767, unresolved-target 1241, self-reference 13, unanchored 27, redundant 130, over-budget 68. Distinct pairs 297 → 23. The reconciliation balances: 926 = kept +884, redundant +13, over-budget +29, self-reference 0, unresolved-target 0. `over-budget` shifted 39 → 68 and the mechanism is not merely the 16 newly anchored links reaching the counter: **13 links that are KEPT today are now pushed out of the budget by the newly kept ones**, because `MAX_CONTEXTUAL_LINKS_PER_PAGE = 12` is a positional truncation, not a relevance one. On pages below the budget this change converts refused honest links into kept ones; on pages above it, it changes WHICH 12 are kept, not how many. The shift is concentrated: the 398-page stack goes 0 → 15 and 10 of those sit on one page, `concepts/sge-sistema-de-gestión-de-expedientes`. The budget constant is NOT touched here and deserves its own slice. The residual 27 are all genuinely non-contiguous — no occurrence is a run of its target's title at any offset — with the 9 same-tokens-reordered occurrences matching the brief exactly, but the brief's `9 + 15 + 3` breakdown does NOT describe the after-population: it is 9 reordered, 9 sharing one token, 2 sharing none, and 7 sharing 2–6 tokens yet still not positional runs (typo/variant, elided article, reorder-plus-abbreviation, added words, and one character-level truncation).

L9 — Lead entry, T6 independent verification, by an agent that did not write the change. Verdict per spec: S2, S3, S5, D1, D4, D6 PASS; S4 PASS on the code half — no wrong-target guard exists, `namesTarget` receives only the mention and the resolved target's identity, and the `SHA-256` link is demoted because `sha`/`256` appear nowhere in that target's title while the same label onto `SHA-256 Checksum` (`sha 256 checksum`) is kept on three real links. `decideLink`, `isAnchored`, `LinkDemotionReason` and `DEMOTION_REASONS` are byte-identical to HEAD. Gates: `tsc --noEmit` clean; `typecheck:tests` no regression; **`pnpm run build` passed** (the first build of this change and the first of the session); `test:affected` 120 files / 537 tests; `fallow:ci` 0 dead-code / 0 complexity / 0 duplication; `lint` triple exactly `558 / 396 / 423`; and the full suite under the CI form `turbo run test --filter=//` reported its own population as `833 passed | 4 skipped (837)` files and `6261 passed | 11 skipped (6272)` tests with `1 successful` in 6m37s, neither count zero, the vendor-contract test skipping loudly for the absent `TYPESAFE_API_KEY` as `AGENTS.md` requires, and `LLMWIKI_TEST_ALLOW_NO_DATABASE` never set. RED was reproduced independently against the base source. Two qualifications the report must carry: `fallow:ci` compares the WORKING TREE against `main` because the branch has no commits yet — its own JSON shows `changed_files_count: 2`, so the verdict came from a real diff of this change and is not the committed-range shape CI produces; and `CANONICAL_TOKEN_SEPARATOR` restates the unexported `KEY_SEPARATOR` at one site, an accepted duplication because exporting it from `concept-identity.ts` was out of scope.
