# Feature: `query_wiki` citation targets that do not resolve

Branch `fix/query-wiki-citation-targets`. The detector is working; the assembly is not: make every citation target and body wikilink that `query_wiki` returns resolve to a page that exists in that stack, without changing what is retrieved.

## Specs

S1. Page identity. `unique (stack_id, page_directory, slug)` was reported earlier, so a page is `(directory, slug)` and not a single path string. Confirm it with `path:line`.

S2. The four ground-truth questions, answered from source with `path:line`:

1. What does a citation `target` field mean — a slug, a qualified id, a path, or a page id? Name the type and its producing code.
2. What form do body wikilinks take, and who renders them? If the answer model is told to emit `[[…]]`, quote the instruction.
3. What does the renderer do with `[[…]]`, and does it validate them?
4. And what does `answerCitations` compare the target against to decide `broken`? If it compares a path against a bare slug, that is the bug, and it is in the checker rather than the builder.

S3. The human's production evidence, verbatim. The human ran `query_wiki` and reported:

- The retrieval was good: it re-ranked by BM25 over chunk text — something `search_pages` cannot reproduce — and surfaced a page their own traversal had missed.
- `answerCitations` marked all three as `broken`, with malformed targets:

```
conceptstest2
conceptsrbac-por-oficina
7-subdominios-ddd
```

- And the body wikilinks — `[[concepts/test2]]` — are not valid slugs either. "Si te hubiera dado su respuesta tal cual, me habría entregado enlaces muertos."

S4. The asymmetry, stated as the first thing to establish. Also note the asymmetry the human drew and take it seriously: the body wikilinks are `[[concepts/test2]]` while the citation target is `conceptstest2` — two different transformations of the same page in one response. Either both are wrong in different ways, or one is the correct form and the other is a bad normalization of it. Which one is right is the first thing to establish.

S5. Two distinct failures, acknowledged before reproducing. The first two targets look like a page path with its separator removed: `concepts` + `test2` → `conceptstest2`. That is a hypothesis, not a finding, and the third target (`7-subdominios-ddd`) does not fit it — it has no directory prefix at all. So there may be two distinct failures, and the third case is the one that will tell you whether the rule is "strip the separator" or something else. And cover the case that does not fit: a page whose slug is `7-subdominios-ddd` with no directory, or with a directory that is part of the slug. Explaining that one is what separates a rule from a coincidence.

S6. Reproduce, RED first, from the code's own construction path. Build the failing case from the code's own data model, not from the human's data, which you cannot see. A page with directory `concepts` and slug `test2` must produce the observed malformed target in a test. If it does not, say so — then the production data has a shape you have not guessed, and that is the finding. A test that passes because you constructed its input to fail is not a reproduction. Construct the input the way the system constructs it and observe the real output.

S7. The invariant, as a property over arbitrary pages. Whatever the cause, the invariant is: a citation target returned by `query_wiki` resolves to a page that exists in that stack. Pin it as a property, not as three hardcoded strings.

S8. Body wikilinks fixed in the same branch. And if the body wikilinks are also wrong, fix them in the same branch — a response whose body links and whose citations are both dead is the same defect twice, and fixing one leaves the other.

S9. Retrieval unchanged. BM25 re-ranking, chunk retrieval, the `k=30 → keep 12 → ≤5 pages` pipeline: unchanged. The human's report says the retrieval was the good part and it surfaced a page nothing else found. A fix that improves citations by changing what is retrieved has changed the wrong variable.

S10. Grounding discipline. `path:line` from a command you ran this session. Nine passes in this campaign were rejected for invented identifiers, paths or line numbers; one cited the same file twice as two files.

S11. A format change that existing stored pages would violate is a data question, not a migration. If the cause is a format change that existing stored pages would violate, stop and report it as a data question rather than migrating anything.

S12. Standing constraints. Node 24 on PATH for `git commit`: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`. Never `--no-verify`, never `HUSKY=0`. No `.env`, no keys, no tokens, no provider spend, no database you did not create. Nothing pushed, no PR, no merge.

## Tasks

T1 — Establish slug/citation ground truth from source with path:line (read-only) — spec: S1-S4 — gentle-ai-explore — commit: 0bba6517
T2 — Reproduce RED: real construction path yields a non-resolving citation target — spec: S5-S6 — inline — commit: 0bba6517
T3 — Explain `7-subdominios-ddd` (no-directory case) — spec: S5, S10 — inline — commit: 0bba6517
T4 — Fix citation target assembly/checking (S5 property test) — spec: S7, S10, S12 — worker — commit: 0bba6517, 2a256669
T5 — Fix body wikilinks if they are dead for the same or a different reason — spec: S8, S10 — worker — commit: 0bba6517, 2a256669
T6 — Independent verification (gentle-ai-verify), gate checks, report — spec: S7-S12 — gentle-ai-verify — commit: ebf4bd12
T7 — Verification repairs: typecheck:tests green, locators re-checked, ambiguous-citation tie-break — spec: S7, S10, S12 — worker — commit: 25e9a56b

## Log

L1 — the assignment text, verbatim:

```
Project assignment for branch fix/query-wiki-citation-targets:

`query_wiki` returns citations whose targets do not resolve. The detector is working; the assembly is not. Reproduce it, find where the separator is lost, and fix it.
```

L2 — the human's production report evidence, verbatim:

````
**The human ran `query_wiki` and reported:**
- **The retrieval was good**: it re-ranked by BM25 over chunk text — something `search_pages` cannot reproduce — and surfaced a page their own traversal had missed.
- **`answerCitations` marked all three as `broken`, with malformed targets:**
```
conceptstest2
conceptsrbac-por-oficina
7-subdominios-ddd
```
- **And the body wikilinks — `[[concepts/test2]]` — are not valid slugs either.** **"Si te hubiera dado su respuesta tal cual, me habría entregado enlaces muertos."**
````

L3 — independent verification verdict: NOT shippable, three blockers, all repaired in `25e9a56b`.
- `corepack pnpm run gates:static` failed on `typecheck:tests`: `answer-citation-targets.test.ts(167,12): error TS18048: 'page.danglingLinks' is possibly 'undefined'` — `ViewerPage.danglingLinks` is optional (`packages/wiki/src/viewer/types.ts:126`). Fixed at the type: read as `page?.danglingLinks ?? []`, no non-null assertion and no baseline entry.
- S10 locator defect: the test header said `normalizeWikilinkTarget` was at `packages/wiki/src/wiki/wikilink-tokens.ts:69`; it is at `:77`. A re-check of every locator in every comment written on this branch found one more stale one: the slugify call was cited as `wikilink-tokens.ts:52` and is at `:53`. Resolver locators moved with the tie-break and were re-derived (`viewer/collect.ts:72`, `:82`, and the matching helper at `:129`).
- Advisory promoted to a defect: with BOTH `concepts/7. Subdominios DDD` and `concepts/7-subdominios-ddd` on disk, a bare `[[7-subdominios-ddd]]` resolved to whichever page the scan yielded first. Deterministic from `25e9a56b` (see L4).

L4 — determinism defect and its fix. Both-sides slug comparison (L2's second loss) made one case ambiguous: an exact-stem page and a title-shaped page can both answer the same normalized target. `packages/wiki/src/viewer/collect.ts` now resolves in two passes inside each directory — EXACT stem first, then slugified stem (`findPageInDirectory`) — so the literal name wins; concepts-before-queries and exact-before-alias precedence are unchanged, and the qualified-id path shares the helper, so `[[concepts/7-subdominios-ddd]]` is deterministic too. Evidence: RED against the pre-fix code with the index order fixed explicitly — `expected 'concepts/7. Subdominios DDD' to be 'concepts/7-subdominios-ddd'` — and 26 citation tests green after. The disk-level cases run in both creation orders because readdir happened to list the exact stem first on this machine, which would have hidden the defect on its own.

L5 — known limitations and corrections, recorded not fixed.
- Stems containing `:` cannot be cited as a qualified id: `[[concepts/a:b]]` yields `conceptsab` on both base and head, because `parseQualifiedPageId` rejects `:` in a page part by design (`packages/wiki/src/utils/page-id.ts:46`). Pre-existing.
- Correction to `2a256669`'s "nothing stored rewritten": the derived column `wiki.pages.links` (`packages/wiki/src/dimensions/wiki/schema.sql:90`) is written from `Page.links` (`packages/wiki/src/dimensions/wiki/page-store.ts:440`), so the next write stores `concepts/x` for a qualified link instead of the old garbage `conceptsx`. No migration, no stored stem change, no format change that existing pages violate — but the commit message understates it. The commit message is not rewritten; this line is the correction.
- `packages/wiki/src/commands/query.ts` is 417 lines against a 400-line house limit, and `generateAnswer` is 43 lines against 39. Both pre-date this branch and are frozen at their current values; splitting `generateAnswer` is its own follow-up unit, and it is the reason a plain `eslint` run cannot be green on that file.
