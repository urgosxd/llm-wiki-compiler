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
| T1 | S1, S2 | Record the adopt-or-reject decision for the dead `wiki.concept_aliases` table and the full task breakdown (this document). | worker | `afea095647ef3ae3617879ec794cd05ca78adab1` |
| T2 | S6 | Migration `src/dimensions/wiki/migration_wiki_db_parity.sql`: add `wiki.pages.aliases` and `wiki.pages.attribution_gaps`; create `wiki.curated_links`, `wiki.categories`, `wiki.category_members`. Non-destructive, idempotent. Mirror into `src/dimensions/wiki/schema.sql`, append to `scripts/apply-schemas.sh`, prove by pre-migration-vs-schema.sql database diff. HIGH RISK — own commit. | worker | `c0559fc59eb63a263fffc09e8c06f3d8f242ff63`, review closures in `d66612fb36557116e4169975f05b79a195a74517` (frozen pre-migration fixture, grants/non-destructiveness/data pinned, D4 claim corrected — see L5) |
| T3 | S2 | Aliases persist through the page-row seam and are read back across runs, so the identity tier folds identically in both paths. | worker | `fa75f5e549e3f37d5aa36f29043dda62795b9e33` |
| T4 | S5 | `attributionGaps` persist through the page-row seam and are marked, counted and named in the row-backed run output. | worker | `e1a2cd49c88c97d4b0e7c2842ebb03bfdd40f554` |
| T5 | S3 | Curated links persist in `wiki.curated_links` behind the store seam; the overlay re-validates the anchor on every render and a lost anchor drops the link AND reports it. | worker | `15c5cda964906b07246c01f7bfdc0728d3317c98`, refactor-only prerequisite in `df804c6ba6dc1fe7e270b8c3c8baa27e3bcf4e4d` (the `CuratedLinkStorePort` and the file backend behind it; behaviour-preserving, type-checked on its own) |
| T6 | S4 | Categories persist in `wiki.categories` + `wiki.category_members`; identity minted once, membership stored as evidence, category and concept of the same name stay two objects. | worker | `7e6e9fc5f8f266efabab075cacb6a5a94518fa1a` (the `CategoryStorePort` and the file backend behind it; behaviour-preserving), `43dab47f0c9a01ad1d4238ab4ee89e3587e54a17` (the row store, the seam selection and the suites) |
| T7 | S7 | Parity test: one input ingested through the file-backed path and the row-backed path, equivalent observable output for all four artifacts. ACCEPTANCE. | worker | `3c09f3d1f5ba2eb700a57a6f9ddc7c6bac95c05f`, temp-root teardown in `396f982545f095178477253190dc2416142bdc6b` |
| T8 | S8 | Reachability proof for every new stage and store: `file:line` call chain plus `git grep`, and RED observed by unwiring the stage. | worker | `bbda95e3d46bd6e2dd19bf7cb654ee80e1eb7e01` (the durable documentation), `f469c9a54153f8fddcab6089dd9bc58307960f38` (the parity suite fails instead of skipping), `60e2672bbcc5b91a4242a3a3b4ace077657713a3` (the curated-link fallback pinned) — see L10 |
| T9 | S6, S7 | Documentation: the DB path's behaviour and the exact migration command. | worker | `730f53d05affafb343ef9787fe97b47dcac02648` — see L11 |
| T10 | S1-S8 | Full gate run and delivery report. | lead | `66f0b84a164f5a5bc08eb37f7eafd845fdaa7dae` (the `--check` flag), `4f27013b3b493b894f96fcaa664a1f126782203f` (the curated-link store header), `4818b51be7a7dcb8826d476a37410148c17d78de` (the gate results and L12), `c5795b66555ff1ef063b66c74b562c5a235cc292` (the schema comment about the migration proof), `81a5cfd4b87f9bdfbeaf21342860aad8cab8e2e9` (the durable anti-fallback suite), `bfe609cdd573b9355c2767a679fd9f1317b2e728` (the `docs(odd): record the T10 closure` commit that carries L13), `9b6088e2c60913e20bf113f16e963c80984b68de` (the shared probe-stack fixture, L14), and the `docs(odd): record the final gate run` commit that carries L14 |
| T11 | S4, S7, S8 | Close the read side: `llmwiki category` and `llmwiki categories-here` take their `CategoryStorePort` from the compile path's own seam (`withCategoryStore` -> `withPageSeams` -> `resolvePageSeams`), default to the file store with no Stack, and fail loudly when an addressed Stack is unreachable; parity cases through the real verbs; docs corrected. | worker | `52f8ea76ea909256a62f96c6d7fd1131a63f83d3` (the verbs), `f8efc03712ceac914e62ef17a8831265a931f99e` (the parity cases), `6a14f8d14ab6a638b3e4c9075f1b40af4982c658` (the docs), and the `docs(odd): record the CLI closure` commit that carries L15 |

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

### L5 — Correction: case-variant category identity

D4 asserted that "two case-variant names remain two objects, matching the file path where they are distinct files". That assertion was FALSE, and it stayed false in the migration's comments until a review caught it. Measured:

- `categoryIdForName` (`src/categories/identity.ts:42-51`) returns `slugify(canonicalName)`, and `slugify` (`src/utils/markdown.ts:69-77`) begins with `.toLowerCase()`.
- So `Foo` and `foo` mint the SAME category id in the file path, and both therefore resolve to the same `wiki/categories/<categoryId>.md`. That is ONE object, not two files.
- `wiki.categories` is keyed on `(stack_id, category_id)`, so the same collapse happens in the row-backed path.

The truth the comments and this entry now state:

- Object identity is derived from the lowercased slug in BOTH paths, so case-variant names collapse to one object in BOTH.
- This migration introduces NO name-unique index (there is no unique constraint on `canonical_name`), so it neither creates nor worsens that collapse.
- Parity is preserved because the behaviour is shared: the DB path reuses the same `categoryIdForName`, so both paths agree on what one object is.
- Nothing in the identity behaviour was "fixed" and no SQL statement was changed: S4's rule that a category and a CONCEPT sharing a name stay two objects is about two different object kinds and is unaffected. D4 is left as written; this entry supersedes it.

Review closures delivered with commit `d66612fb36557116e4169975f05b79a195a74517`:

1. The false claim is corrected in three places in `migration_wiki_db_parity.sql` (mirror/test description, the categories shape bullet, and the `wiki.categories` section) and here.
2. Database A no longer derives from the current `schema.sql`. It is built from `test/fixtures/wiki-schema-pre-db-parity.sql`, a frozen copy of `schema.sql` at `a40fc3f` with a header saying it must never be regenerated, and only the fresh install follows `schema.sql`. Measured teeth: changing the pre-migration portion of `schema.sql` (`body text` -> `varchar(1024)`) fails the new suite and PASSES the previous one, which is exactly the drift the old arrangement could not see.
3. Grants, non-destructiveness and data survival are assertions now, not comments: the migration text is scanned for `drop table`, `drop column`, `truncate`, `delete from`, `insert into` and `update ... set`; `wiki.concept_aliases` must still exist; `llmwiki_app` must hold SELECT/INSERT/UPDATE/DELETE on `wiki.pages`, `wiki.curated_links`, `wiki.categories` and `wiki.category_members` identically in the migrated and the fresh database (they agree — no mirror defect found); and an `md5` digest of every pre-existing `wiki.pages` column is unchanged across two applies.
4. `src/dimensions/wiki/schema.sql` was NOT edited by this slice, and its `wiki-db-parity-mirror` markers are documentation only now: the suite no longer strips them.

### L6 — T3 and T4 landed, and the two things the seam was missing

T3 (`fa75f5e`) and T4 (`e1a2cd4`). Both are verified through `compileAndReport` on a real Stack with the real document store, not through exported helpers.

WHAT THE CODE DID NOT DO, found by reading it rather than by assuming the brief's file list was complete:

1. `generateMergedPage` called `renderMergedPageContent(root, entry, schema)` with NO page source, so the renderer read the page it was about to replace from `wiki/concepts` — a directory a row-backed project does not have. Emitting aliases from the row was therefore not enough: the re-render never saw them. The page reader is now threaded from `resolvePageSeams` through `generatePagesPhase` to the renderer; absent (no Stack) keeps the on-disk read, so the file path is unchanged.
2. `renderPageMarkdown` is the ONLY way a row becomes markdown, and `resolver.ts` `rewritePage` patches a page's body inside that rendered text. Measured: with the `attributionGaps` emission removed, one run that adds an inbound wikilink to a marked page writes the row again WITHOUT the gap, so the page silently becomes fully attributed. That is a test (`row-page-attribution-gaps.test.ts`, the rewrite case), not a comment.

MEASURED UNWIRING, each restored by inverse edit with the suite green again: removing the reader threading, the `aliases` emission, the sink's alias carry-over, the sink's gap carry-over, and the `attributionGaps` emission each turned the corresponding test red, and only that one.

T3 alone is green: the T3 slice was committed from a tree where every `attribution_gaps` line had been removed again, and `npx tsc --noEmit` plus the aliases suite passed there before the T4 lines were restored. So the two slices are independently reviewable.

`Page` gained OPTIONAL `aliases`/`attributionGaps`, and `buildPage` deliberately does not populate them: that builder is the file path's and its output is public, so teaching it these fields would change what every on-disk `listPages` call reports.

NOT DONE HERE, and still open for the later tasks: `createRawPageSource`'s `frontmatter` (the export/viewer collectors) still carries only title, summary, tags and the two flags, and `withRelatedPageIndex` still builds the sibling index from `wiki/concepts` rather than from the run's own corpus. Both are visible in the row path today and neither is T3's or T4's spec; T7's parity test will meet them.

### L7 — The row-to-markdown newline: root cause, and it COMPOUNDED

Measured on a real Stack with one page (`test/dimensions/row-page-round-trip.test.ts`), body `BODY` = `Alpha Topic stores vectors in a pgvector store. ^[alpha.md:1-1]`:

- stored `wiki.pages.body` after the compile: `"\n" + BODY + "\n"`
- the file path's parsed body for the same corpus: `"\n" + BODY + "\n"` — identical, so the leading newline is the CONVENTION, not a row defect
- stored body after ONE `row -> markdown -> row` trip: `"\n\n" + BODY + "\n"`
- after a second trip: a third newline. **It compounds.**

Root cause, in the order the bytes travel:

1. `src/compiler/page-renderer.ts:145` — a compiled page is `${frontmatter}\n\n${pageBody}\n`, so a parsed body legitimately BEGINS with the newline that separated it from the closing fence.
2. `src/utils/markdown.ts:123` — `parseFrontmatterStatus` matches `^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$`: it strips the closing fence and AT MOST ONE following newline.
3. `src/dimensions/wiki/page-write-sink.ts:108` — `toPage` parses that same markdown, so the row stores the body including that leading newline.
4. `src/dimensions/wiki/page-scan-source.ts:222` (pre-fix) — `renderPageMarkdown` emitted `---\n…\n---\n\n${body}`, re-adding a separator IN FRONT OF a body that already carried one. The parser then removed only one of the two, so the trip gained a newline.
5. `src/compiler/resolver.ts:725` — `rewritePage` writes `content.replace(page.body, …)` back through the sink, and `content` is `renderPageMarkdown(page)`. That is the write that paid the growth, once per rewrite, forever.

The fix is one character class of change: emit exactly one newline after the closing fence. `---\n…\n---\n${body}` is the exact inverse of `parseFrontmatter` for ANY stored body, and with a file-convention body the rendered markdown is byte-identical to the page file. File-backed behaviour is untouched because `renderPageMarkdown` only ever renders a row.

It was (a) added by the render template, not (b) stored in the row nor (c) left by the parser: the row body is clean and the parser is the writer's inverse; only the renderer disagreed with both.

What T7 can now assert, and T5 no longer folds:

- `test/dimensions/row-page-curated-links.test.ts` `comparable` compares `anchor` EXACTLY, and the per-field case pins `"\nAlpha Topic stores vectors in a "` / `". ^[alpha.md:1-1]\n"`. The whitespace trimming workaround is gone.
- The same suite already asserts `fromRows.restoredBody` `toBe` `fromFiles.restoredBody`, which is now a byte-exact cross-backend body equality rather than an accident of trimming.
- `test/dimensions/row-page-round-trip.test.ts` pins idempotency: the raw `body` column must be byte-identical across two round trips. RED was observed by restoring the two-newline template (`× expected '\n\nAlpha Topic…' to be '\nAlpha Topic…'`) and reverted by inverse edit.
- T7 should therefore treat ANY whitespace difference between the two backends as a regression, and should keep driving the trip through `createPageContentSource` + `createPageWriteSink` rather than through a hand-written render.

### L8 — T6 landed, and the `!regenerateOnly` gate is scope, not backend

T6 (`7e6e9fc` refactor, `43dab47` feature). Categories now have a DB twin behind the SAME port the file store answers, selected in `resolvePageSeams` beside the curated-link store, so there is one notion of "database-backed" for pages, links and taxonomy alike.

What T6 reuses rather than restates, all unchanged: `buildCategoryRecord` and `mergeCategoryPatch` (`src/categories/model.ts`), `categoryIdForName`/`categoryObjectId` (`identity.ts`), `sortMembers` (`members.ts`), the criterion test (`criteria.ts`, exercised through `assignCategories`). The row store owns only WHERE the record lives: `wiki.categories` for the identity and its four fields plus both timestamps, `wiki.category_members` for `page_id`, `reason`, `evidence_key`.

Identity: `category_id` is minted once by `buildCategoryRecord` and the update statement (`patchCategoryTx`) names only `canonical_name`, `description`, `inclusion_criterion`, `updated_at`. A rename therefore cannot move the id, and the suite asserts the COLUMN before and after.

A create against a taken identity raises `CategoryWriteRefusedError("deny")` — the same error, with the same decision string, that the file path's trust planner produces — so a caller cannot tell the backends apart, and the stored row is unchanged afterwards.

THE GATE, answered: `finalizeWiki` runs `assignCategoriesForRun` only inside `if (!regenerateOnly)` (`src/compiler/index.ts:1745-1751`), and `regenerateOnly` is `recompileRequest() !== undefined` (`:814`). That is a SCOPE gate, not a backend branch: a `--recompile` run rewrites exactly the pages it names, and a category write touches objects it did not name. The row-backed path inherits the identical behaviour because the flag is decided before any seam is consulted, so categories are left unwritten by a scoped regeneration in BOTH paths — parity, not a gap. A full compile writes them.

Unwiring evidence, each restored by inverse edit with the suites green again: removing the `categories:` selection from `resolvePageSeams`, and separately removing `store: flags.seams?.categories` from `assignCategoriesForRun`, each turned all seven cases red (`expected [] to have a length of 1 but got +0`, `expected undefined to deeply equal {...}`), because the run fell back to the file store.

Known limitation, deliberately not changed: the CLI surfaces (`category`, `categories-here`) still read categories from files. They are read-only commands outside the compile path, and pointing them at rows is a separate decision about which Stack they mean; T9 should say so in the docs rather than leave it implied.

### L9 — T7 landed: PARITY REACHED, and one unwire per artifact

`3c09f3d`. The acceptance test is `test/dimensions/store-parity.test.ts` (7 cases) over the
shared corpus in `test/fixtures/store-parity-corpus.ts`. Split rationale: the corpus, the
composite provider stub and the two-backend readers live in the fixture (247 non-comment
lines); the seven comparisons live in the suite (121 non-comment lines). Both are under the
400-line limit without touching a committed test file.

WHAT THE CORPUS IS, and why one corpus and not four. `sistemas.md` + `consenso.md` are two
accounts of ONE concept, so the merged page contributes two sources and cites one — the
attribution gap — while its body quotes the category criterion's term and names the vector
store by an ALIAS. `vectores.md` is the source whose extraction reports one concept under
two spellings, which folds the alias onto the link TARGET page. Four full compiles per
backend: create the marked page; create the target (the review curates the link into the
earlier page, anchored on the alias); regenerate the marked page (the link can only come
back by reading the record, and the gap must survive the write); regenerate it without the
mention (the record must be dropped AND reported). The four artifacts interfere with each
other, so four fixtures could each pass while the combination degrades.

VERDICT, per artifact, both backends observed identical: PARITY REACHED for aliases,
curated links with anchors, categories with membership evidence, and attribution gaps.

MEASURED PARITY, values as observed (ANSI stripped):

- aliases: `["vector-db", "Vector Database"]` on `concepts/vector-db`, title `Vector DB`,
  no page for `vector-database`, concept slugs `[sistemas-distribuidos, vector-db]`.
- curated link: `stableKey b98819d6e63186b1`, `concepts/sistemas-distribuidos` ->
  `concepts/vector-db`, anchor `text "Vector Database"`, `before "\nDistribuidos: consenso
  distribuido, vectores en un "`, `after ". ^[sistemas.md:1-1]\n"`, provenance
  `model-verdict` — byte-identical, no trimming.
- restored body: `Distribuidos: consenso distribuido, vectores en un
  [[vector-db|Vector Database]]. ^[sistemas.md:1-1]` in both.
- drop: `Curated links: 0 link(s) restored, 1 dropped (1 anchor-missing).` plus the
  per-record line, records left `0`, body without the link — in both.
- categories: `sistemas-distribuidos`, name `Sistemas distribuidos`, the criterion quoting
  `"consenso distribuido"`, member `pageId concepts/sistemas-distribuidos`, reason,
  `evidenceKey consenso-distribuido`; run 1 reports `1 page(s) assigned to 1 category(ies)
  (1 new), 1 refused (1 unsupported)`, run 3 reports `0 page(s) assigned to 0 category(ies),
  1 refused (1 unsupported)` — the same membership is reused, never re-minted.
- attribution: `["consenso.md"]` on the merged page, `[]` on the target page, and the run
  prints `Attribution: 1 page(s) not fully attributed (1 source reference(s) missing) —
  Sistemas distribuidos is missing consenso.md`.

UNWIRE RED, one per artifact, each restored by inverse edit with the suite green again. In
every case exactly ONE case failed, and it was the case for the removed stage:

1. aliases — removed `emitList(lines, "aliases", page.aliases ?? [])` in
   `page-scan-source.ts:230`:
   `× carries the same aliases, folded onto the same page, in both backends →
   AssertionError: expected 0 to be greater than 0` (store-parity.test.ts:103).
2. curated links — removed `curatedLinks: createRowCuratedLinkStore(db as never, stackId)`
   in `page-source-seam.ts:408`:
   `× keeps the same curated record, every anchor field included →
   AssertionError: expected 0 to be greater than 0` (store-parity.test.ts:117).
   NOTE: the "restores the link" case stayed GREEN under this unwire, because the run fell
   back to the host's `.llmwiki/curated-links.json` and kept working from there. That is
   exactly the degradation S2/S3 forbid, and only the RECORD comparison catches it.
3. categories — removed `categories: createRowCategoryStore(db as never, stackId)` in
   `page-source-seam.ts:409`:
   `× stores the same category with the same membership evidence →
   AssertionError: expected undefined to be defined` (store-parity.test.ts:154).
4. attribution gaps — removed `attributionGaps: stringList(meta.attributionGaps)` in
   `page-write-sink.ts:120`:
   `× marks, counts and names the same attribution gap, and clears a full page →
   AssertionError: expected 0 to be greater than 0` (store-parity.test.ts:174).

T8 REACHABILITY TABLE, measured on this commit. Chain entry:
`compile()` `src/compiler/index.ts:286` -> `compileAndReport` -> `runCompilePipeline`
`index.ts:1107` -> `resolvePageSeams(db, env)` `index.ts:1132` ->
`src/dimensions/wiki/page-source-seam.ts:402-409` (the Stack's seam bundle) -> both stages
below. Hit counts are `git grep -c` over `src/`.

| artifact | call chain (`file:line`) | grep command | hits |
|---|---|---|---|
| aliases (write) | `index.ts:974 applyConceptIdentity` -> `page-renderer.ts:403 applyDeclaredAliases` -> `page-write-sink.ts:119 aliases: stringList(meta.aliases)` -> `wiki.pages.aliases` | `git grep -c 'aliases: stringList' -- src/` | 3 files, 1 hit each (`page-write-sink.ts`, `page-store.ts`, `link-anchoring.ts`) |
| aliases (read) | `identity-stage.ts:131 snapshotIncumbentConcepts` -> `page-scan-source.ts:357 createPageContentSource` -> `page-scan-source.ts:230 emitList(lines, "aliases", ...)` | `git grep -c 'emitList(lines, "aliases"' -- src/` | 1 (`page-scan-source.ts`) |
| curated links | `page-source-seam.ts:408 curatedLinks: createRowCuratedLinkStore` -> `index.ts:583 overlayCuratedPageWrites(root, …, curatedStore)` -> `curated-links-apply.ts:92 applyCuratedOverlay` -> `curated-links-overlay.ts:104 overlayCuratedLinks` | `git grep -c 'curatedLinks: createRowCuratedLinkStore' -- src/` | 1 (`page-source-seam.ts`) |
| categories | `index.ts:1629 assignCategoriesForRun` -> `index.ts:1643 store: flags.seams?.categories` -> `page-source-seam.ts:409 categories: createRowCategoryStore` -> `categories/assign.ts` -> `categories-row-store.ts` | `git grep -c 'seams?.categories' -- src/compiler/index.ts` | 1 |
| attribution (write) | `page-renderer.ts:385 frontmatterFields.attributionGaps` -> `page-write-sink.ts:120 attributionGaps: stringList(meta.attributionGaps)` -> `wiki.pages.attribution_gaps` | `git grep -c 'frontmatterFields.attributionGaps' -- src/` | 1 (`page-renderer.ts`) |
| attribution (read + report) | `page-scan-source.ts:231 emitList(lines, "attributionGaps", ...)`; `compile-report.ts:138 reportAttribution` | `git grep -c 'emitList(lines, "attributionGaps"' -- src/` | 1 (`page-scan-source.ts`) |

FOR T8: the four unwire proofs above are the RED evidence, and they are stronger than a
per-stage one — each removes the wiring a DIFFERENT artifact depends on and shows the other
three cases staying green, so a single "the suite fails without my stage" claim is not
doing the work. For T9: the CLI read commands `category` and `categories-here` still read
`wiki/categories/*.md` (recorded in L8 and unchanged here) — the docs must say so rather
than imply the taxonomy is fully row-aware outside the compile path. Also for T9: T7
confirms `--recompile` writes no categories in EITHER path, which is scope parity, not a
gap; documenting it as a gap would be wrong.

T7 CLOSURE. `396f982` adds the teardown the suite was missing: it provisions ONE temp root
for both backends' compiles (eight full compiles writing real page, source and category
files) and removed nothing, so a run left that tree in `/tmp`. The probe Stack was already
torn down in `afterAll`; the filesystem teardown now sits beside it, and a run leaves no
`/tmp/store-parity-*` behind.

### L10 — T8: reachability made checkable, the skip hole closed, and no leaked harness text

THREE SLICES. `bbda95e` (documentation), `f469c9a` (the parity suite's no-database
decision), `60e2672` (the curated-link fallback pinned by a test).

WHERE THE DOCUMENTATION WENT, and why. The repository documents every user-facing change as
a Mintlify page under `docs/`, registered in `docs/docs.json`; the closest precedent for
"here is a SQL migration and exactly how to verify it" is
`docs/guides/kg-classification-migration.mdx`. So the reachability map is
`docs/guides/row-backed-wiring-reachability.mdx`, filed under Guides beside that page and
listed in `docs/docs.json`. It is NOT a new convention: one `.mdx`, frontmatter with
`title`/`sidebarTitle`/`description`, one navigation entry.

WHAT IT CONTAINS, all re-measured on `c39c622` rather than copied from L9 (whose line
numbers had drifted): the chain `compile()` -> `compileAndReport` -> `runCompilePipeline` ->
`resolvePageSeams` (`src/compiler/index.ts:286,287,329,374,1107,1132` ->
`page-source-seam.ts:395,408,409`), then the write AND read chain for each of the four
artifacts down to the SQL, each with the `git grep` command and its observed hit count. It
states plainly that a test calling an exported function proves the function and nothing
about integration, and it records the T7 degradation verbatim: with `page-source-seam.ts:408`
removed the link still restores from `.llmwiki/curated-links.json`
(`curated-links-apply.ts:76`), so "the link still worked" is not evidence of wiring and only
a record-level assertion detects the loss.

TASK B, MEASURED BEFORE AND AFTER. The premise needed correcting: with an unreachable
database the file ALREADY failed, because `createKgPostgresHarness` throws through
`missingTestDatabase` before any `skipIf` is evaluated. Measured on `c39c622` with
`LLMWIKI_TEST_DATABASE_URL=postgresql://aks:aks@127.0.0.1:1/aks`, no opt-out: exit 1, file
failed, message headed `store-parity-79699b6c: the kg harness needs a Postgres database`.
The residual hole was narrower and real: the suite's own skip was a BOOLEAN
(`describe.skipIf(!probe.harness.reachable)`), so with the documented opt-out it printed
`7 skipped (7)` decided by a value with no reason of its own, and the warning it did print
was the fixture's, not the suite's. After `f469c9a` the suite consults `missingTestDatabase`
itself: without the opt-out it fails headed
`test/dimensions/store-parity.test.ts (the file-backed/row-backed parity suite) needs a
Postgres database and none could be obtained.` (exit 1), and with
`LLMWIKI_TEST_ALLOW_NO_DATABASE=1` it prints the same reason, names itself, and skips under
an annotated title (exit 0, `7 skipped`). Measurement deviation, stated rather than glossed:
the unreachable database was produced with `LLMWIKI_TEST_DATABASE_URL`, not by inverse edit,
because the URL is resolved by `test/fixtures/test-database.ts` and the suite cannot reach
it — an inverse edit of the suite could not point it anywhere. No fixture behaviour changed.

WHICH "no database" MODULE. `packages/llmwiki-kg/ts/src/testing/no-database.ts` is the
in-package twin (its own header says `test/fixtures/test-database-handoff.ts` owns the
wording for the root suites, because that package compiles with `rootDir: "src"`), so this
root suite uses the root one. Same rule, same wording, one copy per compilation boundary.

TASK C, VERDICT: **NO LEAK**. Evidence, on `c39c622`:
`git grep -n "Context backstop" -- . ':!node_modules'` exits 1 (no matches);
`git grep -rn "delegate the next bounded unit" -- . ':!node_modules'` exits 1 (no matches);
`git grep -rniE "supervisor_state|available_tools|agent_definitions|addendum|project_context"
-- . ':!node_modules' ':!*.md'` exits 1 (no matches). The `backstop` hits a loose scan did
find are the domain word ("the primary key is the backstop, not the plan",
`categories-row-store.ts:211`; also `page-store.ts:33`, `event-log-store.ts:111`,
`compile-config-store.ts:31`), and `supervisor` appears only in
`packages/llmwiki-kg/ts/src/testing/per-run-database.ts`. `git log --oneline -12` and
`git show --stat` for T5-T7 were read: the fixtures added by `43dab47`/`3c09f3d`
(`store-parity-corpus.ts`, `category-rows.ts`, both row-store suites, `row-page-round-trip`,
`row-category-identity`) contain English JSDoc and no prose that does not belong to the
code. The phenomenon a T7 worker reported is reproducible in THIS session — a
`Context backstop: …` line was appended to the output of one of my own `bash` results — which
establishes it as harness output attached to a tool result, not bytes in the tree.

THE PERMANENT TEST, AND ITS RED. `test/dimensions/row-page-curated-links.test.ts` gained
"keeps a row-backed Stack's records out of the project's curated-links file": after a real
`compileAndReport` scenario it asserts `.llmwiki/curated-links.json` does not exist and that
the same scenario file-backed does create it (anti-vacuity, no mocks). RED observed by
inverse-editing `page-source-seam.ts:408` away: `× keeps a row-backed Stack's records out of
the project's curated-links file → expected promise to reject, received Stats { … }` — i.e.
the record HAD gone to the file, while the sibling "restores the link" case stayed green,
which is exactly the degradation L9 measured. Restored by inverse edit; GREEN again with the
suite at 5/5.

OPEN FOR T9 (not T8's scope, and does not block T8): `docs/concepts/wiki-model.mdx` still
carries the Note "The file belongs to the checkout, not to the Stack: two hosts sharing a
Stack do not share curated links", which T5-T7 made false for a Stack-backed run. The new
guide states the current truth (a Stack keeps them in `wiki.curated_links`); that Note and
the CLI read-command caveat are T9's to correct. Also for T9: T7 confirms `--recompile`
writes no categories in EITHER path (scope parity, not a gap).

OPEN FOR T9 (not T8's scope, and does not block T8): `docs/concepts/wiki-model.mdx` still
carries the Note "The file belongs to the checkout, not to the Stack: two hosts sharing a
Stack do not share curated links", which T5-T7 made false for a Stack-backed run. The new
guide states the current truth (a Stack keeps them in `wiki.curated_links`); that Note and
the CLI read-command caveat are T9's to correct. Also for T9: T7 confirms `--recompile`
writes no categories in EITHER path (scope parity, not a gap).

[Resolved by L11: the Note and the CLI caveat were corrected, and `--recompile` is
documented as scope parity.]

### L11 — T9: the docs, the migration runbook, and two false claims corrected

`730f53d`. Files: `docs/guides/wiki-db-parity-migration.mdx` (new, 213 lines),
`docs/concepts/wiki-model.mdx`, `docs/cli/category.mdx`,
`docs/guides/row-backed-wiring-reachability.mdx`, `docs/docs.json`. Source and tests were
not touched.

TWO DOC CLAIMS WERE FALSE, both from the file-backed era, and both were corrected against
the code rather than reworded:

1. `docs/concepts/wiki-model.mdx`, the Note closing "Curated Links". Before: "The file
   belongs to the checkout, not to the Stack: two hosts sharing a Stack do not share
   curated links." After: the records live in `wiki.curated_links` on a row-backed run, so
   every host serving that Stack restores the same links; a project with NO Stack keeps
   them in `.llmwiki/curated-links.json`, which is the case the old sentence was still true
   about (two hosts sharing only the Stack, not the checkout, do not share them, and a
   fresh clone starts with none). Checked against
   `src/dimensions/wiki/curated-links-row-store.ts` (`createRowCuratedLinkStore`) and
   `src/compiler/curated-links-store.ts` (`createFileCuratedLinkStore`, now the fallback
   `curated-links-apply.ts:76` selects when the run has no Stack).
2. `docs/cli/category.mdx`, "What it cannot do yet". Before: "**Row-backed Stacks keep
   categories on disk.** … Two hosts sharing one Stack do not share their categories."
   That was falsified by T6: a Stack-backed compile writes `wiki.categories` and
   `wiki.category_members`. After: those rows and their membership evidence ARE shared, and
   the limitation that remains is the READ side — `llmwiki category` and
   `llmwiki categories-here` still read `wiki/categories/*.md` and are not Stack-aware.
   Checked by reading `src/commands/category.ts` and `src/commands/categories-here.ts`
   (both call `listCategories(root)` from `src/categories/store.ts`, which lists
   `wiki/categories/*.md`; neither file mentions a Stack) — the L8 finding, now stated to
   users instead of left implied.

The same page lost two more file-only assumptions: the opening paragraph now names both
storages per object kind, and the heading "What a category file carries" became "What a
category carries" (nothing linked to that anchor — checked with `git grep`).

WHERE THE BEHAVIOUR IS DOCUMENTED. `docs/concepts/wiki-model.mdx` gained a section "Where
a Stack-backed Run Keeps Them": one table pairing each of the four artifacts with its file
and row location, the statement that only the location changes (identity folding, anchor
re-validation, category identity, attribution marking are all shared code), and three
limits: the category read commands are not Stack-aware; `--recompile` writes no categories
on either storage (scope parity, not a gap); and a restored curated link is re-tested on
every render on both backends. Aliases, curated links and attribution each gained a
sentence in their own section saying which column or file carries the fact for a
Stack-backed run.

The FOURTH caveat the task named — `.fallowrc.json` lists `packages/llmwiki-kg/**` under
`ignorePatterns`, so a clean `fallow` run is never coverage of that package — was NOT
duplicated into the user-facing concept page. It is already stated, and verified, in
`docs/guides/row-backed-wiring-reachability.mdx` ("Static analysis does not cover the KG
package"), which is the page that carries every other verification caveat, and the new
wiki-model section links to it for exactly that reason. Duplicating a repo-development fact
into a user-facing concept page would be the wrong home for it.

THE MIGRATION RUNBOOK. `docs/guides/wiki-db-parity-migration.mdx` is a sibling of
`docs/guides/kg-classification-migration.mdx` — same shape (what it changes, why it is safe
to re-run, apply it, a fresh install needs nothing, verify it applied, after migrating,
there is no down migration), same Guides group, registered in `docs/docs.json`. The exact
commands documented, each verified against `scripts/apply-schemas.sh` and the compose files:

- `./scripts/apply-schemas.sh postgresql://aks:aks@localhost:5434/aks`
- `DATABASE_URL=postgresql://aks:aks@localhost:5434/aks ./scripts/apply-schemas.sh`
- `PSQL="docker exec -i llmwiki-kg-db-1 psql -U aks -d aks" ./scripts/apply-schemas.sh`
- `docker exec -i llmwiki-kg-db-1 psql -U aks -d aks < src/dimensions/wiki/migration_wiki_db_parity.sql`
- `docker compose -f docker-compose.yml exec -T db psql -U llmwiki -d llmwiki < src/dimensions/wiki/migration_wiki_db_parity.sql`
- `psql "postgresql://aks:aks@localhost:5434/aks" -f src/dimensions/wiki/migration_wiki_db_parity.sql`
- `CHECK_ONLY=true ./scripts/apply-schemas.sh postgresql://aks:aks@localhost:5434/aks` (drift)

The page states non-destructiveness and idempotency with the reasons (no `drop`, every
statement guarded by `if not exists`, no backfill because both new columns are NOT NULL with
a constant default), cites the nine cases of `test/dimensions/db-parity-migration.test.ts`
by name, and states that the drift check now expects the three new tables: on the local
`llmwiki-kg-db-1` it printed `policies: 32`, then `MISSING RLS: wiki.category_members`,
`MISSING RLS: wiki.categories`, `MISSING RLS: wiki.curated_links`, `drift detected.`, exit
1. That database has NOT had the migration applied (`to_regclass` returned NULL for all
three tables, `information_schema.columns` returned 0 rows for `aliases` and
`attribution_gaps`), so the drift report is measured, not imagined.

A DEFECT FOUND IN THE RUNNER'S OWN DOCUMENTATION, fixed in the docs rather than the script
(the script is outside T9's edit surface): the usage header advertises
`./scripts/apply-schemas.sh --check`, but `--check` is never parsed. The script reads
`TARGET="${1:-${DATABASE_URL:-}}"` and `CHECK_ONLY="${CHECK_ONLY:-false}"`, so `--check`
is consumed as a CONNECTION STRING. Measured: `./scripts/apply-schemas.sh --check` → exit 2,
`error: cannot connect to the database.` The working form is `CHECK_ONLY=true`, which is
what `.github/workflows/ci.yml:95` and `publish.yml:269` already run. The new page documents
that form and warns about the flag. The script's usage comment is still wrong; that is
reported for T10, not fixed here.

CHECKS RUN: `npm run release:check-docs` → exit 0; `npm run release:check-docs:current` →
exit 0; a `node -e` audit of `docs/docs.json` → all 61 navigation pages resolve to a file
(`missing: []`) and the new page is registered; a `node -e` link audit of the four changed
pages → every `](/path#anchor)` link resolves to an existing page AND an existing heading
anchor (`link problems: none`); the seven migration-suite case names quoted in the new page
were re-read from the test file; the mirror markers were re-read from
`src/dimensions/wiki/schema.sql:96,105,142,210`. No runnable test covers prose, and no test
suite was run for this slice.

STILL STALE AND OUTSIDE T9's EDIT SURFACE, for T10: the JSDoc header of
`src/compiler/curated-links-store.ts` still asserts "on a Stack the pages live in rows and
the curated records live on the host that compiled them, so two hosts sharing one Stack do
not share their curated links" — the exact claim the code no longer makes true and the docs
just corrected. It is a comment, not behaviour, but it is now the only place in the tree
that says it.

### L12 — T10: the two stale items closed, and the full gate run

Two commits, then this record. Node `v24.21.0` on PATH for every command; no `EBADENGINE`
warning appeared in any run (`grep -c EBADENGINE` over the `npm test` and `fallow` logs:
`0` and `0`).

**(a) `66f0b84` — `scripts/apply-schemas.sh` now parses `--check`.** The usage header
advertised the flag while `CHECK_ONLY` was read only from the environment, so `$1` became the
target and `--check` was handed to psql as a connection string. Chosen fix: MAKE THE
DOCUMENTED FLAG WORK rather than correct the header, because it is a small, safe parse
(`for argument in "$@"` with `--check` → `CHECK_ONLY=true`, any other recognised-flag-shaped
argument refused, everything else the target) and the header was the interface a reader
relies on. `CHECK_ONLY=true`, which CI runs at `.github/workflows/ci.yml:95` and
`publish.yml:269`, is untouched. RED first, in `test/apply-schemas-check-flag.test.ts` (3
cases, no database needed — the cases distinguish the missing-target branch from the
connection branch): `× reads --check as the verify mode, not as the target →
AssertionError: expected 'error: cannot connect to the database…' to contain 'error: no
target. Pass a connection s…'`, with the two PRESERVE cases already green. After the fix:
3/3 green. Proven against the live database (read-only; check mode issues SELECTs only):

```text
$ PSQL="docker exec -i llmwiki-kg-db-1 psql -U aks -d aks" ./scripts/apply-schemas.sh --check
policies: 32
  MISSING RLS: wiki.category_members
  MISSING RLS: wiki.categories
  MISSING RLS: wiki.curated_links
drift detected.
exit=1

$ PSQL="docker exec -i llmwiki-kg-db-1 psql -U aks -d aks" ./scripts/apply-schemas.sh postgresql://aks:aks@localhost:5434/aks --check
policies: 32
  MISSING RLS: wiki.category_members
  MISSING RLS: wiki.categories
  MISSING RLS: wiki.curated_links
drift detected.
exit=1

$ CHECK_ONLY=true PSQL="docker exec -i llmwiki-kg-db-1 psql -U aks -d aks" ./scripts/apply-schemas.sh
policies: 32
  MISSING RLS: wiki.category_members
  MISSING RLS: wiki.categories
  MISSING RLS: wiki.curated_links
drift detected.
exit=1

$ ./scripts/apply-schemas.sh --bogus
error: unknown option: --bogus
exit=2
```

The flag now reaches check mode and reports the drift L11 measured on that database, which
has NOT had the migration applied. The three `MISSING RLS` lines are that state, not a
regression. Two prose follow-ups in the same commit: the `<Note>` in
`docs/guides/wiki-db-parity-migration.mdx` that warned the flag was not parsed now documents
both forms, and the `ci.yml` comment that quoted the removed expression
`TARGET="${1:-${DATABASE_URL:-}}"` now describes the rule instead. `bash -n` clean;
`shellcheck` is not installed on this host, so the script has no linter result (named below).

**(b) `4f27013` — the `curated-links-store.ts` header corrected.** It still asserted "on a
Stack the pages live in rows and the curated records live on the host that compiled them, so
two hosts sharing one Stack do not share their curated links", which T5 falsified when
`wiki.curated_links` landed. The header now says what the code does: the file backend is this
module and is what a project with NO Stack gets (`curated-links-apply.ts:76`,
`link-review.ts:482` are the fallbacks), the Stack-backed backend is
`src/dimensions/wiki/curated-links-row-store.ts` selected at `page-source-seam.ts:408`, and
the record shape, bounds and overlay are shared so a lost anchor is dropped and reported
identically. The first line also stopped claiming to hold "the one function that applies it
to bodies" — the overlay is `curated-links-overlay.ts` and this file only stores. Comments
only; `git diff` on that commit touches no statement. Nothing else in the tree still carries
the false claim (`git grep -n "do not share their curated"` exits 1).

**THE FULL GATE RUN on the tree after both fixes.** Every command below was run in the
foreground, in this order, with the exact exit code observed.

| # | gate | exact command | exit | result |
|---|------|---------------|------|--------|
| 1 | root type-check | `npx tsc --noEmit` | 0 | no output, no diagnostics |
| 2 | KG package type-check | `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit` | 0 | no diagnostics |
| 3 | test type-check ratchet | `npm run typecheck:tests` | 0 | `1745 files checked; 260 baseline diagnostics in 94 files; no regression.` |
| 4 | KG type-check ratchet | `npm run typecheck:kg` | 0 | `349 files checked; 0 diagnostics baselined across 0 entries; no regression.` |
| 5 | build | `npm run build` | 0 | `ESM dist/index.js 443.66 KB`, `ESM dist/cli.js 501.70 KB`, `DTS dist/index.d.ts 6.67 KB`, viewer assets copied |
| 6 | affected tests | `npm run test:affected` | 0 | escalated to the full unit tier (the diff includes `scripts/`): `815 passed | 3 skipped (818)` files, `6189 passed | 4 skipped (6193)` tests, 226.69s |
| 7 | EXHAUSTIVE | `npm test` | 0 | `899 passed | 3 skipped (902)` files, `6717 passed | 7 skipped (6724)` tests, 321.92s, zero failures |
| 8 | static analysis | `./node_modules/.bin/fallow` | 0 | dead code `No issues found`; 4 duplicate clone groups, 61 lines, `0.0%`; `✗ 0 above threshold · 17228 analyzed · maintainability 91.1`; no unresolved imports (run AFTER gate 5, so `dist/` existed and the five phantom unresolved-import failures did not appear) |

The 7 skips in gate 7 are accounted for: 4 are the database-gated gateway files the run
names (`packages/llmwiki-kg/ts/src/routes/aks-gateway.test.ts` 1,
`ingest-gateway.test.ts` 1, `pages-gateway.test.ts` 2) and the other 3 are inside a file that
otherwise passed (`test/quickstart-integration.test.ts`, `19 tests | 3 skipped`). Neither of
those files, nor the conditions their skips test, appears in
`git diff --name-only a40fc3f..HEAD`, so this branch introduced none of the 7. The 4 clone
groups in gate 8 are in
six test files (`test/compiler/link-gate.test.ts`, `test/compiler/page-renderer-contextual-links.test.ts`,
`test/commands/links-here-cli.test.ts`, `test/commands/race-cli.test.ts`,
`test/context/ghost-rule.test.ts`, `test/context/race-path.test.ts`), none of which appears
in `git diff --stat a40fc3f..HEAD`, so they are pre-existing and untouched here.

**`fallow` IS NOT COVERAGE OF THE KG PACKAGE.** `.fallowrc.json` lists
`packages/llmwiki-kg/**` under `ignorePatterns`, so gate 8 says nothing about that package.
Gate 2 and gate 4 are what cover it, and both are green.

**CHECKS THAT DID NOT RUN, named:**

- `shellcheck scripts/apply-schemas.sh` — not installed on this host. `bash -n` was run
  instead (clean), and the behaviour is pinned by the 3-case suite.
- `npm run fallow:ci` (`scripts/fallow-ci.sh`, which wraps the analyzer against a report) —
  not in the task's gate list; the analyzer binary itself was run as gate 8.
- `npm run test:pack` (SDK packaging config) — out of the task's gate list and untouched by
  this diff.
- `npm run lint` — no such script exists in `package.json`; the analyzer is `fallow`.
- A browser/TUI check of anything — no UI changed.
- The docs anchor/link audit T9 ran — not repeated: this slice removed a `<Note>` and added
  a sentence inside an existing section, so no heading or link target moved.
  `npm run release:check-docs` (exit 0) and `npm run release:check-docs:current`
  (exit 0) were run because docs prose changed.

**SCRATCH ARTIFACTS LEFT ON DISK** (outside the worktree, for removal after review):
`/tmp/t10-npm-test.log` (the full gate-7 output) and `/tmp/t10-fallow.log` (the gate-8
output). The focused-test and gate runs created no directory inside the worktree;
`git status --porcelain` was empty before this record commit.

### L13 — T10 closure: the durable anti-fallback proof, and the last stale comment

Two commits, then this record. Node `v24.21.0` on PATH for every command (no
`EBADENGINE` warning in any run). No SQL statement, no source behaviour and no fixture
changed: the diff is one comment block, one new test file and this entry.

**(a) `c5795b6` — `src/dimensions/wiki/schema.sql`, the stale comment corrected.** The
comment above the section 2-4 mirror claimed the delimiters exist because
`test/dimensions/db-parity-migration.test.ts` "strips the region rather than keeping a
third copy of the DDL". That has been FALSE since `d66612f` (L5): the suite builds its
pre-migration database from the frozen snapshot
`test/fixtures/wiki-schema-pre-db-parity.sql`, and it reads no marker at all — the
`wiki-db-parity-mirror` string appears in exactly one place in the tree, in that suite's
header, which says the suite "no longer reads them". The comment now states the current
truth: the delimiters are DOCUMENTATION ONLY, the snapshot is what the test starts from,
and deriving both sides from one file is precisely the drift the snapshot exists to
prevent.

DECISION — the markers STAY, and the comment says why. Three reasons: (1) they mark
exactly which statements are the mirror, which is the region a reviewer has to compare
against `migration_wiki_db_parity.sql`; (2) the migration's own header already states they
are for "a reader's benefit" and that the test does not read them, so removing them would
make one file contradict the other again in the opposite direction; (3) they sit inside a
HIGH-RISK, already-reviewed migration slice, and deleting them would touch that slice's
text for a cosmetic gain. Measured: `git show c5795b6 | grep '^[+-]'` filtered to lines
that are not comments is EMPTY (7 insertions, 3 deletions, every one a `--` line), so no
DDL moved. `npx vitest run test/dimensions/db-parity-migration.test.ts` → exit 0, 9/9,
which is the suite that would notice if a statement had.

**(b) `81a5cfd` — `test/dimensions/row-store-of-record.test.ts`, the durable
anti-fallback suite (S1-S5, S8).** 261 lines, 130 non-comment, 7 cases, the longest case 8
lines. It closes the weakness L9 measured: parity compares two backends, so an UNWIRED row
seam stays green — the run falls back to `.llmwiki/curated-links.json` and the link still
comes back. The claim tested here is not "both backends agree" but "the row-backed half
needs nothing but rows".

The cases, in order, each `it` under 40 lines:

1. ANTI-VACUITY: the corpus run really produced all four artifacts in rows — the folded
   alias, ONE curated record (by stable key), the category's membership `evidenceKey`, and
   the marked gap `[consenso.md]`.
2. NO FALLBACK FILES: `wiki/concepts` holds no `.md`, `wiki/categories` holds no entry,
   and `.llmwiki/curated-links.json` does not exist (`stat` must reject with `ENOENT`).
3. The on-disk `sources/` directory was really deleted (a non-zero count before the
   removal, an empty listing after), so cases 4-7 read AFTER the last on-disk input is
   gone.
4. Aliases and title, through the row page reader the compile path installs on its seams
   (`createPageContentSource(...).read("concepts", …)`), equal to what the corpus recorded.
5. The attribution gap `[consenso.md]` and the merged body, through the same reader.
6. The category and its membership evidence, through the CATEGORY STORE PORT the compile
   path installs (`storeFor(harness)`, i.e. `createRowCategoryStore`).
7. The curated records through the ROW CURATED-LINK STORE at the count the corpus ends at:
   `rows.recordsAfterDrop === 0` and the live store's `load()` holds 0 — a store that never
   forgot a dropped record answers 1 and fails here.

NAMES ADAPTED RATHER THAN PASTED. Read before writing, every export used verified by grep:
`test/fixtures/category-rows.ts` exports `categoryRows`, `memberRows`, `storeFor`,
`withoutStack`, `parityRoots`, `saveScenarioSources`, `answerFor`, `stubCategoryCompile`,
`categoryLines`; `test/fixtures/store-parity-corpus.ts` exports the corpus constants,
`artifactLines`, `runParityCorpus`, `ParityEvidence`; the Stack helper
`test/dimensions/store-parity.test.ts` uses is `createProbeStack` from
`./harness-lifecycle.js` — the name the handoff guessed, and the real one. Two deliberate
choices: `parityRoots` is NOT used, because this suite needs ONE row-backed root and the
helper's `files/` sibling would be an empty directory that case 2 would then have to
explain; and `withoutStack` is NOT used, because there is no file-backed half here. The
reader signature is `PageContentSource.read(directory, slug)` from
`src/dimensions/wiki/page-scan-source.ts:324-345`; the store factories are
`createRowCuratedLinkStore` (`curated-links-row-store.ts:216`) and
`createRowCategoryStore` (`categories-row-store.ts:360`).

The no-database rule is the repository's, not a skip: the suite calls `missingTestDatabase`
(`test/fixtures/test-database-handoff.ts`) itself, so an unreachable database FAILS headed
`test/dimensions/row-store-of-record.test.ts (the row-store-of-record suite) needs a
Postgres database and none could be obtained.`, and only `LLMWIKI_TEST_ALLOW_NO_DATABASE=1`
turns it into explicit skips under an annotated title. It does NOT use
`withRowsStack`, whose contract is `if (!harness.reachable) return;` — a silent skip.

MEASURED TEETH, on the COMMITTED file. Inverse edit: `curatedLinks: createRowCuratedLinkStore(db as never, stackId),`
removed from `resolvePageSeams` (`src/dimensions/wiki/page-source-seam.ts:402-411`), which
is the exact degradation L9 recorded:

```text
 FAIL  test/dimensions/row-store-of-record.test.ts > a row-backed wiki keeps no file a fallback could serve > really recorded all four artifacts in rows before anything was removed
AssertionError: expected [] to have a length of 1 but got +0
 ❯ test/dimensions/row-store-of-record.test.ts:217:67
 FAIL  test/dimensions/row-store-of-record.test.ts > a row-backed wiki keeps no file a fallback could serve > left no page, category or curated-link file a fallback could serve
AssertionError: promise resolved "Stats{ dev: 66306, mode: 33204, …(12) }" instead of rejecting
 ❯ test/dimensions/row-store-of-record.test.ts:225:66
      Tests  2 failed | 5 passed (7)
exit=1
```

TWO failures, and they are the two directions of the same defect: the record had gone to
the FALLBACK FILE (case 2) and the Stack held nothing (case 1). The other five cases stayed
green, which is exactly why the record and the file assertions are both needed. Restored by
inverse edit; `git diff --stat src/dimensions/wiki/page-source-seam.ts` is EMPTY after the
restore, and the suite is green again:

```text
 ✓ test/dimensions/row-store-of-record.test.ts (7 tests)
      Tests  7 passed (7)
exit=0
```

**THE GATE RUN on the tree before this record.** Every command in the foreground, in this
order, with the exit code observed.

| # | gate | exact command | exit | result |
|---|------|---------------|------|--------|
| 1 | new suite | `npx vitest run test/dimensions/row-store-of-record.test.ts` | 0 | `1 passed (1)` file, `7 passed (7)` tests |
| 2 | parity + new | `npx vitest run test/dimensions/store-parity.test.ts test/dimensions/row-store-of-record.test.ts` | 0 | `2 passed (2)` files, `14 passed (14)` tests |
| 3 | related | `npx vitest related --run src/dimensions/wiki/schema.sql test/dimensions/row-store-of-record.test.ts` | 0 | selected only the new file (`1 passed (1)`, `7 passed (7)`): `schema.sql` is read by no importer, so its only runnable relation is the migration suite, run below |
| 4 | migration suite (because `schema.sql` changed) | `npx vitest run test/dimensions/db-parity-migration.test.ts` | 0 | `1 passed (1)` file, `9 passed (9)` tests |
| 5 | root type-check | `npx tsc --noEmit` | 0 | no output (0 lines), no diagnostics |
| 6 | test type-check ratchet | `npm run typecheck:tests` | 0 | `1746 files checked; 260 baseline diagnostics in 94 files; no regression.` (baseline NOT regenerated) |
| 7 | KG type-check ratchet | `npm run typecheck:kg` | 0 | `349 files checked; 0 diagnostics baselined across 0 entries; no regression.` |
| 8 | build | `npm run build` | 0 | `ESM` + `DTS dist/index.d.ts 6.67 KB`, viewer assets copied |
| 9 | static analysis | `./node_modules/.bin/fallow` | 0 | dead code `✓ No issues found`; `✗ 0 above threshold · 17251 analyzed · maintainability 91.1 (good)`; no unresolved imports (run AFTER gate 8) |

**`fallow` IS NOT COVERAGE OF THE KG PACKAGE.** `.fallowrc.json` lists
`packages/llmwiki-kg/**` under `ignorePatterns`, so gate 9 says nothing about that package;
gates 5/6/7 are what cover it and all three are green.

DUPLICATION, reported rather than glossed. Gate 9 reports 6 clone groups; at `4818b51`
there were 4, and the 2 new ones involve the new file:
`test/dimensions/row-store-of-record.test.ts:115-132` ↔
`test/dimensions/store-parity.test.ts:158-181` (the probe-Stack gate: `skipReasonFor` +
`probeStack`), and `test/dimensions/row-store-of-record.test.ts:204-215` ↔
`test/dimensions/store-parity.test.ts:211-223` (the `afterAll` teardown). Both are BELOW
the analyzer's threshold, so the gate is green, and both are the same intent written twice.
The real fix is one shared fixture — the same cure `category-rows.ts` applied to the
category suites ("duplication in tests is duplication of intent") — and it needs an edit to
`test/dimensions/store-parity.test.ts`, which is outside this closure's edit surface.
Left as a NAMED risk for the parent rather than papered over; one attempt was made to
shrink the pair (the anti-vacuity case was re-expressed, and its assertions became
STRONGER — it now pins the membership `evidenceKey` instead of a length), and the two
groups above survived it.

CHECKS THAT DID NOT RUN, named: `npm test` / `npm run test:affected` (both already run for
this feature at L12 and unaffected by a comment, a new test file and an ODD record — the
focused suites and the migration suite were run instead); `npx tsc -p
packages/llmwiki-kg/ts/tsconfig.json --noEmit` (untouched package, covered by gate 7's
ratchet); `shellcheck` (not installed on this host); `npm run release:check-docs` (no
`docs/` file changed here); no browser/TUI check (no UI changed).

SCRATCH ARTIFACTS LEFT ON DISK, outside the worktree, for removal after review:
`/tmp/t10c-new-test.log`, `/tmp/t10c-pair.log`, `/tmp/t10c-related.log`,
`/tmp/t10c-migration.log`, `/tmp/t10c-tsc.log`, `/tmp/t10c-tct.log`,
`/tmp/t10c-tck.log`, `/tmp/t10c-build.log`, `/tmp/t10c-fallow.log`,
`/tmp/t10c-red-final.log`, `/tmp/t10c-green-final.log`, plus the L12 pair
`/tmp/t10-npm-test.log` and `/tmp/t10-fallow.log`. No temporary directory was
created inside the worktree (each suite's `mkdtemp` root is removed in its own `afterAll`,
and the probe Stack is torn down there too), and no database was created by this closure —
the suites run against the run's own per-run database, which the harness drops.

### L14 — Final closure: the duplication `fallow` reported, and the gate of record on the final tree

Two commits, then this record. Node `v24.21.0` on PATH for every command (`node -v`
printed `v24.21.0`); `grep -c EBADENGINE` over the `npm test` and `fallow` logs: `0` and
`0`.

**(a) `9b6088e` — `test(db): share the parity probe-stack gate and teardown`.** L13 left the
two clone groups as a NAMED risk because the fix needed an edit to
`test/dimensions/store-parity.test.ts`, which was outside that closure's edit surface. This
closure has that surface.

WHAT WAS DUPLICATED, as `fallow` measured it at `bfe609c` BEFORE the change: 6 clone
groups, 128 lines across 8 files. The two new ones were both between the same pair of
suites — `row-store-of-record.test.ts:115-132` ↔ `store-parity.test.ts:158-181` (the
probe-Stack gate: provisioning, the `Observed:` detail, the no-database decision and the
`runSuite` choice) and `row-store-of-record.test.ts:204-215` ↔ `store-parity.test.ts:211-223`
(the `afterAll` teardown). The other four groups are untouched here.

WHERE IT WENT, and why there. One fixture, `test/fixtures/probe-stack-suite.ts` (218 lines,
77 non-comment), beside `category-rows.ts` and `store-parity-corpus.ts`, and exporting in
their style: `createProbeSuite({ label, databaseContext, title })` returns
`{ probeStack, skipReason, suiteTitle, runSuite, teardown }`. It imports `createProbeStack`
from `../dimensions/harness-lifecycle.js`, the same direction `test/fixtures/stack-env.ts`,
`query-stack-root.ts` and `stack-status-fixtures.ts` already import it. No new convention.

The rule it enforces is the repository's, not a new one: `missingTestDatabase`
(`test/fixtures/test-database-handoff.ts`) decides, it THROWS unless
`LLMWIKI_TEST_ALLOW_NO_DATABASE=1` is set, and only that opt-out turns a suite into explicit
skips under an annotated title. `teardown(projectRoot, savedEnv)` restores the environment,
calls `vi.restoreAllMocks()`, deletes the suite's temp root and then cleans the probe Stack
up, in that order.

BEHAVIOUR, MEASURED AGAINST THE PRE-CHANGE TREE, both states observed on each side:

| state | before (`bfe609c`) | after (`9b6088e`) |
|---|---|---|
| live database | `2 passed (2)` files, `14 passed (14)` tests, exit 0 | identical: `2 passed (2)`, `14 passed (14)`, exit 0 |
| unreachable database (`LLMWIKI_TEST_DATABASE_URL=postgresql://aks:aks@127.0.0.1:1/aks`) | `2 failed (2)` files, `Tests no tests`, exit 1, each file headed `<its path> needs a Postgres database and none could be obtained.` | identical files, exit and headline |
| same unreachable database + `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` | `2 skipped (2)` files, `14 skipped (14)`, exit 0, `<its path>: every case in this file is skipped.` twice | identical, same counts and lines |

ONE OBSERVABLE DIAGNOSTIC CHANGED, in the safe direction and stated rather than glossed:
the store-of-record suite quoted only the FIRST line of the harness message as its
`Observed:` detail (`firstLineOf`), while the parity suite stripped just the repeated advice
block (`observedFrom`). The shared helper has one implementation — the parity suite's — so
the store-of-record suite now reports the same fuller detail, e.g.
`Observed: select 1 against postgresql://aks:aks@127.0.0.1:1/aks failed — Failed query:
select 1` and, in the opt-out path, the trailing `— the warning printed above says whether
the server was unreachable or the Stack could not be provisioned`. The headline, the exit
code, the skip decision and the advice block are unchanged; only the `Observed:` detail
gained a line. Nothing was weakened: no assertion was edited, and the parity, anti-vacuity,
anti-fallback and record assertions are byte-identical to `bfe609c`.

SIZE, after the extraction: `store-parity.test.ts` 237 lines / 135 non-comment,
`row-store-of-record.test.ts` 195 lines / 96 non-comment, the fixture 218 / 77. The longest
`it` is 22 lines (`store-parity.test.ts`) and 8 lines (`row-store-of-record.test.ts`), both
under the 40-line limit; that length is pre-existing and was not touched by the extraction.
`npx tsc --noEmit` was clean on the intermediate tree, and
`npm run typecheck:tests` moved from `1746` to `1747 files checked` with the same `260
baseline diagnostics in 94 files` — the new fixture is one more file, not one more
diagnostic. The baseline was NOT regenerated. `git diff bfe609c 9b6088e` over the two
suites adds and removes no line containing `expect(` or `it(`, so every assertion and every
case is byte-identical.

`fallow` AFTER the change, run after `npm run build` as AGENTS.md requires: 4 clone groups
(the four pre-existing ones in `test/compiler/link-gate.test.ts`,
`test/compiler/page-renderer-contextual-links.test.ts`, `test/commands/links-here-cli.test.ts`,
`test/commands/race-cli.test.ts`, `test/context/ghost-rule.test.ts`,
`test/context/race-path.test.ts`), 61 lines duplicated, `0.0%`, `✗ 0 above threshold · 17249
analyzed · maintainability 91.1 (good)`, dead code `✓ No issues found`, and no
unresolved-import section. Target met: back to the 4 pre-existing groups, 0 new ones.

**(b) THE GATE OF RECORD on the FINAL tree** (HEAD `9b6088e`, the duplication fix included,
the new suite included). Every command in the foreground, in this order, exact exit codes as
observed.

| # | gate | exact command | exit | result |
|---|------|---------------|------|--------|
| 1 | EXHAUSTIVE | `npm test` | 0 | `900 passed | 3 skipped (903)` files, `6724 passed | 7 skipped (6731)` tests, 323.83s, zero failures. `test/dimensions/row-store-of-record.test.ts (7 tests)` and `test/dimensions/store-parity.test.ts (7 tests)` both green — the new suite is INSIDE this run, closing the L12/L13 gap |
| 2 | affected tests | `npm run test:affected` | 1 then 0 | first run: `1 failed | 815 passed | 3 skipped (819)` files, `1 failed | 6195 passed | 4 skipped (6200)` tests — the failure is the unrelated KG flake characterised below. Re-run of the SAME command, same selection (`819` files, `6200` tests): `816 passed | 3 skipped (819)`, `6196 passed | 4 skipped (6200)`, exit 0 |
| 3 | root type-check | `npx tsc --noEmit` | 0 | no output (0 lines) |
| 4 | KG package type-check | `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit` | 0 | no output (0 lines) |
| 5 | test type-check ratchet | `npm run typecheck:tests` | 0 | `1747 files checked; 260 baseline diagnostics in 94 files; no regression.` (baseline NOT regenerated) |
| 6 | KG type-check ratchet | `npm run typecheck:kg` | 0 | `349 files checked; 0 diagnostics baselined across 0 entries in packages/llmwiki-kg/ts/tsconfig.json; no regression.` |
| 7 | build | `npm run build` | 0 | `ESM dist/index.js 443.66 KB`, `ESM dist/cli.js 501.70 KB`, `DTS dist/index.d.ts 6.67 KB`, viewer assets copied |
| 8 | static analysis | `./node_modules/.bin/fallow` | 0 | dead code `✓ No issues found`; `● Duplicates (4 clone groups)`, `61 lines (0.0%) duplicated across 6 files`; `✗ 0 above threshold · 17249 analyzed · maintainability 91.1 (good)`; no unresolved imports (run AFTER gate 7, so `dist/` existed) |

THE 7 SKIPS IN GATE 1 are the same 7 L12 accounted for and the branch still does not touch
them: `packages/llmwiki-kg/ts/src/routes/aks-gateway.test.ts` 1,
`ingest-gateway.test.ts` 1, `pages-gateway.test.ts` 2 (the database-gated gateway files), and
`test/quickstart-integration.test.ts` `19 tests | 3 skipped`.

**GATE 2's SINGLE FAILURE, quoted verbatim and characterised** — it is PRE-EXISTING and not
caused by this branch:

```text
 FAIL  packages/llmwiki-kg/ts/src/routes/ingest/support-wiring.test.ts > ingest asks the semantic-support question > leaves the support question unanswered when the provider fails (S25, S12)
AssertionError: expected 'pending' to be 'classified' // Object.is equality

Expected: "classified"
Received: "pending"

 ❯ packages/llmwiki-kg/ts/src/routes/ingest/support-wiring.test.ts:320:43
      Tests  1 failed | 6195 passed | 4 skipped (6200)
```

The evidence that it is not this branch's: (i) `git diff --stat
a40fc3f078bef4816ff90cff1c8c7c8b8c626d53..HEAD -- packages/llmwiki-kg/` is EMPTY and
`git log a40fc3f..HEAD -- packages/llmwiki-kg/ts/src/routes/ingest/support-wiring.test.ts`
lists no commit, so that file and the code it exercises are byte-identical to `main`'s tip;
(ii) `package.json` and `package-lock.json` are not in the branch diff either; (iii) gate 1,
the exhaustive run on THIS tree, passed that same file four minutes earlier (`7 tests` inside
a green 903-file run); (iv) the failing case passes deterministically on its own — 3 runs at
`9b6088e` and 5 runs in a `a40fc3f` worktree at `/tmp/t10f-base-a40fc3f`, all `5 passed (5)`;
(v) the whole `packages/llmwiki-kg/ts/src/routes/ingest/` directory 3 times at `a40fc3f` and
3 times at `9b6088e`, `56 passed (56)` each. The assertion itself is order-sensitive: the
injected `JevProviderError` is the FIRST step of a scripted client that answers BOTH the
classification and the support question, so a call order that puts classification first
makes the failure land on classification and leaves the row at `pending` instead of
`classified`. That fragility is in the test's scripting, in a package this branch never
opened. NOTHING WAS CHANGED to make it pass; the re-run is reported beside the first run
rather than in place of it.

**`fallow` IS NOT COVERAGE OF THE KG PACKAGE.** `.fallowrc.json` lists
`packages/llmwiki-kg/**` under `ignorePatterns`, so gate 8 says nothing about the package
that gate 2's flake lives in; gates 4 and 6 are what cover it, and both are green.

**CHECKS THAT DID NOT RUN, named:**

- `shellcheck scripts/apply-schemas.sh` — not installed on this host. Not re-run here either;
  the script was not touched by this closure.
- `npm run fallow:ci` (`scripts/fallow-ci.sh`) — wraps the analyzer against a report and is
  not in the task's gate list; the analyzer binary itself was gate 8.
- `npm run test:pack` (SDK packaging config) — out of the gate list, and this diff touches no
  packaging file.
- `npm run lint` — no such script exists in `package.json`.
- `npm run release:check-docs` / `:current` — not run: no `docs/` file changed in either
  commit (only two test files, one new fixture and this document).
- A browser/TUI check of anything — no UI changed. The migration suite
  (`test/dimensions/db-parity-migration.test.ts`) and `src/dimensions/wiki/**` were NOT
  re-run separately: they are inside gate 1's exhaustive run, which covers them.
- `git worktree remove /tmp/t10f-base-a40fc3f` — deliberately not run (no deletion
  operations); the worktree is left on disk and named below for the owner to remove.

**SCRATCH ARTIFACTS LEFT ON DISK** (outside the worktree, for removal after review):
`/tmp/t10f-base-a40fc3f`, a `git worktree add --detach` of
`a40fc3f078bef4816ff90cff1c8c7c8b8c626d53` with symlinked `node_modules`,
`packages/llmwiki-kg/ts/node_modules` and `dist` pointing at this worktree (that symlink is
why the base run used this tree's dependencies and is not a second install); plus
`/tmp/t10f-build-baseline.log`, `/tmp/t10f-fallow-baseline.log`,
`/tmp/t10f-baseline-pair.log`, `/tmp/t10f-baseline-nodb.log`,
`/tmp/t10f-baseline-optout.log`, `/tmp/t10f-after-pair.log`, `/tmp/t10f-after-nodb.log`,
`/tmp/t10f-after-optout.log`, `/tmp/t10f-b-nodb.n`, `/tmp/t10f-a-nodb.n`,
`/tmp/t10f-b-opt.n`, `/tmp/t10f-a-opt.n`, `/tmp/t10f-build-after.log`,
`/tmp/t10f-fallow-after.log`, `/tmp/t10f-gate1-npm-test.log`,
`/tmp/t10f-gate2-test-affected.log`, `/tmp/t10f-gate2-test-affected-rerun.log`,
`/tmp/t10f-gate3-tsc.log`, `/tmp/t10f-gate4-tsc-kg.log`, `/tmp/t10f-gate5-tct.log`,
`/tmp/t10f-gate6-tck.log`, `/tmp/t10f-gate7-build.log`, `/tmp/t10f-gate8-fallow.log`,
`/tmp/t10f-support-alone-{1,2,3}.log`, `/tmp/t10f-base-support-{1,2,3,4,5}.log`,
`/tmp/t10f-base-ingest-dir-{1,2,3}.log`, `/tmp/t10f-head-ingest-dir-{1,2,3}.log`.

NO SCRATCH DATABASE was created by hand. Both suites and every database-backed file in the
runs above use the run's own per-run database, which the harness drops; the container
`kind_kirch` was ADOPTED by the run (`[test-database] adopted running
pgvector/pgvector:pg16 container kind_kirch`) and left running (`keeping reusable container
kind_kirch for the next run`), so it is a reusable resource, not a leak. No temporary
directory was created inside the worktree, and `git status --porcelain` was empty before
this record commit.

### L15 — T11: the CLI read surface closed, and where S8 stops applying

The blocker L8 recorded and L11 documented as a user-facing limitation: `llmwiki category`
and `llmwiki categories-here` called `listCategories(process.cwd())`, so for a row-backed
Stack the taxonomy a compile had just written to `wiki.categories` / `wiki.category_members`
was UNREADABLE through the CLI. Parity with an unreadable surface is not parity. Three
commits: `52f8ea76ea909256a62f96c6d7fd1131a63f83d3` (the verbs), `f8efc03712ceac914e62ef17a8831265a931f99e`
(the parity cases), `6a14f8d14ab6a638b3e4c9075f1b40af4982c658` (the docs), then this record.

THE PATTERN WAS COPIED, NOT INVENTED. The command the shape comes from is `graph-health`:
a read-only verb that reaches Stack-scoped data through a WRAPPER which resolves the seams
internally (`buildViewerSnapshot` -> `withRawPageSource`), so the command never reads the
environment, never imports a row store and never opens a database. The seam that actually
decides is `resolvePageSeams` (`src/dimensions/wiki/page-source-seam.ts:396`), reached here
through the multi-seam wrapper `withPageSeams` (`:465`). `withCategoryStore` (`:512`) is the
one new function, and the whole of it is one line of delegation:

```ts
return await withPageSeams(env, async (seams) =>
  await fn(seams.categories ?? createFileCategoryStore(root)));
```

Same variable (`AKS_STACK_ID`), same empty-means-files rule, same order as the compile path.
No new flag (`--stack` exists for write verbs in `src/cli/stack-option.ts` and was
deliberately NOT added here: the variable is the addressing model), no second notion of
"database-backed", and neither command chooses a backend.

S8, ANSWERED HONESTLY, AND ITS LIMIT. The reachability claim is `git`-checkable: `git grep -n
'withCategoryStore' -- src/` → `page-source-seam.ts:512` plus the two commands, and the
chain continues into `resolvePageSeams:410 categories: createRowCategoryStore` →
`categories-row-store.ts:365 list` → `:184 readAllTx`. The unwire proof has TWO results and
the second one is the interesting one:

1. Removing `categories: createRowCategoryStore(db as never, stackId)` from
   `resolvePageSeams` (the L9/RED unwire) turned `stores the same category with the same
   membership evidence` and the unreachable-Stack case red, and left BOTH new CLI parity
   cases GREEN. Reason, measured rather than assumed: with the seam entry gone the
   row-backed COMPILE also falls back (`index.ts:1643 store: flags.seams?.categories` →
   `categories/assign.ts store ?? createFileCategoryStore(root)`), so it writes category
   FILES into the row-backed root and the two verbs agree with each other. This is exactly
   the invisibility L9 recorded for curated links, now measured on categories, and it is why
   a parity comparison alone cannot prove this wiring.
2. So the wiring claim is pinned where it actually lives: reverting `withCategoryStore` to
   its pre-change body (`return await fn(createFileCategoryStore(root))`) turned all three
   new cases red (`3 failed | 7 passed (10)`), and restoring it returned `10 passed (10)`.

S# COVERED: **S4** (categories read back through the row store, identity and membership
evidence intact, byte-identical envelope) and **S7** (the parity claim now covers the CLI
surface, not only the stores) and **S8** (reachability, above). No other `S#` was in scope;
S1 is the request itself and was already carried by T1-T10.

WHAT WAS NOT CHANGED, named: the four existing parity artifact cases are untouched (the
file grew by three cases and one helper: 237 -> 312 lines, 10 cases); `docs/` prose only in
the three pages that carried the false claim; no migration, no schema, no store. `Risk:
item 3 (a change to a contract others consume: both command surfaces and the CLI help text
now address a Stack), mitigated by the byte-identical envelope the parity case pins and by
the file-backed halves of the unchanged `category-cli` / `categories-here-cli` suites.`

MEASURED, every command in the foreground on this tree, Node `v24.21.0`:

| # | check | exact command | exit | result |
|---|-------|---------------|------|--------|
| 1 | RED | `npx vitest run test/dimensions/store-parity.test.ts` (before the feature slice) | 1 | `3 failed | 7 passed (10)` — the three new cases only |
| 2 | GREEN | same, after the slice | 0 | `10 passed (10)` |
| 3 | UNWIRE RED | same, `withCategoryStore` reverted to the file store | 1 | `3 failed | 7 passed (10)` |
| 4 | UNWIRE restore | same | 0 | `10 passed (10)` |
| 5 | existing CLI suites | `npx vitest run test/commands/category-cli.test.ts test/commands/categories-here-cli.test.ts` | 0 | `6 passed` + `6 passed` |
| 6 | related | `npx vitest related --run src/commands/category.ts src/commands/categories-here.ts src/dimensions/wiki/page-source-seam.ts src/cli/context-commands.ts` | 0 | `232 passed (232)` files, `1389 passed (1389)` tests |
| 7 | root type-check | `npx tsc --noEmit` | 0 | no output |
| 8 | test ratchet | `npm run typecheck:tests` | 0 | `1747 files checked; 260 baseline diagnostics in 94 files; no regression.` (baseline NOT regenerated) |
| 9 | KG ratchet | `npm run typecheck:kg` | 0 | `349 files checked; 0 diagnostics baselined across 0 entries; no regression.` |
| 10 | build | `npm run build` | 0 | `ESM dist/index.js 443.66 KB`, `DTS dist/index.d.ts 6.67 KB`, viewer assets copied |
| 11 | static analysis (after gate 10) | `./node_modules/.bin/fallow` | 0 | dead code `✓ No issues found`; `● Duplicates (4 clone groups)`, 61 lines, `0.0%` — the four pre-existing groups, no new one; `✗ 0 above threshold · 17258 analyzed · maintainability 91.1 (good)`; no unresolved imports |
| 12 | docs | `npm run release:check-docs` and `npm run release:check-docs:current` | 0 / 0 | both silent-clean |

`fallow` IS NOT COVERAGE OF THE KG PACKAGE: `.fallowrc.json` lists `packages/llmwiki-kg/**`
under `ignorePatterns`, so gate 11 says nothing about that package; gates 7/8/9 cover it and
all three are green.

**`npm test` EXITED 1 TWICE, IN THE KG PACKAGE ONLY, AND NOT REPRODUCIBLY.** Reported
rather than laundered:

- run 1: `12 failed | 888 passed | 3 skipped (903)` files, `21 failed | 6706 passed | 7 skipped
  (6734)` tests — every failing file under `packages/llmwiki-kg/ts/src/` (`db.test.ts`,
  `backfeed-approve`, `backfeed-ontology`, `backfeed-reject`, `ingest/classification-audit`,
  `ingest/classification-wiring`, `ingest/convergence`, `ingest-formation`,
  `ingest-ontology`, `ingest/support-wiring`, `reclassify/reclassify-wiring`, `stack-graph`).
  9 of the 21 failures are one cause, quoted: `Caused by: PostgresError: insert or update on
  table "stack_documents" violates foreign key constraint "stack_documents_stack_id_fkey"`,
  `Key (stack_id)=(…) is not present in table "stacks"` — a Stack row that existed when the
  suite provisioned it was gone when it inserted.
- run 2, same command, same tree: `3 failed | 897 passed | 3 skipped (903)` files, `3 failed |
  6724 passed | 7 skipped (6734)` tests — `backfeed-approve`, `backfeed-ontology` (1 case
  each, the same ones as run 1) plus `documents-upload`, which run 1 did not fail. A
  DIFFERENT set on the same code, which is what makes it a flake rather than a defect.
- NOT THIS BRANCH: `git diff --stat a40fc3f..HEAD -- packages/llmwiki-kg/` is empty and this
  slice touches no file in that package, no `vitest.config.ts`, no global setup, no fixture.
- NOT REPRODUCIBLE IN ISOLATION: the 12 files of run 1 together → `12 passed (12)` files,
  `98 passed (98)` tests, exit 0; the 3 files of run 2 together → `3 passed (3)`, `20 passed
  (20)`, exit 0.
- CAUSE, MEASURED: another session on this host was running vitest against the SAME Postgres
  database throughout (`ps -eo args | grep vitest` showed 12 vitest processes at the start of
  run 2, including `ingest/*.test.ts` batches; a `pgrep` poll of ~7 minutes never found the
  database free). Several sessions sharing one container is the environmental condition L14
  already characterised for `support-wiring`, and it is why a Stack row can vanish between
  provision and insert.
- A BASE MEASUREMENT WAS ATTEMPTED AND IS NOT EVIDENCE: `npm test` in the pre-existing
  worktree `/tmp/t10f-base-a40fc3f` (`a40fc3f`) exited 1 with `5 failed | 885 passed | 3
  skipped (893)` files — a DIFFERENT set again (`test/cli.test.ts`, `test/mcp-stdio`,
  `test/okf-mcp-stdio`, `test/quickstart-integration`, `test/viewer-pack`), all subprocess
  tests. That worktree symlinks `node_modules` and `dist` to THIS tree (L14), so its `dist`
  is built from branch code and the comparison is contaminated at exactly the tests that
  spawn a CLI. Stated, not relied on.

REUSABLE PATHS: `test/dimensions/store-parity.test.ts` (the `readCategorySurface` helper and
the three cases), `src/dimensions/wiki/page-source-seam.ts:512`, `docs/cli/category.mdx`.

SCRATCH LEFT ON DISK (outside the worktree, for the owner to remove): `/tmp/cli-parity-red.log`,
`/tmp/cli-parity-green.log`, `/tmp/cli-parity-green2.log`, `/tmp/cli-parity-unwired.log`,
`/tmp/cli-parity-unwired-resolver.log`, `/tmp/cli-tsc.log`, `/tmp/cli-tct.log`,
`/tmp/cli-tck.log`, `/tmp/cli-build.log`, `/tmp/cli-fallow.log`, `/tmp/cli-related.log`,
`/tmp/cli-npm-test.log`, `/tmp/cli-npm-test-2.log`, `/tmp/cli-base-npm-test.log`,
`/tmp/cli-kg-files.txt`, `/tmp/cli-kg-group-head.log`, `/tmp/cli-kg-group2.log`,
`/tmp/cli-check-docs.log`, `/tmp/cli-check-docs2.log`, `/tmp/cli-final-suites.log`,
`/tmp/cli-commit2.log`, `/tmp/cli-commit3.log`, and the pre-existing
`/tmp/t10f-base-a40fc3f` worktree. No temporary directory was created inside the worktree
(`git status --porcelain` was empty before each commit), and no database was created by hand:
the suites use the run's own per-run database.

### L16 — The exhaustive gate, proven in isolation

L15 left `npm test` reported AND UNRESOLVED: exit 1 twice on the same tree, with DIFFERENT
failure sets — `12 failed | 888 passed | 3 skipped (903)` files and then `3 failed | 897
passed | 3 skipped (903)` files — every failing file under `packages/llmwiki-kg/ts/src/`. A
flake is not a closed gate. The gate was re-run against a database this session owned, and
this entry records what that measured and what it did NOT establish.

WHAT THE EARLIER REDS RAN AGAINST. The shared server those two runs used is the Postgres
`llmwiki-kg-db-1` publishes on 5434, and OTHER SESSIONS' VITEST WORK WAS RUNNING AGAINST IT
throughout: TWELVE concurrent vitest processes were measured on that server at the start of
run 2 (`ps -eo args | grep vitest`), and a `pgrep` poll over roughly seven minutes never
found it free. Twelve writers on one database, one schema and one `stacks` table accounts
for a Stack row vanishing between provision and insert — the `stack_documents_stack_id_fkey`
violation L14 and L15 already quoted.

NOT THIS BRANCH: `git diff --stat a40fc3f..HEAD -- packages/llmwiki-kg/` is empty. Every
failing file lived in that package; this branch's diff does not reach it.

THE GATE ON A PRIVATE SERVER. A pgvector container of its own was started for the run —
`llmwiki-isolated-gate`, image `pgvector/pgvector:pg16`, host port `5455` — and the run was
pinned to it through BOTH variables the harnesses read, `LLMWIKI_TEST_DATABASE_URL`
(`test/fixtures/test-database.ts:41`) and `AKS_TEST_DATABASE_URL`
(`packages/llmwiki-kg/ts/src/routes/ingest-harness.ts:41-47` and its sibling harnesses):

```bash
docker run -d --name llmwiki-isolated-gate -p 5455:5432 \
  -e POSTGRES_USER=aks -e POSTGRES_PASSWORD=aks -e POSTGRES_DB=aks \
  pgvector/pgvector:pg16
LLMWIKI_TEST_DATABASE_URL=postgresql://aks:aks@localhost:5455/aks \
AKS_TEST_DATABASE_URL=postgresql://aks:aks@localhost:5455/aks \
  npm test
```

RESULT: exit `0`, zero failures.

| line | value |
| --- | --- |
| `Test Files` | `900 passed`, `3 skipped`, `903` total |
| `Tests` | `6727 passed`, `7 skipped`, `6734` total |
| `Duration` | `365.70s` |

The three skipped files are the by-design gateway suites,
`packages/llmwiki-kg/ts/src/routes/{aks,ingest,pages}-gateway.test.ts` — the same three the
earlier runs skipped, so nothing was skipped to make this run green.

ISOLATION WAS EVIDENCED, NOT ASSUMED. Four observations, each of which would have failed if
the run had touched the shared server:

- the run log printed `[test-database] LLMWIKI_TEST_DATABASE_URL is set; no container
  started` (`test/fixtures/testcontainers-postgres.ts:324`): the resolver took the override
  branch and started nothing of its own.
- the handoff record the run publishes reported `container: null` and `reused: false` — the
  `source: "override"` record built at `test/fixtures/testcontainers-postgres.ts:325`, which
  is what "this run owns no container and adopted none" means.
- `ss -tnp` showed NO client sockets on port 5455 once the run was done, so nothing was left
  holding a connection to the private server (`pg_stat_activity` on that container reported
  `0` client connections afterwards).
- `kind_kirch` (32782) and `llmwiki-kg-db-1` (5434), the shared servers, were never
  connected to during the run.

WHAT THIS DOES AND DOES NOT SETTLE. It settles the verdict: the earlier reds were
environmental contention on a shared database, not a property of this branch, and the same
tree passes exhaustively on a server no other session was writing to. The per-file attribution of
those earlier reds is settled as well, recovered by READING the surviving run logs rather than by
re-running them. `/tmp/t10f-gate2-test-affected.log` recorded `ingest/support-wiring.test.ts`
failing the test `leaves the support question unanswered when the provider fails (S25, S12)` with
`AssertionError: expected 'pending' to be 'classified'` at `support-wiring.test.ts:320:43`. A
second, distinct signature in the contended run was `PostgresError … violates foreign key
constraint "stack_documents_stack_id_fkey"` (SQLSTATE 23503), issued from `ingest-harness.ts:264`
inside the transaction at `:262` — and it appears on another branch as well, so it is not
branch-specific. Those log paths are the only surviving copies and live outside the worktree. The
run-1 and run-2 file sets L15 lists remain descriptions of two contaminated runs.

REPRODUCE IT (Node 24; no host `psql` needed — the fixtures replay `scripts/apply-schemas.sh`
through the pg client, `packages/llmwiki-kg/ts/src/testing/per-run-database.ts:257`). If a
container of that name is still running, reuse it or pick another name and port:

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
docker run -d --name llmwiki-isolated-gate -p 5455:5432 \
  -e POSTGRES_USER=aks -e POSTGRES_PASSWORD=aks -e POSTGRES_DB=aks \
  pgvector/pgvector:pg16
LLMWIKI_TEST_DATABASE_URL=postgresql://aks:aks@localhost:5455/aks \
AKS_TEST_DATABASE_URL=postgresql://aks:aks@localhost:5455/aks \
  npm test
```

Then confirm the run took the override branch: its log must contain `[test-database]
LLMWIKI_TEST_DATABASE_URL is set; no container started`. If it does not, the run used a
different server and its verdict does not transfer to this entry.

S# COVERED: none. This entry records a measurement of the existing tree; no file under
`src/`, `packages/` or `test/` changed and no `S#` was in scope. `Risk: none` — no code,
schema, contract or configuration changed; this is the feature document's own log.

SCRATCH LEFT ON DISK: the container `llmwiki-isolated-gate` (host port 5455) is still
running, left for the owner to remove; the run's own log is outside the worktree. Neither is
a path inside the repository — `git status --porcelain` was empty before the commit that
holds this entry.
