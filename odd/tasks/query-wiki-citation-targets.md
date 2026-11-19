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
T6 — Independent verification (gentle-ai-verify), gate checks, report — spec: S7-S12 — gentle-ai-verify — commit: 494fc8a1 (the verdict is `L3`; this document was authored BEFORE the first source write and committed untracked-to-tracked in `494fc8a1`, and the correction to it shipped in the docs commit recorded in `L9`)
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

L6 — second verification pass: SHIPPABLE. `corepack pnpm run gates:static` 6/6 green (`tsc`, `typecheck:kg`, `typecheck:tests`, `fallow:ci`, `fallow:kg`, `lint`), the build ok, and an order-independent probe confirmed the exact-stem precedence rule by exercising it in both index orders. Only two outcomes changed across the whole branch, and both are the intended ones: a qualified target resolves, and an exact stem wins over a slugified stem.

L7 — residual, deterministic, named as a limitation rather than fixed: citing `[[7. Subdominios DDD]]` resolves to `concepts/7-subdominios-ddd` when an exact-stem page also exists, because the raw target does not survive into resolution — `recognizedWikilinkTargets` returns the same normalized string for both spellings, so `resolveBareSlug` cannot tell them apart. Preferring the title-shaped page would need `WikilinkToken.meta.rawTarget` plus a resolver parameter: a separate unit, not this fix.

L8 — known limitations, one line each.
- (a) Two stems whose slug forms coincide, with neither matching the target exactly, resolve to whichever page the scan yields first. On base BOTH were `broken`, so no target was ever resolvable and there is no correct choice to preserve; the order-dependence is new but the answer set is not, and making it deterministic would need a rule nobody has stated yet. Pre-existing input, unresolved by design.
- (b) A stem containing `:` cannot be cited as a qualified id (`packages/wiki/src/utils/page-id.ts:46` forbids `:` in a page part by design). Pre-existing.
- (c) `wiki.pages.links` is a DERIVED column (`packages/wiki/src/dimensions/wiki/page-store.ts:440` writes `Page.links`) that will now hold `concepts/x` for a qualified link while the field is documented as slugs. No migration and no stored stem change — flagged as a data-shape question for the Manager, not migrated here.
- (d) `packages/wiki/src/commands/query.ts` is 417 lines against a 400-line limit with `generateAnswer` at 43 lines against 39. Both are pre-existing frozen violations; splitting it is a separate follow-up unit.

L9 — the later commits of the feature: `25e9a56b` (deterministic precedence via `findPageInDirectory`, the `danglingLinks` type fix, and the locator corrections), `494fc8a1` (this document, as the first tracked version, plus `docs/mcp-payload-pins.md`), and `8de0fe36` (`test(citations): pin bare-slug precedence and qualified confinement`, the probe that pins L4's rule and L7's erasure). Record for the history: this document was written BEFORE the first source write and stayed untracked until `494fc8a1`, so "created before the first write" cannot be proven from git history alone — this line is that record. The sha of the docs commit carrying L6-L9 cannot appear inside itself and is reported in the campaign handoff.

L10 — the links-column census, re-derived this session (every locator below comes from a file opened in it, not from the handoff).

The settling question: `wiki.pages.links` (`packages/wiki/src/dimensions/wiki/schema.sql:90`) is a DERIVED column written from `Page.links` (`packages/wiki/src/dimensions/wiki/page-store.ts:440` — `${toArrayLiteral(page.links)}::text[]`), built by `extractWikilinkSlugs` (`packages/wiki/src/export/collect.ts:180`, `packages/wiki/src/pages/list.ts:220`). Since `2a256669` that extractor returns a NORMALIZED target (`normalizeWikilinkTarget`, `packages/wiki/src/wiki/wikilink-tokens.ts:77`), so a body `[[concepts/x]]` yields `concepts/x`. Page identity is `(page_directory, slug)` — `primary key (stack_id, page_directory, slug)` at `packages/wiki/src/dimensions/wiki/schema.sql:106` — so `concepts/x` and `queries/x` coexist and a bare slug cannot disambiguate them.

| consumer `path:line` | what it does with the value | verdict | why |
| --- | --- | --- | --- |
| `packages/wiki/src/export/graphml.ts:69` `.filter((slug) => knownSlugs.has(slug))` against `:84` `new Set(pages.map((p) => p.slug))` | drops every target it does not find in a set of BARE slugs | **BROKEN** | demonstrated: real pages, `concepts/x` body `[[concepts/y]]`, edges `[]`. Node ids were the bare slug too (`:55`, `:72`), so two pages sharing a stem produced `['x','y','y']` — not unique |
| `packages/wiki/src/export/json-ld.ts:50` `page.links.map((slug) => ({ "@id": pageIri(slug) }))` with `:32` `pageIri(page.slug)` | mints a mention IRI without resolving it | **BROKEN** | demonstrated: three pages produced two distinct `@id`s (`urn:llmwiki:y` twice), and the mention `urn:llmwiki:queries/y` was declared by no node |
| `packages/wiki/src/pages/read.ts:65-68` `slug: slugFromPageId(target.slug) \|\| target.slug`, behind `packages/wiki/src/mcp/wiki-read-tools.ts:230` | projects the target to its bare page part for the `read_page` wire | **BROKEN, NOT FIXED** | demonstrated: body `[[queries/x]]` yields ref `{slug:"x"}`; `readPageRecord(root,"x")` returns the CONCEPTS page and `readPageRecord(root,"queries/x")` is `null`. STOPPED: the fix is in `packages/wiki/src/pages/read.ts` + `read_page`'s slug argument, outside the granted surfaces |
| `packages/wiki/src/viewer/collect.ts:184-187` → `resolveBareSlug:72` | resolves every outgoing target to a `PageId` | SAFE | a qualified target is parsed (`:82`) and resolved only inside its namespace (`resolveQualifiedSlug`), with exact-then-slugified matching (`findPageInDirectory:129`). Probe: `out: ["queries/x","concepts/y"]` |
| `packages/wiki/src/viewer/graph.ts:152,201` | builds edges and degree from `page.outgoingLinks` | SAFE | those are `PageId`s the resolver already produced, not targets; `pageIds.has(t)` at `:201` only filters |
| `packages/wiki/src/viewer/snapshot.ts:232` `resolveBareSlugList(extractWikilinkSlugs(...), defaultPages)` | resolves the index page's links | SAFE | same qualified-aware resolver as above |
| `packages/wiki/src/context/graph-gaps.ts:58` `` `Page links to [[${dangling.display}]], but no page exists.` `` | reports dangling targets | SAFE | `danglingLinks` is the viewer's already-resolved negative set (`viewer/collect.ts:186`), so a resolvable qualified target is not in it |
| `packages/wiki/src/compiler/link-anchoring.ts:612` `target.includes(ID_SEPARATOR) ? [target] : [slugify(target), target]` | validates links in generated bodies | SAFE | a namespaced target is offered VERBATIM to `resolveTargetNodeId`, whose graph is keyed by qualified ids |
| `packages/wiki/src/dimensions/wiki/page-store.ts:129,440` | writes and reads the column verbatim | SAFE | a round trip, not a comparison; nothing downstream of `toPage` reads `Page.links` (repo-wide `.links` grep: page-store, the two export writers, and `PageRecord.links`) |
| `packages/wiki/src/dimensions/wiki/reader.ts:123` → `page-answer.ts:42` `toReadEntity` | maps pages onto the dimension answer | SAFE | the entity shape is `id/name/kind/description`; `links` cannot reach it |
| `packages/wiki/src/dimensions/wiki/page-scan-source.ts:88` `listStoredPagesUnfiltered` | maps rows back onto `RawWikiPage` | SAFE | `RawWikiPage` has no `links` field, so the value is dropped at the boundary |
| `packages/wiki/src/export/json-export.ts` (whole `ExportPage`, `links` included) | serialises the page verbatim | SAFE | no comparison; the page object carries `pageDirectory` + `slug`, so a consumer can compose the pair itself |

BROKEN list: `graphml.ts:69/84`, `json-ld.ts:50/32` — both fixed in this branch — and the `read_page` projection, stopped with its surface named above.

The reasoning that settled the column shape: the column is correct as it stands and must NOT be re-narrowed to bare slugs. Three of its consumers needed a qualified target AND a bare slug to work, and the only thing that answers both is `(page_directory, slug)` — so the fix belongs in the consumers. `packages/wiki/src/export/link-targets.ts` now owns page identity (`exportPageId`, `concepts/x`) and target resolution (qualified confined to its namespace; bare keeps concepts-then-queries; exact stem before slugified stem, mirroring `viewer/collect.ts:129`). Both export writers key node identity on it, which CHANGES THE EXPORT CONTRACT: a GraphML node id and a JSON-LD `@id` are now `concepts/x` where they were `x`, and three pinned assertions in `test/export.test.ts` moved with it. GraphML edge targets resolve before rendering, and a target that resolves to no page in the export is still dropped (an unresolved JSON-LD mention keeps the IRI it had, so only the resolution defect changed).

Found, and NOT in this census because it does not consume the value: `packages/wiki/src/export/okf/mapping.ts:158` `const slug = slugify(rawSlug)` re-parses the body itself and slugifies the WHOLE target, so `[[concepts/x]]` is left verbatim (a dead wikilink in the bundle) while `[[x]]` becomes a link — observed: `"See [[concepts/x]]."` vs `"See [x](/concepts/x.md)."`. Its input did not change with the column, it is pre-existing, and `makeResolver` (`packages/wiki/src/export/okf/bundle.ts:31`) is keyed by bare slug, so fixing it is its own unit.

L11 — a SEPARATE DEFECT, not fixed here: **the test-database isolation work claimed "refuse a server this run did not create", and this full-suite run used one** — contradicting the header of `test/fixtures/testcontainers-postgres.ts:55-63` ("There is no fallback to a server this run did not create"). The run fell back to a pre-existing PostgreSQL container on port 5434 that it did not create. Its own follow-up, on its own branch; nothing in this branch touches the harness.

What THIS session observed, recorded so the defect is not confused with a re-observation: the setup file announced `[test-database] unavailable: the adopted container crazy_heyrovsky is not used as this run's database (does not match the schema this repository declares: missing columns: public.ontology_entities.ontology_offending_type, ...)`. That is the REFUSAL path working, and it names a container that pre-exists this session — the same class of host state the defect above describes. Neither run owned the database it was offered.

L12 — the two claims, verbatim and attributed, kept as a quoted block:

> **Manager:** "Four things you explicitly did not claim — the exit code of a detached run, that the suite rebuilt `dist/`, that the run owned a database, and the 23-versus-7 commit arithmetic."
>
> **Worker report:** "Not claimable: the test run's exit code (detached process — verdict rests on its summary); that the suite rebuilt `dist/` (stamp cache hit, artefact from my explicit build); that the run owned a database (it fell back to a pre-existing container on `:5434` — pre-existing advisory, contradicting `testcontainers-postgres.ts:55-63`); nor that the branch is 7 commits ahead of `origin/main` — it is 23, of which 7 are this feature."

L13 — `read_page`'s link projection was BROKEN under a namespace collision, and the Manager ruled that a broken consumer belongs to this fix. Observed before the change, through the public tool surface (`test/mcp/read-page-links.test.ts`, real rows for `concepts/x` and `queries/x`, a page whose body says `[[queries/x]]`): the wire answered `links: [{ slug: 'x', label: 'queries/x' }]`, and following that slug — `read_page("x")` — returned the CONCEPTS page (`title: "Concept X"`), a page the body never named. The projection was `slug: slugFromPageId(target.slug) || target.slug` at `packages/wiki/src/pages/read.ts:66`, documented as safe because "`read_page` addresses pages by bare slug and never parses a namespace" — which was true, and was the defect: the ambiguity is permanent by construction until the qualified id survives the wire.

The Manager's ruling: a consumer that is still BROKEN is part of this fix, not a follow-up. Direction taken — extend the accepted input instead of discarding the namespace:

- `packages/wiki/src/pages/read.ts`: `pageLinkRefs` emits the NORMALIZED target (`target.slug`) instead of projecting it; `readPageRecord` parses its argument through `parseQualifiedPageId` (`packages/wiki/src/utils/page-id.ts:65`) and, when it parses, searches ONLY that namespace (`lookupTargets`). A bare slug keeps today's search EXACTLY — concepts, then queries, exact filename stem, no scan, no slugify — so no bare-slug caller changes behaviour.
- `packages/wiki/src/mcp/wiki-read-tools.ts`: the registry branch of `readPageBySlug` restricts itself to the named namespace and returns the qualified id it was given; the bare branch is untouched. `read_page`'s tool description and its `slug` schema description now name both accepted forms.
- `docs/mcp-payload-pins.md`: the projection sentence is gone; the field carries the normalized target and `read_page` accepts both forms, as a contract EXTENSION.

Contract status: EXTENSION, not a break. Pinned by test, both ways: `[[queries/x]]` survives the wire and follows to the QUERIES page, and `read_page("x")` with both stem-holders present still answers the concepts page (`slug: "x"`, `title: "Concept X"`) — pinned as what it is today, not chosen.

Known limitation, recorded not fixed: a qualified id addresses its page part VERBATIM like the bare form does, so a title-shaped stem (`7. Subdominios DDD`) is reachable as `concepts/7. Subdominios DDD` and not as the slugified `concepts/7-subdominios-ddd` this read path never slugifies. Same rule as the bare form, so nothing regressed; making the read path slugify would be its own unit.
