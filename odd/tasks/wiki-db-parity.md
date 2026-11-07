# wiki-db-parity — closing the file-backed / row-backed wiki store parity gap

Feature: concept aliases, curated contextual links, categories with membership evidence, and `attributionGaps` must behave identically in the file-backed store and the row-backed (Postgres) store. Branch: `feat/wiki-db-parity`.

## Specs

S1 — esto me intriga: "Y la limitación más importante, que no enterró: los Stacks respaldados por filas pierden alias, enlaces curados, categorías y attributionGaps. O sea: la estabilidad está demostrada sobre el almacenamiento en archivos, y el camino de base de datos no la tiene todavía", haz el camino en ddbb

S2 — ALIASES persist for row-backed Stacks and are read back across runs, so the equivalence tier behaves identically in both paths. A table `wiki.concept_aliases` already exists and is DEAD: inspect it first. If its shape fits the need, adopt it rather than inventing a second alias store; if it does not fit, say precisely why and say what is being added instead. Do not drop it either way.

S3 — CURATED LINKS persist with the same fields the file store carries: source, target, the anchor text plus enough context to re-locate it, the provenance channel, and a stable key. The overlay must re-validate the anchor against the regenerated body ON EVERY RENDER in the DB path too, and a lost anchor must drop the link AND report it. A DB-backed wiki that silently keeps or silently drops curated links is the oscillation bug in a new place.

S4 — CATEGORIES persist with identity minted once and never recomputed on rename, canonical name, description, an inclusion criterion that quotes the terms a page must mention, and membership stored as evidence (`pageId`, `reason`, `evidenceKey`) so membership is re-derivable and auditable. A category and a concept sharing a name must remain two separate objects in the DB path exactly as they are in files.

S5 — `attributionGaps` persists and is surfaced identically: a page drawing on a source it does not cite is written but marked, counted, and named in the run output. A DB-backed page must never read as fully attributed when it is not.

S6 — MIGRATIONS: non-destructive (no `DROP TABLE`, no `DROP COLUMN`, no `TRUNCATE`, no volume reset, no rebuild; existing rows are backfilled, never rewritten in ways that lose data). Idempotent: re-running the file must be a no-op. Any unique index is created only AFTER collisions are resolved, and collision resolution must never merge two distinct objects to satisfy a constraint; case-variant names stay separate. Mirror the result into `packages/llmwiki-kg/db/schema.sql` so a fresh install matches a migrated one, following the convention of `packages/llmwiki-kg/db/migration_open_kg_classification.sql`. State the exact command to run it, matching how the KG migration is documented and run. Prove it with a test that builds a real pre-migration database, applies the migration file, and diffs the result against a database built from `schema.sql`.

S7 — PARITY TEST: the same input ingested through the file-backed path and through the row-backed path must produce equivalent observable output for all four artifacts — aliases, curated links with anchors, categories with membership evidence, and attribution gaps. Equivalent does not mean byte-identical storage; it means the observable behaviour through the public interface matches. If any of the four cannot reach parity, STOP and report which and why instead of shipping three and calling it done.

S8 — REACHABILITY: every new stage or store must be shown reachable from the compile path, with the `file:line` call chain plus `git grep`. A test that calls an exported function directly proves the function and nothing about integration. Where a stage is added, the test must fail if the stage is unwired — demonstrated by removing the call, observing RED, and restoring it.

## Tasks

| ID | Specs | Task | Route | Commit |
|----|-------|------|-------|--------|
| T1 | S1, S2 | Record the adopt-or-reject decision for the dead `wiki.concept_aliases` table and the full task breakdown (this document). | worker | |
| T2 | S6 | Migration `src/dimensions/wiki/migration_wiki_db_parity.sql`: add `wiki.pages.aliases` and `wiki.pages.attribution_gaps`; create `wiki.curated_links`, `wiki.categories`, `wiki.category_members`. Non-destructive, idempotent. Mirror into `src/dimensions/wiki/schema.sql`, append to `scripts/apply-schemas.sh`, prove by pre-migration-vs-schema.sql database diff. HIGH RISK — own commit. | worker | |
| T3 | S2 | Aliases persist through the page-row seam and are read back across runs, so the identity tier folds identically in both paths. | worker | |
| T4 | S5 | `attributionGaps` persist through the page-row seam and are marked, counted and named in the row-backed run output. | worker | |
| T5 | S3 | Curated links persist in `wiki.curated_links` behind the store seam; the overlay re-validates the anchor on every render and a lost anchor drops the link AND reports it. | worker | |
| T6 | S4 | Categories persist in `wiki.categories` + `wiki.category_members`; identity minted once, membership stored as evidence, category and concept of the same name stay two objects. | worker | |
| T7 | S7 | Parity test: one input ingested through the file-backed path and the row-backed path, equivalent observable output for all four artifacts. ACCEPTANCE. | worker | |
| T8 | S8 | Reachability proof for every new stage and store: `file:line` call chain plus `git grep`, and RED observed by unwiring the stage. | worker | |
| T9 | S6, S7 | Documentation: the DB path's behaviour and the exact migration command. | worker | |
| T10 | S1-S8 | Full gate run and delivery report. | lead | |

## Log

### L1

esto me intriga: "Y la limitación más importante, que no enterró: los Stacks respaldados por filas pierden alias, enlaces curados, categorías y attributionGaps. O sea: la estabilidad está demostrada sobre el almacenamiento en archivos, y el camino de base de datos no la tiene todavía", haz el camino en ddbb

### L2

Process constraints from the assignment: serialize writers (one agent at a time in the worktree); forbid rm/rm -rf/git clean/git checkout --/git restore/git stash; revert experimental probes by inverse edit; characterize any intermittent failure with its actual error text instead of re-running until green.

### L3 — Reconnaissance corrections

The first reconnaissance reported that no row-backed compile path exists and that no code branches between file-backed and row-backed stores. Two independent re-checks refuted that. Corrected facts, each with the evidence that established it:

- A real row-backed path exists. `src/commands/compile.ts` -> `src/compiler/index.ts:285 compile()` -> `:394 runCompilePipeline(root, options, dimensionsDb.db)` -> `:541 generatePagesPhase()` -> `:769 commitLivePageWrites(...)`, persisting `wiki.pages` rows. The branch is the `rowBacked` flag (`src/compiler/resolver.ts:545,548,585,588`).
- `wiki.pages` DDL is `src/dimensions/wiki/schema.sql:71-107`. Its columns are `stack_id, page_directory, slug, title, source_identity, summary, tags, links, body, orphaned, archived, created_at, updated_at`, primary key `(stack_id, page_directory, slug)`. There is no `aliases` column and no attribution column.
- `src/dimensions/wiki/page-scan-source.ts:440-456 renderPageMarkdown()` rebuilds a page from the row columns and emits only title, summary, tags, orphaned and archived. Aliases and attribution gaps cannot survive that round trip.
- The wiki schema of record is `src/dimensions/wiki/schema.sql`, not a repository-root `db/schema.sql` (no root `db/` exists). `packages/llmwiki-kg/db/schema.sql` holds the KG/graph tables and no `wiki.*` tables. The migration and its schema mirror therefore live in `src/dimensions/wiki/`, and the file must also be appended to the `SCHEMA_FILES` array in `scripts/apply-schemas.sh`, which applies the wiki schema and every `migration_wiki_*.sql` in dependency order and is idempotent.
- The dead `wiki.concept_aliases` DDL is `src/dimensions/wiki/schema.sql` around line 133: `stack_id uuid primary key references public.stacks(id)`, `version integer`, `fingerprint text`, `ruleset integer`, `aliases jsonb default '[]'`, `pending jsonb default '[]'`, `recorded_at timestamptz`, with RLS forced and a `tenant_isolation` policy. `odd/tasks/algo-wiki.md:801` and `:943` record that its only reader, `src/dimensions/wiki/concept-aliases.ts`, was deleted with `git rm`, that nothing reads or writes it, that it is NOT dropped, and that no migration was written for it.
- File-backed persistence, as it exists today: aliases go into page frontmatter (`src/compiler/page-renderer.ts:148-155 applyDeclaredAliases`, resolved at `src/compiler/index.ts:961 applyConceptIdentity`); curated links go into `.llmwiki/curated-links.json` (`src/compiler/curated-links-store.ts:257 loadCuratedLinks`, `:301 recordCuratedLinks`); categories go into `wiki/categories/<categoryId>.md` (`src/categories/store.ts`); attribution gaps go into page frontmatter only (`src/compiler/page-renderer.ts:385`) and are surfaced by `describeAttribution` (`:224`) and `describeAttributionSummary` (`:242`) through `src/compiler/compile-report.ts:138-146 reportAttribution`, called at `src/compiler/index.ts:1594`.

### L4 — Design decisions

D1. ALIASES get a page-scoped column, `wiki.pages.aliases jsonb not null default '[]'`, and `wiki.concept_aliases` is left untouched.
The dead table does NOT fit the need, for four reasons, each checkable against its DDL at `src/dimensions/wiki/schema.sql:133`:
 (a) Its primary key is `stack_id`, so it can hold ONE row per Stack. Aliases in the file path are a per-page fact: they are written into each page's frontmatter and read back per page as incumbents. A single row cannot answer "which names does page X resolve", so it cannot restore the per-page incumbent set that the identity tier folds against.
 (b) Its `aliases jsonb` array is flat and carries no page identity, so aliases could not be attributed to the page whose title they came from, and could not be merged page by page.
 (c) Its `fingerprint` column is a whole-record invalidation key: `conceptAliasRecordUsable` discarded the ENTIRE record when the embedding fingerprint changed. Adopting it would make every alias disappear whenever the embedding backend, model or endpoint changed, which is the oscillation this assignment exists to remove, moved into the database.
 (d) Its per-alias `tier` evidence, which the file path persists so a fold can be audited, has nowhere to live in a flat array.
It is not dropped: dropping a table is a migration and this assignment forbids destructive steps. It stays dead and harmless, awaiting the cleanup already recorded in `odd/tasks/algo-wiki.md:832`.

D2. ATTRIBUTION GAPS get a page-scoped column, `wiki.pages.attribution_gaps jsonb not null default '[]'`, for the same reason as D1: the file path's only persistence is page frontmatter, so parity is a page-scoped field, not a table.

D3. CURATED LINKS get a table `wiki.curated_links` mirroring `CuratedLinkRecord` field for field: `stable_key`, `source_page_id`, `target_page_id`, `anchor_text`, `anchor_before`, `anchor_after`, `provenance`, `created_at`, keyed to the Stack. The overlay logic does NOT get a DB variant: `overlayCuratedLinks(body, sourcePageId, records)` already takes a body string and records and is path-agnostic. Only load/record/drop change store. Anchor re-validation therefore runs on every render in both paths by construction, and a lost anchor produces the same drop record and the same `reportCuratedLinkDrops` message in both.

D4. CATEGORIES get `wiki.categories` (identity, canonical name, description, inclusion criterion, timestamps) and `wiki.category_members` (page id, reason, evidence key). The category id is minted once by the existing shared `categoryIdForName` and never recomputed on rename: the DB store's update path must patch name/description/criterion and never touch the id. Membership rows are the audit evidence, mirroring `CategoryMember`. No unique constraint is placed on the canonical name, so two case-variant names remain two objects, matching the file path where they are distinct files.

D5. STORE SELECTION reuses the existing seam convention rather than a new flag: `src/dimensions/wiki/` already contains DB twins of file stores (`page-source-seam.ts`, `project-config-seam.ts`, `derived-artifact-source.ts`, `derived-artifact-store.ts`, `marker-store.ts`, `compile-config-store.ts`). Curated links and categories follow that pattern, selected by the same `rowBacked`/`db` signal the compile pipeline already carries, so there is no second notion of "is this database-backed".

D6. MIGRATION placement and proof: `src/dimensions/wiki/migration_wiki_db_parity.sql`, mirrored into `src/dimensions/wiki/schema.sql`, appended to `scripts/apply-schemas.sh`. Non-destructive, idempotent, unique indexes only after collision analysis, no merge of distinct objects to satisfy a constraint. Proved by building a real pre-migration database, applying the migration, and diffing its schema against a database built from `schema.sql` alone.
