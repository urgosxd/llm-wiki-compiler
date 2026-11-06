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
| T1 | Feature document | S1-S14 | worker | pending |
| T2 | Equivalence vs similarity: deterministic identity tiers (slug, canonical key, alias), embedding similarity demoted to link proposals only | S6, S13, S14 | worker | pending |
| T3 | Anchored contextual links: structured anchor+target proposals, deterministic anchor validation, target/redundancy/self-link checks, reporting | S8, S13 | worker | pending |
| T4 | Incremental link review of earlier pages, bounded and reported; also covers the defect that `relatedPages` context is an arbitrary alphabetical slice of existing concept slugs rather than a relevance ranking, so the review step must rank candidate pages by relevance (which IS the legitimate use of similarity retrieval per S14) instead of taking the first N slugs | S9, S13, S14 | worker | pending |
| T5 | Categories: stable identity, canonical name, description, inclusion criterion, member listing, page-to-category projection | S4, S10, S11 | worker | pending |
| T6 | Wiki-race navigation: deterministic bounded traversal over the link graph with a testable path result | S11 | worker | pending |
| T7 | Multi-source synthesis and provenance: pin per-source attribution, keep sources authoritative | S2, S3, S7, S12 | worker | pending |
| T8 | Final gates, docs and delivery report | S1, S12 | worker | pending |

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
