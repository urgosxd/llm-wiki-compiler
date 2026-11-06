# algo-wiki — Wikipedia-like wiki ingestion and compilation

Branch `fix/algo-wiki`. ODD feature document: `## Specs` are the requirements, `## Tasks` the plan, `## Log` the verbatim user request (`L1`) and later decisions.

## Specs

S1 — The wiki ingest/compile algorithm must resemble Wikipedia in four aspects.
Quote: "Revisa como esta el algoritme de ingest de wiki, debe parecesce a el de wikipedia en estos aspectos: conceptos que sintetizan múltiples fuentes, enlaces contextuales entre conceptos, categorías navegables y navegación tipo wiki race."

S2 — A concept IS an article: one concept, one page.
Quote: "CONCEPTO=ARTICULO."
Interpretation (non-negotiable): one concept is one page. Multi-source synthesis means one article whose content merges what several sources say, with per-source provenance preserved — not one page per source, and not concatenation without attribution.

S3 — Original sources are kept; the wiki is a progressive compilation over them.
Quote: "La propuesta de Karpathy sirve como referencia conceptual: conservar las fuentes originales y compilar progresivamente una wiki derivada."
Interpretation (non-negotiable): the original sources are never replaced by the derived wiki.

S4 — A category is not a concept, and they may share a name.
Quote: "Una categoría y un concepto pueden compartir nombre sin ser el mismo objeto. Por ejemplo, el concepto “Sistemas distribuidos” explica el tema; la categoría “Sistemas distribuidos” agrupa páginas relacionadas."
Interpretation (non-negotiable): different object types with separate identities and separate canonical names. Do not model a category as a page with a tag, and do not let a name collision merge the two objects.

S5 — Step 1: read and extract candidates.
Quote: "1 Leer y extraer candidatos"

S6 — Step 2: match existing concepts using names, aliases and the available retrieval mechanisms, distinguishing equivalence from mere thematic similarity.
Quote: "2 Busca conceptos existentes usando nombres alias y los mecanismos de recuperación disponibles Distingue entre equivalencia y simple similitud temática ,"
Interpretation (non-negotiable): EQUIVALENCE IS NOT SIMILARITY. The match step must distinguish "this candidate IS an existing concept" (same referent, possibly via an alias) from "this candidate is thematically close". Only equivalence may merge; similarity may at most propose a contextual link. An embedding threshold must not decide identity.

S7 — Step 3: synthesize concepts.
Quote: "3 Sintetizar conceptos"

S8 — Step 4: create contextual links, anchored to a real mention or section, validated, non-redundant, no self-references, never from embedding similarity alone.
Quote: "4 Crear enlaces contextuales

Enlaza conceptos cuando el destino ayude a comprender el pasaje.
Los enlaces deben estar asociados a una mención o sección real del artículo. No crees conexiones solo por similitud de embeddings ni para aumentar artificialmente la conectividad.
Valida el destino y evita enlaces redundantes o autorreferencias innecesarias."
Interpretation (non-negotiable): every contextual link must be anchored to a real mention or a real section of the article; a link with no anchor is a defect. Connections must not be created from embedding similarity alone, nor to raise connectivity metrics. The target must exist and be the intended referent.

S9 — Step 5: review concepts. When an article is created or updated, retrieve earlier pages that might need a reference to it, and modify those pages only where the link makes sense in their content. Never rewrite the whole wiki per ingestion.
Quote: "5 Revisar conceptos Al crear o actualizar un artículo, recupera páginas anteriores que podrían necesitar una referencia hacia él.
Modifica esas páginas únicamente cuando el enlace tenga sentido en su contenido. No reescribas toda la wiki durante cada ingestión."
Interpretation (non-negotiable): incremental and bounded; the bound must be named and observable, never silent.

S10 — Step 6: incorporate Wikipedia-like categories. Every category must have stable identity, canonical name, description and inclusion criterion.
Quote: "6 ncorporar categorías similares a Wikipedia

Cada categoría debe tener:

Identidad estable.

Nombre canónico.

Descripción.

Criterio de inclusión."

S11 — Navigability: categories are navigable, from a category you can list its members, from a page you can see its categories, and wiki-race style navigation is supported by the graph, deterministically and testably.
Quote: "categorías navegables y navegación tipo wiki race"
Interpretation (non-negotiable): pages must be reachable from pages through links, with the traversal deterministic and testable.

S12 — No unnecessary infrastructure, no promise of exhaustive extraction, no silent limits.
Quote: "Do not add services, frameworks or infrastructure that are not needed. Do not promise exhaustive extraction. No silent limits: record and expose truncation, bounds and partial processing."

S13 — The algorithm runs as the proposed six steps, in that order.
Quote: "Al algoritmo que propongo es 1 Leer y extraer candidatos,2 Busca conceptos existentes usando nombres alias y los mecanismos de recuperación disponibles Distingue entre equivalencia y simple similitud temática , 3 Sintetizar conceptos 4 Crear enlaces contextuales"

S14 — Similarity may retrieve candidates; it may never decide identity or link creation.
Quote (manager, verbatim): "similarity may RETRIEVE candidates, it may never DECIDE identity and never DECIDE link creation. Retrieval by embedding for the review step ("recupera páginas anteriores que podrían necesitar una referencia") is legitimate and you should keep it — that is finding candidates cheaply. What must not survive is a vector score deciding that two things ARE the same object, or that a link should exist."
Interpretation (non-negotiable): embedding retrieval is legitimate for FINDING candidate pages and candidate links. A vector score must never (a) merge two objects into one identity, or (b) create a link on its own. Every link still requires a real anchor in the text, and every merge still requires a deterministic equivalence rule.

## Tasks

| ID | Task | Specs | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Feature document | S1-S14 | worker | 6c071271f11d85485e93537da9f1a1d11549fabb |
| T2 | Equivalence vs similarity: deterministic identity tiers (slug, canonical key, alias), embedding similarity demoted to link proposals only | S6, S13, S14 | worker | 0add62709713704f5a6eff2f9771ae37311bd1a2 |
| T3 | Anchored contextual links: structured anchor+target proposals, deterministic anchor validation, target/redundancy/self-link checks, reporting | S8, S13 | worker | 540f464183d070de6c0e9e3069c99d409545297c |
| T4 | Incremental link review of earlier pages, bounded and reported; also covers the defect that `relatedPages` context is an arbitrary alphabetical slice of existing concept slugs rather than a relevance ranking, so the review step must rank candidate pages by relevance (which IS the legitimate use of similarity retrieval per S14) instead of taking the first N slugs | S9, S13, S14 | worker | fe48024e6a72477e8e775a291d2c82895d546279 |
| T5 | Categories: stable identity, canonical name, description, inclusion criterion, member listing, page-to-category projection | S4, S10, S11 | worker | split — T5a delivered (row below), T5b pending |
| T5a | Category OBJECT MODEL + STORE: `src/categories/**` — record with stable `categoryId`, canonical name, description, inclusion criterion and per-member evidence; lossless frontmatter round trip; deterministic member order; named member bound with reported truncation; files at `wiki/categories/<categoryId>.md` written through the trust planner + journalled executor. No compile integration, no CLI, no closed-set change | S4, S10 | worker | 167cb67395845007463b24f7d29f8376718c2f7e |
| T6 | Wiki-race navigation: deterministic bounded traversal over the link graph with a testable path result | S11 | worker | fbcfb48b4ce21cb949338033c646a3340dd9c785 |
| T7 | Multi-source synthesis and provenance: pin per-source attribution, keep sources authoritative | S2, S3, S7, S12 | worker | pending |
| T8 | Final gates, docs and delivery report | S1, S12 | worker | pending |
| T9 | Hoist the single shared target resolver used by `race` and `links-here` instead of duplicating it; behaviour-preserving for `links-here`, pinned by a differential check | S11, S12 | worker | pending |
| T10 | Resolve the ghost/dangling page classification shared by `race` and `links-here`: either pin the same classification for both, or state in code and docs why they differ and pin both | S11, S12 | worker | pending |
| T11 | Remove the retired `auto`/`review` identity ranks from `concept-forest.ts` and delete the dead `concept-aliases.ts` vocabulary left behind | S6, S14 | worker | pending |
| T12 | One final link gate for both link channels: same-run targets resolve, and the `resolveLinks` channel is held to the same decision table and budget as the model's inline links; run totals reported | S8, S13 | worker | 66ce7ef44d72fa56fa22f7b92f06258cb79b8442 |
| T4b | Review retrieval unions the names an article answers to: the title, the aliases folded this run, and the `aliases` its STORED frontmatter already declares, deduped by canonical key with the title never repeated | S6, S9, S14 | worker | ae765f4bc1ff5f678aee3ea3989ba1c4eca94bc7 |
| T13 | Gate parity for `review approve`: the approve path passes the resolver's ONE gate construction, so an approved body is judged against the run's full page set instead of the concept-only resolver index | S8, S12 | worker | 070436a645e5f516de3120990838918cd40e7c9c |
| T14 | Restore the line-limit convention and remove the duplicated gate-options construction: split `link-review.ts` into candidate retrieval (`link-review-candidates.ts`) and stage orchestration, and make `index.ts`'s `linkGateFor` delegate to the resolver's `linkGateOptions`. Behaviour-preserving; no test assertion changed | S9, S14 (preserved, no behaviour change) | worker | c8de1242a6da0cd150f7c0a2d5540f77e0cb3fdd |
| T15 | Stability probe (MEASUREMENT only, no `src/` change): measure what a re-ingest does to a curated link, whether a no-op compile is byte-stable, what an anchor loss does, and whether a `PROMPT_VERSION` bump is observable. Pins THREE defects with `test.fails` and records the durable-curated-link design input with `path:line` evidence | S9, S12, S13 | worker | pending — parent-owned commit (test SHA recorded by the parent when it commits `test(compiler): pin the wiki stability defects the overlay must fix`) |

## Log

L1 (user request, verbatim):
Project: fix/algo-wiki
Revisa como esta el algoritme de ingest de wiki, debe parecesce a el de wikipedia en estos aspectos: conceptos que sintetizan múltiples fuentes, enlaces contextuales entre conceptos, categorías navegables y navegación tipo wiki race.CONCEPTO=ARTICULO.  La propuesta de Karpathy sirve como referencia conceptual: conservar las fuentes originales y compilar progresivamente una wiki derivada. Los requisitos siguientes son decisiones de nuestro producto. Una categoría y un concepto pueden compartir nombre sin ser el mismo objeto. Por ejemplo, el concepto “Sistemas distribuidos” explica el tema; la categoría “Sistemas distribuidos” agrupa páginas relacionadas. Al algoritmo que propongo es 1 Leer y extraer candidatos,2 Busca conceptos existentes usando nombres alias y los mecanismos de recuperación disponibles Distingue entre equivalencia y simple similitud temática , 3 Sintetizar conceptos 4 Crear enlaces contextuales
Enlaza conceptos cuando el destino ayude a comprender el pasaje.
Los enlaces deben estar asociados a una mención o sección real del artículo. No crees conexiones solo por similitud de embeddings ni para aumentar artificialmente la conectividad.
Valida el destino y evita enlaces redundantes o autorreferencias innecesarias.
5 Revisar conceptos Al crear o actualizar un artículo, recupera páginas anteriores que podrían necesitar una referencia hacia él.
Modifica esas páginas únicamente cuando el enlace tenga sentido en su contenido. No reescribas toda la wiki durante cada ingestión.
6 ncorporar categorías similares a Wikipedia

Cada categoría debe tener:

Identidad estable.

Nombre canónico.

Descripción.

Criterio de inclusión.

L2 (manager, non-negotiable interpretations, verbatim): "A CONCEPT IS AN ARTICLE. One concept, one page. Multi-source synthesis means one article whose content merges what several sources say, with per-source provenance preserved — not one page per source, and not concatenation without attribution." / "A CATEGORY IS NOT A CONCEPT. They are different object types with separate identities and separate canonical names, and they may legitimately share a name. "Sistemas distribuidos" as a concept explains the topic; as a category it groups related pages. Do not model a category as a page with a tag, and do not let a name collision merge the two objects." / "Original sources are kept and never replaced by the derived wiki. The wiki is a progressive compilation over them." / "EQUIVALENCE IS NOT SIMILARITY. The match step must distinguish "this candidate IS an existing concept" (same referent, possibly via an alias) from "this candidate is thematically close". Only equivalence may merge; similarity may at most propose a contextual link. State the mechanism you use for each, and do not let an embedding threshold decide identity." / "Every contextual link must be anchored to a real mention or a real section of the article. A link with no anchor is a defect. Connections must NOT be created from embedding similarity alone, nor to raise connectivity metrics. Validate the target exists and is the intended referent, and avoid redundant links and self-references." / "Review step: when an article is created or updated, retrieve earlier pages that might need to reference it, and modify those pages ONLY where the link makes sense in their own content. Never rewrite the whole wiki on each ingestion. This must be incremental and bounded, with the bound named and observable, not silent." / "Categories need: stable identity, canonical name, description, inclusion criterion. Navigability matters: from a category you can list its members, and from a page you can see its categories." / "Wiki-race navigation must be supported by the graph: pages reachable from pages through links, with the traversal deterministic and testable."

L3 (reconnaissance of the code as it exists at branch start, evidence for the plan):
- Pipeline: `runCompilePipeline` in `src/compiler/index.ts`: detectChanges → extraction phases → identity (`applyConceptIdentity`, `src/compiler/identity-stage.ts`) → page generation (`src/compiler/page-renderer.ts`) → link resolution/repair (`src/compiler/link-repair.ts`) → embedding refresh.
- DEFECT vs S6: `src/dimensions/wiki/concept-resolution.ts` has a semantic tier (`applySemanticTier`) that unions candidates into one `ConceptGroup` when cosine similarity clears a threshold (`DEFAULT_AUTO_THRESHOLD` 0.92 / `DEFAULT_REVIEW_THRESHOLD` 0.86, auto/review tiers). `bindConceptsToCanonicalNames` folds those into ONE page. An embedding threshold therefore decides identity today.
- Alias handling: page frontmatter has an optional `aliases` field (`src/utils/types.ts` `WikiFrontmatter`) but nothing writes or reads it during ingest. `src/dimensions/wiki/concept-aliases.ts` exists with no non-test consumer.
- DEFECT vs S8: page generation asks the model for free-form links with the single instruction to suggest wikilinks to related concepts (`buildPagePrompt` in `src/compiler/prompts.ts`, called from `src/compiler/page-renderer.ts`). Nothing requires an anchor, validates the target, or rejects self-references and redundant links. `repairLinks` only rewrites unresolvable targets by inflection/unique prefix and leaves the rest untouched.
- `relatedPages` context is an arbitrary alphabetical slice of existing slugs capped by `RELATED_PAGE_CONTEXT_LIMIT`, not a relevance ranking.
- MISSING vs S9: there is no step that revisits earlier pages to add a reference to a newly created/updated article. `src/compiler/refresh-plan.ts` is staleness-driven only.
- MISSING vs S4/S10: no category/taxonomy object exists. `PageDirectory` (`src/export/types.ts`) and a SQL `CHECK` on `page_directory` (`src/dimensions/wiki/schema.sql`) are closed sets, and the derived-artifact store keys on `(stack_id, kind)` with a constrained `kind` union, so it can hold one row per kind. Categories are therefore stored as their own files, not as pages and not as derived kinds.
- PARTIAL vs S11: `buildViewerSnapshot` exposes a deterministic `graph: { nodes, edges }` (`src/viewer/graph.ts`), backlinks are computed on demand by `findInboundLinks` (`src/context/links-here.ts`), and `src/commands/links-here.ts` already exists. Bounded neighbourhood expansion exists in `src/context/graph.ts`. There is no path/race traversal command.
- PARTIAL vs S2/S3/S7: `mergeExtractions` (`src/compiler/extraction-merge.ts`) groups candidates by slug, sets `provenanceState` "merged", and collects `sourceFiles`; frontmatter carries `sources`, and the body carries citation anchors. Sources live under `sources/` and are never replaced.
- Conventions: bounds are named constants in `src/utils/constants.ts` with a resolver that validates and warns; prompts are TS builders in `src/compiler/prompts.ts` guarded by `PROMPT_VERSION`; writes go through the trust layer (`src/trust/planner.ts`, `applyCompilePageWritesLocked` in `src/compiler/compile-write.ts`); CLI verbs are a command module plus registration in `src/cli/`; tests use the offline provider with no mocks.

L4 (manager decision and binding conditions on L3 point 1):
"This is a deliberate, intentional change of ingest output, not a bug fix." The embedding-score identity merge in `src/dimensions/wiki/concept-resolution.ts` is a violation of S6 and S14 and is removed structurally.
Conditions of record:
- "When you remove the tier, make sure the removal is structural, not a threshold raised to 0.999. If any code path can still merge two objects because a vector score is high, the violation is not gone."
- Existing tests that pin the forbidden behaviour are defect-pinning, not behaviour to preserve, and their assertions are inverted. Files: `test/dimensions/wiki-concept-resolution.test.ts`, `test/dimensions/wiki-concept-merge-plan.test.ts`. The exact per-test list is recorded in T2's worker report.
- Known consequence, user-visible, must be stated in the final report: wikis ingested before this change may contain pages that were merged by similarity and are now considered distinct concepts, so page counts can change.
- "Do NOT build a retroactive splitter for already-merged pages. Splitting existing state is a separate, destructive operation nobody asked for. Document it as a known consequence and leave existing data alone."
- `relatedPages` being an alphabetical slice of slugs rather than a relevance ranking is a defect; it is fixed inside T4's surface (see T4), which is the legitimate retrieval use permitted by S14.

L5 (main advanced, branch rebased, and the gate set re-measured on the quiescent tree):
Main moved to `094fd644a2101b4e9faecb3c36cdb0a20ccf4782` (`docs(agents): add the test typecheck ratchet to the pre-commit checks`) and this branch was rebased onto it, conflict-free. Post-rebase SHAs: T1 `docs(odd): add algo-wiki feature document` = `6c071271f11d85485e93537da9f1a1d11549fabb`; T2 `feat(wiki): decide concept identity by equivalence only, not similarity` = `0add62709713704f5a6eff2f9771ae37311bd1a2`; T6 `feat(cli): add deterministic bounded wiki-race navigation` = `fbcfb48b4ce21cb949338033c646a3340dd9c785`.

The project's pre-commit gate set changed. `AGENTS.md` `### Pre-Commit Checks`, quoted verbatim:

"Before committing any work, and before considering any task complete, you must:

1. `npx tsc --noEmit` — type-check passes
2. `npm run typecheck:tests` — the test type-check ratchet passes (no new test type errors)
3. `npm run build` — build succeeds
4. `npm run test:affected` — tests for what you changed pass (use `npm test` when
   the change is cross-cutting or before opening a PR; see Test Execution Policy)
5. `fallow` — run the fallow codebase health analyzer. Fix all issues it reports (dead code, duplication, complexity). Use `fallow fix --dry-run` to preview auto-fixes, then `fallow fix --yes` to apply. Fix any remaining issues manually. Do not commit until fallow reports no issues."

Gate results on the quiescent rebased tree (Node v24.21.0), every one exit 0 and no failure to classify:

1. `npx tsc --noEmit` — exit 0, no diagnostics.
2. `npm run typecheck:tests` — exit 0, "1670 files checked; 260 baseline diagnostics in 94 files; no regression."
3. `npm run typecheck:kg` — exit 0, "349 files checked; 0 diagnostics baselined across 0 entries; no regression."; `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit` — exit 0, no diagnostics.
4. `npm run build` — exit 0, ESM + DTS build success (dist/index.js 443.32 KB, dist/cli.js 498.12 KB, viewer assets copied).
5. `npm run test:affected` — exit 0, 779 test files passed / 3 skipped (782), 5990 tests passed / 4 skipped (5994).
6. `./node_modules/.bin/fallow` — exit 0, "0 above threshold · 16172 analyzed · maintainability 91.1 (good)".
7. T2 re-run: `npx vitest run test/dimensions/wiki-concept-resolution.test.ts test/dimensions/wiki-concept-merge-plan.test.ts test/compiler/extraction-identity.test.ts test/compiler/page-renderer-aliases.test.ts test/compiler/identity-stage-snapshot.test.ts` — exit 0, 5 files / 54 tests passed.
8. T6 re-run: `npx vitest run test/context/race-path.test.ts test/commands/race-cli.test.ts test/commands/race-registration.test.ts` — exit 0, 3 files / 28 tests passed.
9. `npx vitest related --run` — `src/context/graph.ts` exit 0, 48 files / 329 tests passed; `src/dimensions/wiki/concept-resolution.ts` exit 0, 88 files / 436 tests passed; `src/compiler/identity-stage.ts` exit 0, 85 files / 390 tests passed.

Coverage caveat of record: `.fallowrc.json` `ignorePatterns` contains `packages/llmwiki-kg/**`, so a clean `fallow` result is not coverage of that package; `packages/llmwiki-kg` is covered only by `npm run typecheck:kg` and the explicit `tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit`.

Known consequence, verbatim: "Wikis ingested before this commit may contain pages that were merged by embedding similarity and are now considered distinct concepts, so page counts can change. No retroactive splitter was built; existing data is left alone."

L6 (T12 delivered, `66ce7ef44d72fa56fa22f7b92f06258cb79b8442` `fix(compiler): gate every contextual link through one validator`):

The T3 delivery left two holes in S8, and both were the same structural mistake: the gate sat in the wrong phase.

1. SAME-RUN TARGETS WERE DESTROYED. The gate ran at generation time, when a page the SAME compile is creating has no file yet, so `resolveTargetNodeId` could not see it and the link was demoted as `unresolved-target`. A run that created a concept and a page linking to it wrote the link as plain text. This is exactly what `createRepairResolver(slugs, pending)` already allows for in `src/compiler/link-repair.ts`; the gate now mirrors it, because by the time it runs the planned page set IS the page set.
2. THE SECOND CHANNEL BYPASSED THE TABLE. `resolveLinks` in `src/compiler/resolver.ts` wraps plain-text mentions of real titles AFTER generation, so every link it created was never judged: no target validation, no self-reference check, no redundancy rule, no budget. Two channels, one of them ungoverned.

THE FIX IS WHERE THE GATE SITS, NOT AN EXTRA CHECK. The gate runs in the LINK PHASE, once per page, on the final body about to be written: `resolveLinks` now composes the outbound and inbound passes into one body (`collectFinalBodies` / `linkBody`) and then gates it (`gateFinalBodies`) before it becomes a `CompilePageWrite`. One decision table (`unresolved-target`, `self-reference`, `unanchored`, `redundant`, `over-budget`), one per-page budget (`MAX_CONTEXTUAL_LINKS_PER_PAGE`), one counter set, and no channel that can skip it. `src/compiler/page-renderer.ts` no longer validates anything: generation writes the body and leaves every link decision to the gate. Resolver-created links are anchored by construction (a real mention of a real title exists), so they pass the anchor rule and are still held to the other four.

Consequences of the move, all inside T12's surfaces:
- The gate judges targets against the run's OWN corpus: the content seam when the run is row-backed, `wiki/` (both namespaces) when its corpus IS the filesystem, and the resolver's own index for a row-backed caller that passed no seam. A wrong backend here is silent in one direction only, so this was the one thing a test caught: the first version narrowed a file-backed run to concept pages and demoted a `queries`-namespace target the pre-T12 gate resolved. Fixed and pinned.
- The gate accepts the wiki's existing identity rules instead of a second name chain: the one shared `resolveTargetNodeId` (scope `article`), unambiguous page TITLES (`uniqueTitleMap`), and `link-repair`'s own `createRepairResolver`, so an abbreviation repair would canonicalise is not demoted before repair runs.
- Outbound and inbound now COMPOSE. Before, the inbound body replaced the outbound one for the same slug, so a changed page that also mentioned a page created by the run lost all its outbound links.
- A page the run neither wrote nor changed is not re-judged: re-judging untouched pages would rewrite the whole wiki per ingest (S9) and would demote the prefix-shaped links `link-repair` is about to canonicalise.

COUNTERS. `ContextualLinkCounts {kept, demoted{5 reasons}}` is accumulated per page by the gate (`addContextualLinkCounts`) and carried on `PageGenerationResult.linkCounts`, so `summarizeCompile` prints ONE aggregate line — `Contextual links in this run: N kept, M demoted (...)`, via the shared `describeLinkCounts` — next to the per-page detail. Both stay silent when no rule refused anything, because a clean run has nothing to report.

TESTS (`test/compiler/link-gate.test.ts`, 9 cases, driven through `renderMergedPageContent` + `resolveAndApplyLinks`, the public surfaces): G1 same-run target kept; G2 genuinely missing target still demoted `unresolved-target`; G3 self-reference refused on a body the resolver rewrote; G4 duplicate target in one section via the resolver demoted `redundant`; G5 per-page budget holds across both channels combined (10 typed + 5 mentioned = 12 kept, 3 over-budget); G6 PIN an anchored unique in-budget resolver link is still created; G7 PIN a page with no links and no mentions is byte-identical; plus the PIN that a `queries`-namespace target still resolves. Only the `queries` case had an observed RED — its first failure was `expected '\n## Uses\n\nNetworks use Saved Query…' to contain '[[queries/saved|Saved Query]]'`; G1-G7 were green on first run because the previous worker's on-disk implementation already satisfied them, and are recorded as pins, not as invented REDs. The three fixture-dedupe files (`test/commands/links-here-cli.test.ts`, `test/commands/race-cli.test.ts`, `test/context/ghost-rule.test.ts`) keep their assertions unchanged and pass 21 tests together.

GATES (Node v24.21.0, quiescent tree, `npx tsc --noEmit` exit 0; `npm run typecheck:tests` exit 0, 1680 files, 260 baseline diagnostics, no regression; `npm run build` exit 0; `npm run test:affected` exit 0, 786 files / 6039 tests passed, 3 files / 4 tests skipped; `./node_modules/.bin/fallow` exit 0, "0 above threshold · 16329 analyzed · maintainability 91.1"; touched files 6 files / 41 tests exit 0; `npx vitest related --run` for `link-anchoring.ts` 118 files/540 tests, `resolver.ts` 116/518, `page-renderer.ts` 89/406, `compile-report.ts` 86/409, `index.ts` 84/385, and `types.ts` maps no test file and exits 0 with none. Coverage caveat unchanged: `.fallowrc.json` ignores `packages/llmwiki-kg/**`.

DIFFERENTIAL against `540f464` in a `mktemp -d` tree: the same scenario (a page with no links and no mentions, rendered, written, then linked) produces byte-identical body `"\n## Facts\n\nNetworks hold facts.\n"`, identical stdout and stderr apart from the run's own duration line, and exit 0 in both trees. The known limitation of record: `review-approve.ts` calls `resolveAndApplyLinks` without gate options, so an approved candidate is judged against the resolver's own index — concept pages only — which is narrower than the pre-T12 gate's `wiki/` listing for a `queries` target. Passing the seam there needs `src/commands/review-approve.ts`, outside T12's surfaces.

L7 (T4 delivered, `fe48024e6a72477e8e775a291d2c82895d546279` `feat(compiler): review earlier pages for references to a new article`):

RETRIEVAL VERSUS DECISION, stated separately, because S14 turns on which one guesses.

- RETRIEVAL is DETERMINISTIC AND LEXICAL. `src/compiler/link-review.ts` lists the wiki's earlier concept pages (slug order, orphaned pages and this run's own articles excluded) and offers an article to a page only when that page's own text already contains the article's TITLE or one of its DECLARED ALIASES as a plain mention — not inside an existing `[[link]]`, a `^[citation]` or a literal code span, and not glued to a longer word (`Vector Database` is not found inside `Vector Databases`). There is no anchor without those words, so a page that never names the article is never even proposed, however close the topics are.
- SIMILARITY RETRIEVES NOTHING AND DECIDES NOTHING. No embedding, no cosine score and no vector store is an input to this stage. That is the strongest available reading of S14 ("similarity may RETRIEVE candidates, it may never DECIDE ... link creation"): a metric cannot propose a link because no metric is read. The `relatedPages` ranking below is textual for exactly the same reason.
- DECISION is the model's, one call per candidate, through a new `judge_reference` tool schema and `buildLinkReviewPrompt` in `src/compiler/prompts.ts` (`PROMPT_VERSION` v7 -> v8). It sees the page's surrounding paragraph and the target's title and answers whether linking THIS mention helps THIS page's reader. A `false` changes nothing.
- THE ANCHOR is enforced after the verdict: the words the model quoted must still be a plain mention of the page at edit time (`wrapMention`). A verdict the page cannot anchor is counted `unusable` and never forced onto the page.
- THE FINAL GATE STILL DECIDES TOO. The body the verdict produced is judged by `validateContextualLinks`, the same table and per-page budget as every other link; if the gate demotes the new link the body comes back unchanged and nothing is written.
- SCOPE, honest and visible: the article page's body keeps every byte except the one mention span (`mention` -> `[[slug|mention]]`), frontmatter included, built as `content.replace(body, () => newBody)` so page prose is never reinterpreted as a replacement pattern. Only pages whose text really changed are written, through `applyCompilePageWritesLocked` (the trust floor). In a LIVE compile the pre-existing inbound resolver pass already wraps plain TITLE mentions, so what this stage adds there is alias mentions plus the mentions the earlier channels skipped or refused — every one of them now judged by content instead of assumed.

BOUNDS (all three in `src/utils/constants.ts`, each with the JSDoc justification this repository requires, each counted per reason in `LinkReviewCounts.truncated`):
- `MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE = 4` — reason `article-cap`. One review call per candidate, so a common word in a title must not put the whole wiki in front of the model per ingest.
- `MAX_LINK_REVIEW_PAGES_PER_RUN = 20` — reason `run-cap`. Bounds the run's review calls, which is what a first compile of a large corpus would otherwise explode into.
- `MAX_LINK_REVIEW_PAGES_MODIFIED_PER_RUN = 3` — reason `modify-cap`. Bounds the WRITES, the part a reader of the wiki sees; each one rewrites an already-authored page. Reviews still happen past it (the answer was paid for), only the write is refused.

TRUNCATION SURFACES in ONE compile-report line: `reportLinkReview` (`src/compiler/compile-report.ts`) prints `Link review of earlier pages: N review(s) of M earlier page(s), L link(s) added in K page(s), R refused, truncated 1 modify-cap.` It is a WARNING when a bound fired and information otherwise, and it is SILENT only when the stage found no candidate, reviewed nothing and dropped nothing — so no limit is ever silent (S12).

relatedPages DEFECT FIXED (L4 recorded it as T4's surface): `renderMergedPageContent` no longer hands the prompt the first N slugs of the directory. `rankRelatedSlugs` orders the siblings by mentions of the concept's canonical name (descending), then mentions of its aliases (descending), then slug (deterministic tie-break), and only the top `RELATED_PAGE_CONTEXT_LIMIT` reach the prompt. It stays retrieval CONTEXT: it creates no link and is not an input to any link decision. The sibling bodies are read ONCE per run (`buildRelatedPageIndex`, threaded on the merged entries through `MergedConcept.relatedPages`), so ranking does not turn one compile into pages x pages confined reads; a run with nothing to render reads nothing.

TESTS (test-first, all driven through public surfaces; RED observed before implementation):
- `test/compiler/link-review.test.ts` — V1 a yes verdict adds exactly one `[[vector-db|Vector Database]]` at the mention and `before.replace(...)` proves every other byte identical; V2 a no verdict writes nothing; V3 `article-cap` truncates and is counted and reported; V4 `modify-cap` truncates writes, is counted and reported, and the page past the cap carries no link; V5 a thematically similar page that never names the article gets no review call and no link; V6 PIN no candidate mention means zero writes, zero review calls and a silent report. RED: `Failed to load url ../../src/compiler/link-review.js ... Does the file exist?`
- `test/compiler/page-renderer-related-pages.test.ts` — V7 the ranked selection is asserted by exact slug list `["e","f","b","a","c"]` AND asserted not to be the alphabetical slice `["a","b","c","d","e"]`, plus the in-prompt order; the preserve case pins that fewer pages than the limit all survive in slug order. RED: `TypeError: rankRelatedSlugs is not a function`.
- `test/compiler/link-review-compile.test.ts` — V8 a second compile of an unchanged wiki changes no byte under `wiki/concepts` and prints no `Link review` line; plus the pin that recompiling ONE article leaves a different earlier page byte-identical. Both through `compileAndReport`.
- `test/compiler/prompts-anchored-links.test.ts` — the `PROMPT_VERSION` pin moved v7 -> v8; the page prompt's own wording is unchanged.

GATES (Node v24.21.0, quiescent tree): `npx tsc --noEmit` exit 0; `npm run typecheck:tests` exit 0 (1684 files, 260 baseline diagnostics, no regression); `npm run build` exit 0 (ESM + DTS); `npm run test:affected` exit 0, 792 files / 6049 tests passed, 3 files / 4 tests skipped; `./node_modules/.bin/fallow` exit 0, "0 above threshold · 16423 analyzed · maintainability 91.1 (good)"; the four touched test files 30 tests passed; `npx vitest related --run` per changed source: `link-review.ts` 88 files/417 tests, `index.ts` 85/387, `compile-report.ts` 87/411, `page-renderer.ts` 91/410, `prompts.ts` 104/530, `constants.ts` 565 files/3959 tests, `types.ts` maps no test file. Coverage caveat unchanged: `.fallowrc.json` ignores `packages/llmwiki-kg/**`.

DIFFERENTIAL against `2d675d7` (scratch tree `/tmp/t4-diff-crlfkq`, outside the worktree, left in place): the compile of a wiki with NO new articles produced identical stdout, identical stderr, exit 0 in both trees, and byte-identical `wiki/concepts/*.md`, `wiki/MOC.md`, `.llmwiki/state.json` and `log.md`. The only differences are each run's own wall clock (`Generated <now>` in `wiki/index.md`, `updatedAt` in `.llmwiki/embeddings.json`), which no change could make equal.

NOT DONE, outside T4's surfaces: `src/commands/review-approve.ts` does not run the reference review, so an article created by approving a candidate gets no earlier-page review on that path; and `src/services/ingest/jobs/types.ts` (`CompileStage`) is out of surface, so no new job stage name was added and the review runs inside the existing `compile.finalize` timing boundary.

L8 (T4b delivered as `ae765f4bc1ff5f678aee3ea3989ba1c4eca94bc7` `fix(compiler): match earlier-declared aliases when reviewing references`, and T13 as `070436a645e5f516de3120990838918cd40e7c9c` `fix(commands): gate review-approve links against the full page set`):

Both tasks close gaps the previous deliveries disclosed. Neither adds a mechanism; each connects an existing one to the place that was not using it.

T4b — THE ALIAS GAP (S6, S9, S14). `src/compiler/link-review.ts` retrieved earlier pages by matching the article's TITLE plus the aliases the identity stage folded DURING THIS RUN. The names an article resolved in an EARLIER ingest live in its page's frontmatter — T2 persists them precisely so identity stays deterministic across runs — and retrieval ignored them, so a page that had called the concept by an established synonym for runs on end was never even considered, which defeats the persistence. `withDeclaredAliases` now reads the article page's `meta.aliases` (the existing `parseFrontmatter` parser, through the same confined reader and the same content seam every other read uses) and `extraNames` unions three sources: the current run's folded names first, then the declared ones, deduped by `canonicalConceptKey` with the title's own key pre-seeded so the title is never repeated as its own alias. The rest of the predicate is untouched: a plain mention, not inside an existing `[[link]]`, `^[citation]` or code span, not glued to a longer word. Retrieval stays lexical and deterministic, so S14's fence is intact — nothing numeric was added to either retrieval or decision.

T13 — THE APPROVE-PATH PARITY GAP (S8, S12). `src/commands/review-approve.ts` called `resolveAndApplyLinks` with NO gate options. On a row-backed run the gate then fell back to the pages the resolver had already enumerated — the CONCEPT namespace — so a `queries` target was a real, linkable page when a compile wrote a body and a missing target when `review approve` wrote the identical body. Same wiki, same link, two outcomes from nothing but the entry point. The construction lives privately in `src/compiler/index.ts` (`linkGateFor`, outside this task's surfaces), so the shared construction now sits beside the type it builds, in `src/compiler/resolver.ts`: `linkGateOptions(pageContent, sink?)`, and the approve path passes `linkGateOptions(seams.content)` — the seam the pages were written through, so the page set read cannot disagree with the corpus just written. Reported, not hidden: `index.ts`'s `linkGateFor` still builds its own options and should delegate to `linkGateOptions` in a follow-up edit to that file; that is a two-line, behaviour-preserving change and it was outside the authorized surfaces here.

KNOWN LIMITATION (recorded, NOT built — out of scope by delegation): approving a candidate still does not run the incremental reference review of T4/S9. The approve verb writes the page, resolves its links and repairs them; it does not offer the new article to earlier pages. Running the whole incremental review stage on the approve path is a separate change.

TWO MORE SEAM LIMITATIONS FOUND WHILE TESTING, both pre-existing and both outside these surfaces:
1. A row-backed run cannot see stored aliases at all: `renderPageMarkdown` (`src/dimensions/wiki/page-scan-source.ts`) re-emits title, summary, tags and status flags from the row columns, and `wiki.pages` has no aliases column. On a Stack, then, T4b's union contributes the title and the names folded in the CURRENT run only; file-backed runs get all three sources. Closing it needs the row writer and schema.
2. `checkCandidatePublication` refuses a candidate whose links a FILE-only citation index (`collectAnswerCitationIndex`) cannot resolve, so on a Stack with no `wiki/` on disk EVERY candidate link is refused before the link gate is reached. The new A1/A2 cases seed the target file for that gate so they measure the link decision; the citation index should read the run's backend in a later task.

TESTS (test-first, public surfaces only).
- `test/compiler/link-review.test.ts` gains V7 and V8. V7 RED: `expected +0 to be 1` — with the pre-fix title-only predicate the run found ZERO candidates for a page mentioning an alias declared only in the article's stored frontmatter; it now finds one, reviews once, and writes exactly one `[[vector-db|Vector Store]]` with every other byte identical. V8 is a PIN, green before and after: a stored alias equal to the title is not double-counted (one candidate, one review call, one link). `writeArticle` gained an `aliases` parameter for this, documented as the frontmatter source, deliberately separate from the `LinkReviewArticle` the stage receives.
- `test/commands/review-approve-links.test.ts` is new, three cases on a REAL Stack plus one file-backed check. A1 RED: the approval exited 0 and the stored row body read `See Saved Query for the details.` — the link demoted — instead of `[[saved|Saved Query]]`. A2 RED in the same run shows the same demotion, then proves the gate's RULES came along with the wider page set: in one body the anchored link is kept once, a repeat of the same target in the same section is demoted as redundant (`Again: Saved Query`), and a self-reference is demoted (`self: Approved Links.`). A3 is the PIN that the file-backed approve did not move: exit 0, `Approved → <absolute path>`, `Candidate <id> cleared.`, empty stderr, and the page bytes written verbatim.

EXISTING BEHAVIOUR RELIED ON, re-run and green (8 files / 55 tests): `test/review.test.ts`, `test/review-integration.test.ts`, `test/dimensions/rows-only-review-approve.test.ts`, `test/review-approve-planner.test.ts`, `test/review-approve-drains-pending.test.ts`, `test/resolver.test.ts`, `test/resolver-dollar-patterns.test.ts`, `test/compiler/link-review.test.ts`.

GATES (Node v24.21.0, quiescent tree, full set per commit).
T4b, on `ae765f4`: `npx tsc --noEmit` exit 0; `npm run typecheck:tests` exit 0 — "1684 files checked; 260 baseline diagnostics in 94 files; no regression"; `npm run build` exit 0 (ESM + DTS); `npm run test:affected` exit 0 — 789 files / 6051 tests passed, 3 files / 4 tests skipped (792 / 6055), no failing test named because none failed; `./node_modules/.bin/fallow` exit 0 — "0 above threshold · 16430 analyzed · maintainability 91.1 (good)"; touched test files exit 0, 2 files / 10 tests; `npx vitest related --run src/compiler/link-review.ts` exit 0, 88 files / 419 tests.
T13, on `070436a`: `npx tsc --noEmit` exit 0; `npm run typecheck:tests` exit 0 — "1685 files checked; 260 baseline diagnostics in 94 files; no regression"; `npm run build` exit 0; `npm run test:affected` exit 0 — 790 files / 6054 tests passed, 3 files / 4 tests skipped (793 / 6058), no failure observed; `./node_modules/.bin/fallow` exit 0 — "0 above threshold · 16443 analyzed · maintainability 91.1 (good)"; `npx vitest run test/commands/review-approve-links.test.ts` exit 0, 1 file / 3 tests; `npx vitest related --run src/commands/review-approve.ts` exit 0, 47 files / 265 tests; `npx vitest related --run src/compiler/resolver.ts` exit 0, 118 files / 523 tests.

UNNAMED-FLAKE INVESTIGATION OUTCOME: the previous worker saw `test:affected` fail once with a single unnamed test. This delivery ran it once per commit and captured FULL output to a file each time (`/tmp/t4b-test-affected-1.log`, `/tmp/t13-test-affected-1.log`): both runs exited 0 with zero `×`/`FAIL` lines, so no unnamed failure was reproduced and there is nothing to name; one earlier intermittent failure remains unexplained but is not evidence of a regression in either commit. Coverage caveat unchanged: `.fallowrc.json` ignores `packages/llmwiki-kg/**`, so a clean `fallow` result is never coverage of that package; it is covered only by its own typecheck entry points.

RISK: item 3 is NOT claimed. The only shared code touched is `src/compiler/resolver.ts`, gaining a NEW exported construction (`linkGateOptions`) that nothing else calls; no existing option, parser, helper or validation rule changed, and every existing resolver and review suite above still passes with its assertions unmodified. The behaviour change is confined to the approve verb, which is the change that was asked for.

L9 (T14 delivered as `c8de1242a6da0cd150f7c0a2d5540f77e0cb3fdd` `refactor(compiler): split link review into retrieval and orchestration modules`):

A SHIPPED CONVENTION VIOLATION, NOT A TOLERATED CONDITION. `AGENTS.md` `Code Style & Standards`: "Code files (TypeScript, Python, JavaScript, shell, SQL) must be smaller than 400 lines excluding comments." `src/compiler/link-review.ts` crossed that ceiling when T4b added the declared-alias union (397 -> 434 by the measure below). T14 restores it by splitting the file, and pays the duplication debt T13 disclosed in `index.ts`.

HOW THE COUNTS WERE MEASURED, so the numbers are reproducible. Two measures, both reported:
- P ("total minus comment-only lines", the measure that produces the figure this task stated): `grep -cvE '^[[:space:]]*(//|\*|/\*)' FILE`, i.e. blank lines count, lines that are entirely comment do not. The task statement's 435/398 is this same measure counted one higher (its final newline treated as a line); my run reproduces 434 for the pre-split file and 397 for the pre-T4b version.
- STRICT ("strip-comments, blanks elided", the repository's own rule from `test/fixtures/strip-comments.ts`: comment bytes blanked, string literals kept, a line counts when anything non-blank survives).

Counts (total lines / P / STRICT):
- `src/compiler/link-review.ts` BEFORE: 697 / 434 / 394 (over the ceiling under P).
- `src/compiler/link-review.ts` AFTER: 423 / 246 / 227.
- `src/compiler/link-review-candidates.ts` (new): 365 / 209 / 185.
- `src/compiler/index.ts`: 1641 / 952 / 886 -> 1643 / 952 / 886 (non-comment unchanged; the +2 total lines are JSDoc on the delegating `linkGateFor`). Its 886 non-comment lines are a PRE-EXISTING violation of the same ceiling, untouched here because T14's surface for it is the duplication only.
- `src/compiler/resolver.ts`: untouched (0 lines changed) -- the unification did not need it.
Both new modules sit under the ceiling with headroom on both measures, which is the point of splitting "comfortably", not "barely".

THE AXIS, confirmed against the code before committing to it: NAME/MENTION/CANDIDATE RETRIEVAL versus STAGE ORCHESTRATION.
- `src/compiler/link-review-candidates.ts` owns RETRIEVAL only: the three name sources an article answers to (canonical title, the names the identity stage folded this run, the `aliases` its stored frontmatter declares), the plain-mention predicate (not inside an existing `[[link]]`, a `^[citation]` or a literal code span, not glued to a longer word), the earlier-page listing in slug order, and the bounded candidate list with `article-cap` / `run-cap` accounting. It decides no link, calls no model, reads no embedding and writes no page.
- `src/compiler/link-review.ts` owns ORCHESTRATION: it asks retrieval for candidates, judges each one through `judge_reference`, performs the surgical single-span edit, gates the result through `validateContextualLinks` and writes only the pages whose text really changed. The dependency runs one way: orchestration -> retrieval.

PURE MOVE, PROVEN RATHER THAN ASSERTED. The union of the two modules' non-comment code lines was compared against the pre-split file as a sorted line multiset; the only differences are the ones the move requires: `export` modifiers on the symbols retrieval now shares, the split import blocks, `counts` -> `tally` inside `collectCandidates` (it now reports into a narrow `CandidateTally` slice of the stage's counts instead of the whole record), and the private `countLinks` becoming `countWikilinks` beside the `WIKILINK_PATTERN` that defines what a link is. No statement, condition, ordering, counter or side effect changed. `LinkReviewArticle` and `LinkReviewTruncationReason` are re-exported from `link-review.ts`, so NO importer changed and NO test file changed at all: `git diff --stat -- test/` is empty across both commits.

DUPLICATION REMOVED (the T13 follow-up). `src/compiler/index.ts`'s `linkGateFor` no longer assembles the gate options; it delegates to the resolver's exported `linkGateOptions(pageContent, sink?)`, the ONE construction `review approve` already uses, passing `seams.content` and this run's aggregate collector. Behaviour-preserving: `{pageContent, sink?}` either way, and the sink is still created only when the run keeps totals.

NO TEST ASSERTION CHANGED, and the evidence is behavioural instead. This is a refactor with no new behaviour to assert, so test-first does not apply: there is no rule to write a failing test for, and inventing one would have meant inventing a behaviour. The proof that nothing moved is the existing suite plus one differential check: a scratch probe (never committed, `/tmp` only) ran the same compile scenario -- two concepts, a typed link, a redundant repeat and a self-mention, so the gate keeps, demotes and reports -- against a copy of base `6229c42` in a `mktemp -d` tree and against this change, both with `node_modules` symlinked and the SAME probe file. Result: identical exit code (0), identical stdout including both contextual-link report lines (`Contextual links in this run: 2 kept, 1 demoted (1 redundant).`), identical stderr (empty) and byte-identical pages, with the only diff being the timestamps the run stamps into frontmatter, `state.json`, `log.md` and the index footer; after normalizing those, the two outputs diff clean.

GATES (Node v24.21.0, quiescent tree, scope stated per command; no failing test to name and no re-run needed):
- `npx tsc --noEmit` -- exit 0, no diagnostics.
- `npm run typecheck:tests` -- exit 0: "Test type-check: 1686 files checked; 260 baseline diagnostics in 94 files; no regression."
- `npm run build` -- exit 0: ESM + DTS build success, `dist/cli.js` 498.12 KB, viewer assets copied.
- `npm run test:affected` -- exit 0: 790 test files passed / 3 skipped (793), 6054 tests passed / 4 skipped (6058). Full output captured to `/tmp/t14-count/test-affected-t14.log`; zero `×`/`FAIL` lines.
- `./node_modules/.bin/fallow` -- exit 0: "0 above threshold, 16443 analyzed, maintainability 91.1 (good)", dead files 0.0%, dead exports 0.0%. Its duplication section reports 61 duplicated lines across 6 files, all of them PRE-EXISTING test-file clone groups (`link-gate.test.ts`/`page-renderer-contextual-links.test.ts`, `links-here-cli.test.ts`/`race-cli.test.ts`, `ghost-rule.test.ts`, `race-path.test.ts`) that this change neither introduced nor touched.
- Touched-file tests: `npx vitest run test/compiler/link-review.test.ts test/compiler/link-review-compile.test.ts` exit 0, 2 files / 10 tests.
- `npx vitest related --run` per changed src file: `src/compiler/link-review.ts` 88 files / 419 tests exit 0; `src/compiler/link-review-candidates.ts` 88 files / 419 tests exit 0; `src/compiler/index.ts` 85 files / 387 tests exit 0.
- Never claimed: the full `npm test` suite was not run (CI is the gate of record for it).
- Coverage caveat unchanged: `.fallowrc.json` `ignorePatterns` contains `packages/llmwiki-kg/**`, so a clean `fallow` result is never coverage of that package.

KNOWN LIMITATIONS STILL OPEN, unchanged by T14 (disclosed in L8, carried into the delivery report): stored aliases in frontmatter are invisible to row-backed runs because `wiki.pages` has no aliases column, so T4b's retrieval union contributes only the title and the current run's folded names on a Stack; and `checkCandidatePublication` uses a file-only citation index, so on a Stack with no `wiki/` on disk candidate links are refused as broken citations before the link gate runs.

L10 (T5a delivered as `167cb67395845007463b24f7d29f8376718c2f7e` `feat(categories): add the category object with stable identity`; object model and store ONLY — no compile integration, no CLI, no closed-set change):

THE STORAGE DECISION, and why it is the only one that needed no migration. A category is NOT a page and NOT a derived artifact:
- not a page: `PageDirectory` (`src/export/types.ts`) and the SQL `CHECK` on `page_directory` (`src/dimensions/wiki/schema.sql`) are CLOSED sets, so recording N categories in the page store would need a migration for an object type that is deliberately not a page, and modelling a category as a page-with-a-tag is exactly what S4 forbids;
- not a derived artifact: the derived-artifact store keys on `(stack_id, kind)` with a constrained `kind` and one row per kind, so it can hold one artifact of a kind and not N categories;
- therefore one markdown file per category at `wiki/categories/<categoryId>.md`. `wiki/concepts/<slug>.md` is untouched. A concept and a category with the same canonical name are two files in two directories, which is what makes S4 STRUCTURAL rather than a convention.

THE FOUR REQUIRED FIELDS (S10), all validated, all refused-not-defaulted: `categoryId` (stable identity, minted from the canonical name at creation), `canonicalName`, `description` (required, non-empty), `inclusionCriterion` (required, non-empty). A record missing any of them raises a typed `CategoryValidationError` naming the field and writes NOTHING — not an empty file, not a directory, no defaulted value.

IDENTITY STAYS STABLE ACROSS A RENAME, structurally: `buildCategoryRecord` mints `categoryId = slugify(canonicalName)` ONCE, and `mergeCategoryPatch` carries `record.categoryId` through untouched while only patching the fields present in the patch. Nothing re-derives the id from the current name, so a rename keeps both the id and the file, and a test pins it (same id, same path, one file in the directory, `createdAt` preserved).

MEMBERSHIP IS STORED AS EVIDENCE (scope addition to T5a, same surfaces). Each member is an ENTRY, not a bare id: `pageId`, `reason` (required — an entry with a missing or blank reason is refused with `CategoryValidationError` field `memberReason` and nothing is written, N8) and `evidenceKey` (the canonical key of the criterion or name evidence that justified it). Absent a supplied key the category's own criterion key is recorded, computed with the same `slugify` rule category ids use — so the key can be recomputed from the stored criterion to audit it — and it is recorded AT ASSIGNMENT TIME, never recomputed on a later criterion edit: it is evidence of what justified the page THEN. The file is therefore self-sufficient: the frontmatter carries all three parts per member, and the body shows `- <pageId> — <reason>` for a reader.

THE NAME-COLLISION PROOF (S4, test N2): a concept page `wiki/concepts/sistemas-distribuidos.md` and a category with canonical name "Sistemas distribuidos" coexist as two files in two directories, with two distinct identities (`concepts/sistemas-distribuidos` versus `categories/sistemas-distribuidos`, so no id can stand for both); the concept page is byte-identical after the category is created, `readPageRecord` still returns the CONCEPT (its title and summary), `readCategory` returns the CATEGORY (no `summary`/`title`/`sources` fields), the category file carries category frontmatter and no page frontmatter, and the collision neither auto-attaches the same-named page to the category nor absorbs the category into the page.

THE BOUND (S12): `MAX_CATEGORY_MEMBERS_LISTED = 100` in `src/utils/constants.ts`, JSDoc'd with its reason (a broad category legitimately covers hundreds of pages; an unbounded list would make the file grow with the wiki, turn a readable page into an index dump, and make each rewrite larger than the last). It bounds the RENDERED LISTING only — the complete member set stays in the frontmatter, so truncation costs a scroll, not evidence — and every truncation is reported twice: `MemberTruncation {reason:"member-cap", cap, listed, omitted}` in the returned write result, and the sentence "N more member(s) recorded but not listed" printed into the file itself.

DETERMINISTIC MEMBER ORDER (N7): entries are deduplicated by page id and ordered by page id, then reason, then evidence key, all by UTF-16 code unit (`localeCompare` is deliberately avoided so the order cannot depend on the host locale). The stored order is a function of the SET, never of input order, and each reason travels with the page it justifies rather than being re-paired by position.

THE TRUST-LAYER API ACTUALLY USED, and what it required. `planPageMutation({root, target:{kind:"raw", directory:"categories", slug:categoryId}, body, origin:"category", reviewRouted:false, allowOverwrite})` (`src/trust/planner.ts`) then `applyApprovedMutations(root, planned)` (`src/trust/executor.ts`, the locked + journalled batch). The raw path is what makes a non-page directory legal WITHOUT touching a closed set: `planPageMutation`'s raw branch derives `wiki/<directory>/<slug>.md` (`pageTargetPath`) and guards it with `checkDefaultIdentitySafe` — `isSafeFilenameComponent` on the directory and the slug, i.e. "a safe single path component", NOT membership in `PageDirectory` — before the mandatory floor runs (path confinement, collision unless an overwrite was declared, the `MAX_SOURCE_CHARS` cap since the origin is not `compile`, frontmatter parse). No confinement bypass was needed and none was introduced; `origin` is its own string rather than `"compile"` precisely so a category never inherits the large merged-page cap. A blocked plan raises `CategoryWriteRefusedError` and writes nothing. Reads stay confined: `wiki/categories` is realpath'd, `confinedRegularFile` rejects a symlinked or non-regular leaf, and `parseCategory` refuses a file whose declared `categoryId` disagrees with the file name (identity and file name must agree). An empty project has no directory and `listCategories` returns `[]` without creating one (N6).

TESTS (test-first, public surfaces only; 3 files / 17 tests, each case driven through `createCategory`/`readCategory`/`listCategories`/`updateCategory` and the file bytes): N1 the file lands at the id-derived path and all four required fields round-trip (plus a second case proving each member's `pageId`, `reason` and `evidenceKey` round-trip losslessly); N2 the name-collision proof above; N3 rename keeps `categoryId` and the same file; N4 a draft with a blank canonical name, description or inclusion criterion is refused with the field named and no directory created, an update that would blank one leaves the file byte-identical, and an id that is not a safe filename component is refused without a write; N5 the cap truncates at 100 entries, reports `omitted: 2`, keeps all 102 in the frontmatter and prints the note, while a set under the cap lists every entry in order; N6 the empty project; N7 identical stored order and identical body for the same set whatever the input order (with the reason asserted to travel with its page), and a repeated member counted once; N8 a member entry with no reason — or a blank one — is refused with `memberReason` and nothing written, and a separate case pins that an entry with no evidence key records the criterion key.
RED observed before implementation, both phases: the first phase failed with `Failed to load url ../../src/categories/index.js ... Does the file exist?` across 3 files / 0 tests; the scope addition produced 8 failing cases (`N1`, `N2`, `N5`x2, `N7`x2, `N8`x2) with the explicit refusal assertion `expected 'members' to be 'memberReason'` while N3/N4/N6 kept passing — that pass set is the PRESERVE evidence for the fields and refusals the addition did not change.

GATES (Node v24.21.0, quiescent tree, on the committed tree; scope stated per command, no failing test to name and no re-run needed): `npx tsc --noEmit` exit 0, no diagnostics. `npm run typecheck:tests` exit 0, "1699 files checked; 260 baseline diagnostics in 94 files; no regression". `npm run build` exit 0 (ESM + DTS). `npm run test:affected` exit 0, 793 files / 6071 tests passed, 3 files / 4 tests skipped (796 / 6075), full output in `/tmp/t5a-test-affected-final.log`, zero `×` lines. `./node_modules/.bin/fallow` exit 0, "0 above threshold · 16528 analyzed · maintainability 91.1 (good)", dead files 0.0%, dead exports 0.0%, and its duplication section back to the 4 PRE-EXISTING test clone groups (61 lines / 6 files) that this change neither introduced nor touched — the 3-instance helper clone my first test draft added was removed by moving the temp-root fixture into `test/fixtures/category-root.ts`. `npx vitest run test/categories/` exit 0, 3 files / 17 tests. `npx vitest related --run` per changed src file, all exit 0: `src/categories/{store,markdown,model,members,identity,types,validation,index}.ts` 30 files / 169 tests each, `src/compiler-cli.ts` 27 / 152, `src/utils/constants.ts` 569 files / 3981 tests (3 skipped). NOT run: the full `npm test` suite (CI is its gate of record). Coverage caveat unchanged: `.fallowrc.json` ignores `packages/llmwiki-kg/**`, so a clean `fallow` result is never coverage of that package.

NOTHING EXISTING CHANGED: `git diff --stat` shows only `src/compiler-cli.ts`, `src/utils/constants.ts` and the new `src/categories/`, `test/categories/`, `test/fixtures/category-{root,record}.ts`; `git diff --stat -- src/compiler src/cli src/dimensions src/export src/pages` is EMPTY. No `PageDirectory` edit, no SQL edit, no schema migration, no derived-artifact `kind` added.

RISK: item 3 is not claimed. The only shared code touched is `src/utils/constants.ts` (three NEW constants) and `src/compiler-cli.ts` (NEW re-exports); no existing option, parser, helper, validation rule or closed set changed, and the existing suites above pass unmodified. Out of T5a's surfaces and left to T5b: compile-time category assignment, the page-to-category projection (from a page, see its categories) and the reader/writer seam for row-backed Stacks — a category is a FILE, so on a Stack-backed project the file exists while `wiki.pages` knows nothing about it, which is deliberate (a category is not a page) but means navigating categories from the page side is T5b's job.

L11 (T15 delivered as a MEASUREMENT task: `test/compiler/wiki-stability.test.ts`, new, 8 cases; no `src/` change. Commit pending — this worker's tool contract forbids staging/committing, so the parent commits `test(compiler): pin the wiki stability defects the overlay must fix`, records that SHA in the T15 row, then commits `docs(odd): record T15`):

THE TASK WAS TO MEASURE, NOT TO FIX, AND THE MEASUREMENT REFUTED TWO OF THE FOUR ASSUMPTIONS. The premise — "stage 5 adds a link to page A, and page bodies are regenerated wholesale, so the link is destroyed" — is right about the mechanism and wrong about the current reachability: today that link cannot be created by any compile at all, and cannot even be proposed for the alias form the design needs. Three independent defects, each pinned by an inverted test.

DEFECT A — THE REFERENCE REVIEW IS NOT WIRED INTO THE PIPELINE (S9). `reviewEarlierPagesForRun` is defined at `src/compiler/index.ts:1272` and called by NOTHING. `git grep -n reviewEarlierPages` over `src/` at tip `7a5f548` returns exactly: the import (`index.ts:60`), the definition (`index.ts:1272`), its single call to the stage (`index.ts:1278`), the stage itself (`src/compiler/link-review.ts:214`), and two `{@link}` doc references. `finalizeWiki` (`index.ts:1304-1372`) runs `resolveAndApplyLinks` and `repairAndApplyLinks` and stops. The same single-occurrence shape holds at every commit from T4's own `fe48024` to the tip, so this is not a regression introduced later: the stage has never run inside a compile. Consequence, and it is a false-green worth knowing: `test/compiler/link-review-compile.test.ts` V8 ("prints no `Link review` line") passes VACUOUSLY, because the stage that would print it is never entered. Fix shape is one call site; it is a `src/` change and out of T15's surfaces.

DEFECT B — READ-TIME RETRIEVAL THROWS AWAY THE ALIAS IT EXISTS TO MATCH (S6, S9). `withDeclaredAliases` unions the article's title, this run's folded names and the page's stored `aliases`, then `extraNames` (`src/compiler/link-review-candidates.ts:222-235`) dedupes that union by `canonicalConceptKey` — the tiered key that folds case, plurals and a reviewed acronym list (`db` -> `database`, `api`, `llm`, `rag`, ...: `src/dimensions/wiki/concept-identity.ts:39-48`). The MENTION SCAN it feeds matches the names LITERALLY by regex (`firstPlainMention`, same file, line 282). So every alias a NAME RULE folds in the same run is dropped before the scan sees it, because those folds REQUIRE the two spellings to share the canonical key (`applyNameRules` over `createConceptForest`, `src/dimensions/wiki/concept-resolution.ts:571-577`). An alias that reaches a page through a previously DECLARED alias (`matchIncumbent`'s `alias` tier, `concept-resolution.ts:321-345`) has a different key and does survive, which is why the fixture declares one by hand for the curation cases. Observed: beta's extraction yields `Vector DB` and `Vector Database`; the page is written as `vector-db` titled `Vector DB` with `aliases: [vector-db, Vector Database]`; calling `withDeclaredAliases` on it returns `aliases: []`. The narrower consequence: any title containing an expandable acronym (`Vector DB`, `RAG Pipeline`, `LLM Wiki`) loses its expanded spelling, and any plural-differing alias is lost the same way. Fix shape: dedupe on the literal spelling.

DEFECT C — A CURATED LINK LIVES ONLY IN GENERATED BYTES, AND THE PASSIVE CHANNEL COVERS TITLES ONLY. The stage writes the page as `edit.page.content.replace(edit.page.body, () => validated.body)` (`src/compiler/link-review.ts:382`) through `applyCompilePageWritesLocked` (`link-review.ts:409`); nothing else records the curation. The next render replaces the whole body: `renderMergedPageContent` (`src/compiler/review-pipeline.ts:69`) returns `${frontmatter}\n\n${pageBody}\n` built from one model call (`src/compiler/page-renderer.ts:94-133`), and the write lands via `index.ts:291` -> `commitLivePageWrites` -> `applyCompilePageWritesLocked` (`index.ts:386`). What can put a link back: `addWikilinks` (`src/compiler/resolver.ts:303-309`) wraps plain mentions of page TITLES only — its index is built from `meta.title` (`buildTitleIndex`), and declared `aliases` are carried on the entry for the GATE, not for wrapping. So a TITLE-anchored curated link is re-created by the resolver on every re-render (no defect observable through that form), while an ALIAS-anchored link has no channel at all. That asymmetry is the reason every curation case in the new test file anchors on an alias, and it is the single most important constraint on the fix: a durable record plus a render-time overlay would be the FIRST mechanism to preserve alias-anchored links, and must not double-link what the resolver already restores.

S-A1 — RAW RED, VERBATIM (captured with the three S-A1 cases as plain `it(...)` before converting them to `test.fails`; `/tmp/t15-red-raw.log`):

```
 FAIL  test/compiler/wiki-stability.test.ts > wiki stability across ingests > S-A1 the compile adds the curated link when it ingests the target article
AssertionError: expected '---\ntitle: Alpha Topic\nsummary: Sum…' to contain '[[vector-db|pgvector store]]'

- Expected
+ Received

- [[vector-db|pgvector store]]
+ ---
+ title: Alpha Topic
+ summary: Summary of Alpha Topic.
+ sources:
+   - alpha.md
+ kind: concept
+ createdAt: "2026-11-06T20:59:31.410Z"
+ updatedAt: "2026-11-06T20:59:31.410Z"
+ tags: []
+ aliases:
+   - alpha-topic
+ modelId: claude-sonnet-4-6
+ promptVersion: v8
+ ---
+
+ Alpha Topic stores vectors in a pgvector store. ^[alpha.md]
+
 FAIL  test/compiler/wiki-stability.test.ts > wiki stability across ingests > S-A1 reviews a page that names the article by its folded alias
AssertionError: expected +0 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 0
 FAIL  test/compiler/wiki-stability.test.ts > wiki stability across ingests > S-A1 a curated link survives a re-ingest of the page that carries it
AssertionError: expected '---\ntitle: Alpha Topic\nsummary: Sum…' to contain '[[vector-db|pgvector store]]'

- Expected
+ Received

- [[vector-db|pgvector store]]
+ ---
+ title: Alpha Topic
+ summary: Summary of Alpha Topic.
+ sources:
+   - alpha.md
+ kind: concept
+ createdAt: "2026-11-06T20:59:31.659Z"
+ updatedAt: "2026-11-06T20:59:31.760Z"
+ tags: []
+ aliases:
+   - alpha-topic
+ modelId: claude-sonnet-4-6
+ promptVersion: v8
+ ---
+
+ Alpha Topic stores vectors in a pgvector store. ^[alpha.md]

 Test Files  1 failed (1)
      Tests  3 failed | 5 passed (8)
```

S-A1 VERDICT — CONFIRMED, WITH ITS SCOPE NAMED. The third block is the measurement the task asked for and it is unambiguous: the page was regenerated (`updatedAt` moved from `…659Z` to `…760Z`), the very mention the curated link was anchored on is STILL in the text (`pgvector store`), and the link is gone. Depends on no model whim: the fixture's rendered body is byte-identical across renders, so the only variable is that the body was replaced wholesale. The curated link's presence is a function of which article was reviewed last, not of either source's content — the ping-pong case now pins that as observed behaviour: link present after the review, absent after re-ingesting the page's own source, present again after re-reviewing the target article, with NO source change in between (the mention never moved). Two scopes stated so nobody overclaims: (1) it was measured by invoking the stage directly (`reviewEarlierPages`, the function `finalizeWiki` would call) because defect A means no compile reaches it; (2) the TITLE-anchored form does NOT reproduce the loss, because the resolver re-wraps title mentions — defect C's asymmetry.

S-A2 — IDEMPOTENT WHERE IT MATTERS, WITH ONE NAMED NON-DETERMINISM. A compile of unchanged sources prints "Nothing to compile — all sources up to date.", changes NO byte under `wiki/concepts` (fingerprint over the whole project, filtered to that directory: empty), and rewrites `wiki/index.md` with an identical page list in identical order — the file's only difference is its own generation stamp, `_<n> pages | Generated <ISO>_` (`src/compiler/indexgen.ts:179`), which is stamped on every regeneration because `regenerateIndices` has no unchanged-skip. Measured: the ONLY path under `wiki/` that changes on a no-op compile is `wiki/index.md`, and the two consecutive `index.md` bodies are byte-identical once that stamp is blanked. Not a defect (the stamp is a build marker, not wiki content), but it does mean "zero diffs" is false at the file level and must be stated as "zero diffs in page content and ordering". Second named churn, environment-specific: `.llmwiki/pending-embeddings.json` changes each run only because this stub run has no embedding key (`VOYAGE_API_KEY is not set`), so the write-ahead marker keeps a pending id; the test excludes `.llmwiki/` and says so in a comment. Category churn is NOT MEASURABLE: no compile writes `wiki/categories/` yet (T5a is the object model and store only; compile integration is T5b), so there is nothing to be non-idempotent about.

S-A3 — OBSERVED BEHAVIOUR WHEN THE JUSTIFYING MENTION DISAPPEARS. The link is gone (defect C), and it is also UNRECOVERABLE: retrieval requires a real mention (`firstPlainMention`), so with the words gone there is no candidate to re-review — `reviewEarlierPages` returns `reviewed: 0`, `linksAdded: 0` — and the compile that destroyed it printed no `Link review` line and no other warning. So today an anchor loss is a SILENT PERMANENT LINK LOSS, not something reported and not something the model can re-add. Pinned as a passing test, because this is what the code does; the pending overlay must decide what a durable record does when its anchor no longer exists (drop with a counted reason is the shape the rest of the pipeline uses) and that decision is the Manager's.

S-A4 — VERSION DETERMINISM IS A FUNCTION OF INPUT ONLY, NOT OF VERSION.
- WHERE IT IS RECORDED: `PROMPT_VERSION` (`src/compiler/prompts.ts:62`, currently `v8`) is stamped into PAGE FRONTMATTER by `addModelProvenanceMeta`, `fields.promptVersion = PROMPT_VERSION` at `src/compiler/provenance.ts:33`, called for every regenerated page (`src/compiler/page-renderer.ts:155`) and every seed page (`src/compiler/seed-pages.ts:177`). It is a PER-PAGE field, never a run field.
- WHERE IT SURFACES: read only by the exporter, `src/export/collect.ts:196` (`...(typeof meta.promptVersion === "string" ? { promptVersion: meta.promptVersion } : {})`) into `ExportPage.promptVersion` (`src/export/types.ts:169`). Those two are the ONLY non-comment occurrences in `src/` besides the constant and the writer.
- WHAT A BUMP DOES TO EXISTING PAGES: NOTHING. Nothing anywhere compares a stored version to the current one — the exhaustive `grep -rn promptVersion src/` result is the writer, the export reader, and comments. No page is invalidated, no page is regenerated, no state records a generation. A page keeps `promptVersion: v1` forever until its OWN source changes for an unrelated reason, at which point the whole body is regenerated and re-stamped (full regeneration, not drift). Measured: a page seeded with `promptVersion: v1` is byte-identical after a compile that regenerates another page, while that other page comes out at `v8` — so the wiki silently holds two prompt generations at once.
- IS IT OBSERVABLE TO A USER: NO. No compile-report line mentions it (`src/compiler/compile-report.ts` has none), no state field, no migration, no warning. Silence here is the defect the task predicted: `promptVersion` in an export cannot be used to tell whether the wiki is uniform, and a bump is a no-op the operator cannot see. Contrast, same repo, opposite design: prompt MODIFIERS do invalidate — `promoteForPromptModifiers` (`src/compiler/prompt-modifiers.ts:176-181`) promotes every unchanged source to `changed` when the recorded digest differs, and the digest is persisted in state (`src/utils/state.ts:291`) — so the machinery for version-driven invalidation exists and is simply not applied to `PROMPT_VERSION`. NOT a decision this task can take: invalidate-on-bump is a full regeneration (cost) versus report-only (a new surface), and both are product choices. Recorded as a finding with no inverted test, deliberately: a `test.fails` would have had to encode an invented remedy.

DESIGN INPUT — WHAT THE DURABLE CURATED-LINK RECORD MUST CARRY, AND EVERY WRITER THAT NEEDS THE OVERLAY (all `path:line` on tip `7a5f548`).
- The record must store, per link: the SOURCE page id (`concepts/<slug>`) and the TARGET page id (the resolved identity, not the written spelling, because `link-repair` canonicalises spellings later — `src/compiler/link-repair.ts:238-257,380`); THE ANCHOR — the exact mention text plus enough context to re-find it (the current stage already computes the anchored span: `firstPlainMention` -> `{text,start,end}`, `link-review.ts:266-278`); the PROVENANCE of the link (which run, which rule accepted it: model verdict via `judge_reference` versus resolver wrap versus repair), because only the curated channels need the overlay; and a stable key (source+target+anchor) so re-reviewing the same mention cannot append the link twice.
- It must live OUTSIDE the page body, i.e. its own file or row keyed by source page, because every mechanism below rebuilds bodies from scratch. A category-style `wiki/links/<id>.md` file through the trust planner is the precedent this branch already established (T5a), and a row would need the `page_directory` closed set untouched.
- The overlay must be applied at EVERY site that (re)writes a concept page body: (1) GENERATION — `renderMergedPageContent` (`src/compiler/page-renderer.ts:94`) called from `src/compiler/review-pipeline.ts:69`, written via `src/compiler/index.ts:291` -> `index.ts:386`. This is the destructive one. (2) OUTBOUND/INBOUND LINK PHASE — `resolveLinks`/`collectFinalBodies`/`linkBody`/`addWikilinks` (`src/compiler/resolver.ts:303,441-470`), written via `resolveAndApplyLinks` (`resolver.ts:585`), reached from `finalizeWiki` (`index.ts:1321`). Must run AFTER the overlay, or it will duplicate title links the overlay also wants. (3) THE CURATION ITSELF — `src/compiler/link-review.ts:382` -> `link-review.ts:409`. (4) REPAIR — `repairAndApplyLinks` (`src/compiler/link-repair.ts:415`), which rewrites link targets and could orphan a curated record's spelling. (5) SEED PAGES — `src/compiler/seed-pages.ts:81` with the body from `seed-pages.ts:156`. (6) ORPHAN MARKING — `src/compiler/orphan.ts:70,110,145` (frontmatter-only rewrites; must NOT re-add links to a page the wiki stopped serving). (7) OUTSIDE `src/compiler/`: `src/commands/review-approve.ts:396` (`resolveAndApplyLinks` on the approve path) and `src/import/okf-refresh.ts:34` also regenerate link-bearing bodies through the same shared functions, so an overlay bound only to the compile path would leave those two inconsistent.

TESTS (`test/compiler/wiki-stability.test.ts`, new, 322 lines / 222 non-comment, 8 cases, each 11-20 lines; every case drives `compileAndReport`, or `reviewEarlierPages` where defect A makes the compile path unreachable, and asserts page BYTES; provider stubbed, project in a throwaway OS temp dir removed by the fixture). THREE INVERTED (`test.fails`), each with the defect and the pending fix named above it: A1-wiring, A1-alias-dedupe, A1-regeneration. FIVE PASSING, each pinning observed behaviour: the ping-pong measurement, S-A2 idempotency, S-A2 the one rewritten artifact, S-A3 silent anchor loss, S-A4 mixed prompt generations. RED observed for the three inverted cases first (`/tmp/t15-red-raw.log`, quoted verbatim above), GREEN after conversion: `Tests 8 passed (8)`, `Test Files 1 passed (1)`.

GATES (Node v24.21.0, quiescent tree, scope stated per command, no failing test to name): `npx tsc --noEmit` exit 0. `npm run typecheck:tests` exit 0, "1700 files checked; 260 baseline diagnostics in 94 files; no regression". `npm run build` exit 0 (ESM + DTS, viewer assets copied). `npm run test:affected` exit 0, 794 files / 6079 tests passed, 3 files / 4 tests skipped (797 / 6083), full output in `/tmp/t15-test-affected.log`, zero `×` lines, and the new file WAS in scope (it ran there). `./node_modules/.bin/fallow` exit 0, "0 above threshold · 16553 analyzed · maintainability 91.1 (good)". Focused: `npx vitest run test/compiler/wiki-stability.test.ts` exit 0, 1 file / 8 tests (3 expected-fail). NOT run: the full `npm test` suite (CI is its gate of record). Coverage caveat unchanged: `.fallowrc.json` ignores `packages/llmwiki-kg/**`, so a clean `fallow` result is never coverage of that package.

NOTHING IN `src/` CHANGED: `git status --short` shows only `?? test/compiler/wiki-stability.test.ts` before the doc edit. RISK: none — a new test file and this record change no product code; the three defects it pins are pre-existing and were measured, not introduced.
