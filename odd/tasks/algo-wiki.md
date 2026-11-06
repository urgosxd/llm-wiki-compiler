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
| T5 | Categories: stable identity, canonical name, description, inclusion criterion, member listing, page-to-category projection | S4, S10, S11 | worker | pending |
| T6 | Wiki-race navigation: deterministic bounded traversal over the link graph with a testable path result | S11 | worker | fbcfb48b4ce21cb949338033c646a3340dd9c785 |
| T7 | Multi-source synthesis and provenance: pin per-source attribution, keep sources authoritative | S2, S3, S7, S12 | worker | pending |
| T8 | Final gates, docs and delivery report | S1, S12 | worker | pending |
| T9 | Hoist the single shared target resolver used by `race` and `links-here` instead of duplicating it; behaviour-preserving for `links-here`, pinned by a differential check | S11, S12 | worker | pending |
| T10 | Resolve the ghost/dangling page classification shared by `race` and `links-here`: either pin the same classification for both, or state in code and docs why they differ and pin both | S11, S12 | worker | pending |
| T11 | Remove the retired `auto`/`review` identity ranks from `concept-forest.ts` and delete the dead `concept-aliases.ts` vocabulary left behind | S6, S14 | worker | pending |
| T12 | One final link gate for both link channels: same-run targets resolve, and the `resolveLinks` channel is held to the same decision table and budget as the model's inline links; run totals reported | S8, S13 | worker | 66ce7ef44d72fa56fa22f7b92f06258cb79b8442 |

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
