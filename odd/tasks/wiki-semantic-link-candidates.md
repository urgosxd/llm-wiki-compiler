# Wiki semantic link candidates — report-only measurement channel

Adds one analysis command under `scripts/` that reads already-stored page/chunk embeddings, ranks top-k concepts per paragraph by stored-vector similarity, subtracts the pairs the lexical channels already produce, and emits a stratifiable, hand-labellable report at thresholds 0.86 / 0.80 / 0.75.

Report-only: the command writes one report file to a caller-named path and **must not modify any page, any corpus, or any compile path**. No provider call, no embedding computation, no schema change, no JEV.

## Specs

**S1 — Report-only invariant.** "It must not modify any page." "**Do not change any page body.** If nothing else holds, this property must: `git diff --stat` on any corpus directory is empty." "**Output must be inspectable and diffable**: a markdown or JSON report written to a path the caller names, defaulting to something under a gitignored location. **Do not write into any wiki corpus.**" Evidence obligation, revised by L4: both corpora are now Postgres stacks, so the no-modification proof is (a) every SQL session runs `SET default_transaction_read_only = on`, and (b) the row counts of `wiki.pages`, `wiki.page_embeddings` and `wiki.page_chunk_embeddings` are captured before and after each run for each stack and reported as identical. No page body, no schema, and no row is written.

**S2 — Reuse stored embeddings only.** "**Reuses the existing embeddings.** Do not compute embeddings: no provider, no `embed()` call. Read what is stored. If a corpus has none, say so for that corpus and skip it."

**S3 — Top-k concepts per paragraph, via the query path's own ranker.** "For each **paragraph (chunk)** in a corpus, retrieves **top-k concepts** by stored vector similarity, using the **same ranking primitives the query path uses** — call them, do not reimplement cosine over a full matrix."

**S4 — Lexical exclusion.** "**Filters out every pair the lexical channels already produce**: the concept's **title** or a declared alias appearing in the paragraph (word-bounded, using `canonicalConceptKey` from `src/dimensions/wiki/concept-identity.ts`). What remains is the **incremental** discovery — the links nobody could have found by string match."

**S5 — Threshold stratification.** "**Stratifies by threshold** — report at **0.86, 0.80, 0.75** separately, so the trade-off is visible rather than assumed." Each threshold is an inclusive lower bound on the cosine.

**S6 — Per-pair report fields.** "**Emits a reviewable report**: per pair, the corpus, the paragraph id, the concept, the **cosine**, a short paragraph excerpt, and a flag for whether the concept's title/alias appears **anywhere in the document** (not just the paragraph) — because a document-level mention is evidence the relation is real even when the paragraph doesn't name it."

**S7 — Hand-labellable sample.** "**Emits a hand-labellable sample** — for each threshold, a bounded random sample (say 20 pairs) formatted so a human can mark each correct/incorrect. **This is the deliverable that answers the precision question**, so make it easy to fill in."

**S8 — Commit the command, never the output.** "Commit the command and its report format. **Do not commit the report output** (gitignore the default path)."

**S9 — Corpora, read-only (revised by L4).** "A real 28-page stack and a real 398-page stack exist in a local Postgres (`llmwiki-kg-db-1`, db `aks`) with nomic vectors. **Docker is reachable.** Use them **read-only** — `SELECT` only, no writes, no schema change, and say which stack you used." Identified stacks: `wiki` = `7f1b3b36-540a-4f8d-ae40-8f2ede8ef92c` (28 pages / 28 page_embeddings / 71 chunk_embeddings) and `Stack de pruebas (vacio)` = `d61bf181-efb1-4a9c-a39b-1b986313e5c1` (398 pages / 398 page_embeddings / 1722 chunk_embeddings). The file-store corpus `/home/urgosxd/Desktop/ofk/mewSdg` is **retired by the Manager (L4)**: do not use it, do not cite it, do not report numbers from it. Neither stack carries declared aliases — the live database has no `aliases` column and `wiki.concept_aliases` is empty — so on real data the lexical-exclusion filter is exercised against **canonical titles only**. No credential, token or password may reach the command's output or the report.

**S10 — Per-threshold numbers, with judgements labelled.** "**Report per threshold**: candidate pairs found, pairs already covered lexically (the excluded set, as a count), incremental pairs, and how many of the sampled pairs a reasonable reader would call correct with your reasoning — **mark clearly which correctness judgements are yours and which would need the owner**."

**S11 — Scope prohibitions.** "**Do not modify `link-anchoring.ts`, `import/run.ts`, `link-repair.ts`, `resolver.ts`, or any compile path.**" "**Do not add JEV.** No vendor, no key, no second integration." No `--no-verify`, no `HUSKY=0`, no `--amend`, no push, no `.env*` access, no provider call, no schema change, no page modification, no JEV.

**S12 — Test-first, and a test that cannot pass on an empty list.** "Test-first: write one test per rule the command asserts — the lexical-exclusion filter, the threshold stratification, the deterministic sample selection. **A test that could pass with an empty candidate list is not a test** — assert a known pair survives on a fixture."

**S13 — Gates.** "`npx tsc --noEmit` · `npm run typecheck:tests` · `npm run lint` (ceiling **`558 / 396 / 423`**) · `npm run fallow:ci` — and if the hook prints "compared nothing", say the verdict is vacuous rather than presenting it as proof — the focused tests for what you add."

**S14 — Toolchain.** "Node 24 ONLY: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>`. **`corepack pnpm install --frozen-lockfile` first.**" Bare `pnpm` is broken on this host; `corepack pnpm` is the only working invocation.

**S15 — State weakened coverage, never substitute silently.** "If, without `mewSdg`, you find you cannot exercise a rule the brief asked for, **say which and why** instead of substituting a weaker check silently."

## Tasks

| ID | Specs | Route | Surfaces | Commit |
| --- | --- | --- | --- | --- |
| T0 | S14 | worker | `node_modules/` | none (environment only) |
| T1 | S1, S11, S14 | worker | `odd/tasks/` | `docs(odd): add semantic link-candidate feature spec` |
| T2 | S4, S5, S7, S12 | worker | `scripts/link-candidate-*.ts`, `scripts/*.test.ts` | `feat(scripts): stratify and sample incremental link candidates` |
| T3 | S2, S3, S6, S8 | worker | `scripts/link-candidates-db.ts`, `scripts/link-candidates-report.ts`, `scripts/measure-semantic-link-candidates.ts`, `scripts/*.test.ts`, `.gitignore` | `feat(scripts): measure stored-vector link candidates on Postgres stacks` |
| T4 | S9, S10, S15 | worker | none (report output is gitignored) | none |
| T5 | S13 | verify | none | none |
| T6 | S1, S8, S11 | verify | none | none |

T2 is test-first: observe RED for each of the three asserted rules before the implementation exists, then GREEN.
T5 runs the four gates and the focused tests. T6 proves the no-modification invariant and the no-forbidden-path diff.

## Log

**L1 — original request, verbatim.**

Project assignment for branch feat/wiki-semantic-link-candidates:

Build the **report-only semantic candidate channel** for wiki links, and use it to measure the precision number that is still missing. **It must not modify any page.**

Repo: primary `/home/urgosxd/Desktop/ofk/llm-wiki-compiler`, `main` = **`2e2242fa0030bccff32cb07c3fa1f5e087e66436`**. Node 24 ONLY: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>`. **`corepack pnpm install --frozen-lockfile` first.** Read `AGENTS.md` in full. **No `.env*` file read, listed, or grepped. No provider call, no network request, no paid compile.**

## The problem, measured

Wiki's links come from three **lexical** channels — model-inline wikilinks, a regex resolver over **canonical titles only** (`resolver.ts:315` `addWikilinks`; `findTitleMatches:285` never consults aliases), and a backlink review restricted to **literal mentions** (`link-review-candidates.ts:285` `collectCandidates`, `MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE = 4`, `MAX_LINK_REVIEW_PAGES_PER_RUN = 20`). **Nothing semantic selects or ranks link candidates**, so a relation never *named* is never considered.

The retrieval to fix that **already exists and is populated**: `wiki.page_embeddings` and `wiki.page_chunk_embeddings` are `vector(768)` with HNSW cosine indexes; `pickSearchRefs` / `findRelevantChunksV3` / `rankChunksInSql` are a working top-k ranker (`EMBEDDING_TOP_K = 15`, `CHUNK_TOP_K = 30`) called **only from the query path** — `sdk/core.ts:124`, `mcp/wiki-read-tools.ts:141`, `dimensions/wiki/reader.ts:132`. **Compilation never calls it.**

And a measured recall gap says why it matters: on real corpora, **10 of 11** (85 concept nodes) and **60 of 61** (398 nodes) of the pairs at cosine **≥0.86** are never merged by the lexical tiers.

**But the same floor is provably unsafe as a merge threshold**: `…confirmación-de-aprovisionamiento` / `…-desaprovisionamiento` sit at **0.9245** and are sibling requirements that must stay apart. So the recall gap justifies the work, and **precision at any threshold is the missing number.**

## The deliverable — a report, not a change

**One new command** (a script under `scripts/`, or the project's established pattern for an analysis command — read how existing `scripts/` entries are written and follow it) that:

1. **Reuses the existing embeddings.** Do not compute embeddings: no provider, no `embed()` call. Read what is stored. If a corpus has none, say so for that corpus and skip it.
2. For each **paragraph (chunk)** in a corpus, retrieves **top-k concepts** by stored vector similarity, using the **same ranking primitives the query path uses** — call them, do not reimplement cosine over a full matrix.
3. **Filters out every pair the lexical channels already produce**: the concept's **title** or a declared alias appearing in the paragraph (word-bounded, using `canonicalConceptKey` from `src/dimensions/wiki/concept-identity.ts`). What remains is the **incremental** discovery — the links nobody could have found by string match.
4. **Stratifies by threshold** — report at **0.86, 0.80, 0.75** separately, so the trade-off is visible rather than assumed.
5. **Emits a reviewable report**: per pair, the corpus, the paragraph id, the concept, the **cosine**, a short paragraph excerpt, and a flag for whether the concept's title/alias appears **anywhere in the document** (not just the paragraph) — because a document-level mention is evidence the relation is real even when the paragraph doesn't name it.
6. **Emits a hand-labellable sample** — for each threshold, a bounded random sample (say 20 pairs) formatted so a human can mark each correct/incorrect. **This is the deliverable that answers the precision question**, so make it easy to fill in.

**Output must be inspectable and diffable**: a markdown or JSON report written to a path the caller names, defaulting to something under a gitignored location. **Do not write into any wiki corpus.**

## Run it and report the numbers

Available real corpora (established by a prior audit, reuse its findings):
- **`/home/urgosxd/Desktop/ofk/mewSdg`** — 139 real wiki pages, 85 concepts, `.llmwiki/embeddings.json`, 10.5 MB, `nomic-embed-text-v1.5`, 768-d, 85 page + 394 chunk vectors. **This one needs no database.**
- A real 28-page stack and a real 398-page stack exist in a local Postgres (`llmwiki-kg-db-1`, db `aks`) with nomic vectors. **Docker is reachable.** Use them **read-only** — `SELECT` only, no writes, no schema change, and say which stack you used.

**Report per threshold**: candidate pairs found, pairs already covered lexically (the excluded set, as a count), incremental pairs, and how many of the sampled pairs a reasonable reader would call correct with your reasoning — **mark clearly which correctness judgements are yours and which would need the owner**.

## Scope and risk control
- **Do not modify `link-anchoring.ts`, `import/run.ts`, `link-repair.ts`, `resolver.ts`, or any compile path.** Those hold two ungated write paths that a later slice will address; touching them here would mix concerns and is out of scope.
- **Do not add JEV.** No vendor, no key, no second integration.
- **Do not change any page body.** If nothing else holds, this property must: `git diff --stat` on any corpus directory is empty.
- Commit the command and its report format. **Do not commit the report output** (gitignore the default path).
- Test-first: write one test per rule the command asserts — the lexical-exclusion filter, the threshold stratification, the deterministic sample selection. **A test that could pass with an empty candidate list is not a test** — assert a known pair survives on a fixture.

## Gates
`npx tsc --noEmit` · `npm run typecheck:tests` · `npm run lint` (ceiling **`558 / 396 / 423`**) · `npm run fallow:ci` — and if the hook prints "compared nothing", say the verdict is vacuous rather than presenting it as proof · the focused tests for what you add.

## Prohibitions
No `--no-verify`, no `HUSKY=0`, no `--amend`, no push, no `.env*` access, no provider call, no schema change, no page modification, no JEV.

## Report
Per-threshold numbers on each corpus you could use · the excluded-by-lexical count · the sampled pairs with an excerpt each · **your precision judgement labelled as a judgement** · which corpora you could not use and why · gate exits literal with the lint triple · full 40-char SHA · `git status --short` · and a `Risk:` line. **If the honest finding is that the incremental pairs are few or mostly wrong, lead with that** — it would mean the skim missed little and this channel is not worth wiring into compile.

**L2 — verified recon facts (Lead, evidence-backed, not requirements).** These constrain the implementation but do not replace S1-S14.

- The only query-path ranker that accepts a **precomputed vector** is `rankChunksInSql(db, stackId, queryVec: readonly number[], k: number, scope: RankScope)` at `packages/wiki/src/utils/embeddings-rank-sql.ts:70`; its SQL orders by `<=>` cosine and contains no embed call. `findRelevantPagesV3`, `findRelevantChunksV3`, `rankChunksViaSource` and `pickSearchRefs` all take a text `question` and call `embedQuery` internally (`embeddings-load.ts:493,572,611`, `search/retrieval.ts:112`), so none may be used here — using them would violate S2.
- Vector literal formatting for the SQL query side: `toVectorLiteral(vector: readonly number[]): string` at `packages/wiki/src/utils/embeddings-database-write.ts:215`.
- File store seam: `readStoredEmbeddings(root)` at `packages/wiki/src/utils/embeddings-storage.ts:46`; entry types `PageEmbeddingV3` / `ChunkEmbeddingV3` at `packages/wiki/src/utils/embeddings-store.ts:101-117`. Every page entry carries `pageId`, `title`, `summary`, `embeddingTextHash`, `vector`, `updatedAt`; every chunk entry carries `pageId`, `title`, `chunkIndex`, `contentHash`, `text`, `vector`, `updatedAt`. **Neither carries an alias field.**
- `canonicalConceptKey(name: string): string` is at `packages/wiki/src/dimensions/wiki/concept-identity.ts:313`. There is no exported word-bounded "does this name appear in this text" helper; the canonicalization is available but the bounded match must be built on top of it.
- A **concept is not a separate entity**: it is a page with `page_directory = 'concepts'` (`page-scan-source.ts:175` `listConcepts`). DB page identity is the pair `(page_directory, slug)`; there is no `pageId` column in Postgres. The file store's `pageId` is the path-like string `<directory>/<slug>`.
- DB `wiki.page_chunk_embeddings` carries the chunk `text` and `title` inline; `wiki.page_embeddings` carries `title` and `summary` (no `text`).
- The worktree began with **no `node_modules`** and a broken bare `pnpm`; T0 installs with `corepack pnpm install --frozen-lockfile`.
- Lint ceiling `558 / 396 / 423` is the (violations, distinct files, rule/file entries) triple derivable from `eslint-baseline.json`; `.husky/pre-commit` runs `fallow:ci` and `tsc --noEmit`, and `.husky/pre-push` runs `build`.

**L3 — open determination carried into T2/T3.** `wiki.concept_aliases` holds 0 rows globally and `embeddings.json` has no alias field, so where a declared alias is actually readable per corpus must be established from evidence at implementation time (`wiki.pages.aliases` in the DB, YAML frontmatter `aliases:` in the markdown corpus). If a corpus exposes no aliases, S4's alias clause degrades to title-only for that corpus and the report must say so explicitly rather than implying alias exclusion happened.

**L4 — Manager scope change, verbatim.** "**Drop `/home/urgosxd/Desktop/ofk/mewSdg` entirely. Do not use it, do not cite it, do not report numbers from it.** The owner has retired that corpus. That leaves **only the two Postgres stacks** in `llmwiki-kg-db-1` (db `aks`): the real **28-page** stack (`7f1b3b36…`) and the real **398-page** Spanish domain stack (`d61bf181…`). Both carry nomic vectors. **Read-only `SELECT`s only — no writes, no schema change, no container creation, no `.env*` read.** Docker is reachable; use the stored credentials the way the project's own test fixtures do, and **do not let a token or password reach your output** — a prior audit leaked one field that way and it had to be flagged for rotation. Also worth knowing before you interpret anything: **the 398-page stack has 43.2% dangling links** (1617 of 2849 resolve). That is a defect in *that corpus*, not in the mechanism you are measuring — your unit is (paragraph, concept) pairs from vectors, which does not depend on existing links being sound. Do not let the dangling rate contaminate the candidate counts; report them as separate populations. **`mewSdg` was the only corpus with declared aliases.** With it gone, your lexical-exclusion filter can only be exercised against **canonical titles** — the DB stacks have **0 alias rows**. So: the filter will behave exactly as the regex resolver does (`findTitleMatches:285` never consults aliases either), which is fine for the measurement; but **the alias half of the exclusion is untested against real aliases**, and you must say so rather than implying both branches were exercised. Test it on a **fixture** with a declared alias, and label that a fixture result. If, without `mewSdg`, you find you cannot exercise a rule the brief asked for, **say which and why** instead of substituting a weaker check silently."

**L5 — ranking-primitive decision (Lead, evidence-backed).** No page-level vector ranker exists. `rankPagesInSql` does **not** exist; the only exported ranker in `packages/wiki/src/utils/embeddings-rank-sql.ts` is `rankChunksInSql(db, stackId, queryVec, k, scope)`, which is genuinely vector-first (no embed call) and returns `RankedChunk { pageDirectory, slug, chunkIndex, cosine, contentHash }` — **no chunk text**, so a transposed query carries only scalars. Decided: for each concept page, call `rankChunksInSql` once with that page's stored vector as the query and `k` equal to the stack's chunk count, then invert the rows to per-paragraph top-k concepts in memory. This uses the query path's own ranker and never reimplements cosine. Completeness must be asserted: the returned row count per concept must equal the stack's chunk count, and if the database cannot return that many rows the run must report the shortfall and its coverage limitation explicitly rather than silently under-reporting. No minimum-similarity floor, no `ef_search` clamp and no store-derived filter sits inside the SELECT, so the 0.75 stratum cannot be silently truncated. `RankScope` requires `excludedNamespaces` and `surface`; both stacks are 100% `page_directory = 'concepts'`, so no `pageScope` filtering is needed.

**L6 — alias coverage is fixture-only (consequence of L4).** Declared aliases exist only in fixtures now. The alias branch of S4 is therefore verified against a fixture test and labelled as fixture evidence; on both real stacks only the title branch runs. This is stated in the report rather than presented as both branches exercised.

**L7 — execution log and commit evidence (Lead).**
- T0: environment installed with `corepack pnpm install --frozen-lockfile`; all five gates green at baseline `2e2242fa0030bccff32cb07c3fa1f5e087e66436`, lint triple exactly `558 / 396 / 423`. `fallow:ci` at that point compared nothing (base == HEAD) and its pass is vacuous.
- T1: feature document, commit `53df1a4cde15ffc82bf75b01a50d263cfdaf8a48`.
- T2: pure core plus 15 tests, commit `57bb1d58386cc544b3f263a9bf3a66510d426002`; RED observed twice with assertion failures (12/14 then 8/15) before GREEN. The declared-alias branch of S4 is fixture-only evidence.
- T3: DB layer, report layer and CLI plus 15 further tests (30 total), same commit `57bb1d58386cc544b3f263a9bf3a66510d426002`; that commit's `fallow:ci` was a real comparison against a distinct base with 0 introduced findings. T2 and T3 share one commit of 2485 authored lines across 8 files, because the core has no consumer until the CLI exists and splitting them would have produced a commit whose own tree fails the dead-code gate. Recorded here as a review-workload risk, not as a small clean slice.
- T4: **blocked, no numbers produced.** Both assigned stacks are refused by the integrity gate: `assertStoreIntegrityInSql` (`packages/wiki/src/utils/embeddings-rank-sql.ts:128`) calls `storeMatchesActiveEmbedding`, and `storeMatchesActiveEmbedding` (`packages/wiki/src/utils/embeddings-store.ts:421-426`) requires `wiki.embedding_store_meta.fingerprint` to equal `resolveEmbeddingFingerprint()`, computed as `sha256(backend \0 model \0 endpoint)` (`embeddings-store.ts:366-384`). Both stacks carry fingerprint `35d683f8535e6df9774d7c3f9346bdf91564e53e7fb15a51adfe761c4093efe8` with model `hf:nomic-ai/nomic-embed-text-v1.5` and dimensions 768. An exhaustive search of roughly 32 million `(backend, model, endpoint)` combinations produced no match, and no table in the database stores the endpoint. The pipeline itself is proved end to end on a different stack (`a4534bcf-b180-4a9d-ba42-f0a17955c251`, 16 concepts, 16 chunks, 240 inverted pairs, coverage complete) — but that stack is not one of the two this assignment names, so it is a pipeline proof, not a measurement.
- S9 and S10 are therefore **unmet**: no per-threshold counts, no sampled pairs, no precision judgement. This is reported rather than substituted, per S15.
