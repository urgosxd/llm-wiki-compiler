# lint-row-awareness — make the linter read the Stack it is linting

## Goal

`lint()` judges a wiki by reading `wiki/*.md` and `sources/*.md` from disk. A
Stack-backed project has neither: its corpus lives in `wiki.pages` and
`wiki.source_documents`. So on a Stack the linter reads an empty tree and
answers "nothing is wrong" — not because the wiki is clean, but because it saw
nothing.

Measured (this repository, root with no `wiki/`, one source present):

| Corpus read | Result |
| --- | --- |
| Disk (none exists) | `{errors: 0, warnings: 0}` |
| Same corpus materialized on disk (2 pages) | `{errors: 1, warnings: 4}` |

The numbers are not the point; the direction is. Zero pages read produces zero
findings by construction, which makes a clean lint on a Stack meaningless.

Reported by `orchestrator-a` as `wiki-lint-disk-blind`, measured on a live stack
(`b8b8e801`, 80 pages, 10 tracked sources): 0 findings disk-blind, 196 errors /
79 warnings with the corpus visible. This document does not reproduce those exact
counts — no access to that Stack — and says so rather than restating them as
verified.

## Non-goals

- No new lint rule, and no change to what any rule considers a defect.
- No change to the rule ORDER. `lint` flattens the registry groups in the order
  the registries produce them, and the frozen parity suites pin that order.
- No change to the file-backed path. A project with no Stack must produce the
  same bytes it produces today.
- Not the `wiki-on-postgres.md` known defects (see "Adjacent findings").

## The three independent defects

`orchestrator-a`'s report bundles them. They have different causes, different
severity, and different fixes, so they are separated here.

### D1 — freshness is computed without the Stack's documents

`buildFreshnessSnapshot` takes the Stack's documents as an OPTIONAL third
argument, so a caller that omits it silently falls back to hashing `sources/`.
Five call sites exist and only two passed it.

`orchestrator-a` measured the consequence on a healthy stack (`d61bf181`, where
lint reports 0 stale and 0 orphaned): `export_okf` produced 154 pages out of 387,
because `export/collect.ts` filters `freshnessStatus !== "orphaned"` and the
omitted basis classified the other 233 as orphaned.

| Call site | Passed the corpus? |
| --- | --- |
| `status/collect.ts:232` | yes |
| `linter/index.ts` (Stage 0) | yes, after the fix |
| `export/collect.ts:216` | **no** — silently dropped pages |
| `viewer/snapshot.ts:75` | **no** |
| `compiler/refresh-plan.ts:153` | **no** |

**Fixed by making the argument unnecessary, not by making callers careful.**
`buildProjectFreshnessSnapshot` resolves the corpus itself, so the backend is a
property of the project rather than of the caller's memory. All five sites now
go through it, and there is no argument left to forget.

Consequence: `buildFreshnessSnapshot` falls back to hashing `sources/`, finds
nothing, and classifies every owned page `orphaned`. On the reporting Stack that
was 49 of 80 pages — exactly the owned count. `checkStalePages` then emits
`orphaned-page` warnings for a healthy wiki.

This is a **false claim about data**, visible in `status` and `lint` today, and
it is the cheapest of the three.

### D2 — the page corpus is read from disk only

Unchanged by Stage 0.

Every rule reads pages through `collectAllPages(root)` (`src/linter/rules-shared.ts:88`),
which walks `wiki/concepts` and `wiki/queries`. Nine modules outside the linter
also import it.

Consequence: on a Stack every page-scoped rule has no input. This is the defect
that makes the whole lint vacuous.

### D3 — source content is read from disk only

`checkBrokenCitations` resolves `path.join(sourcesDir, filename)` and tests
`existsSync`. A Stack's citation targets are source IDENTITIES (capability URLs),
so the join produces a path that cannot exist, and **every** citation becomes
`broken-citation`. `checkPageBrokenCitations` additionally reads each source
file to count lines for claim-level span bounds.

Consequence: line-count and existence both fail. This is why the visible-corpus
number is dominated by errors rather than warnings.

## Design

### A resolution context, not a parameter on every rule

Changing `checkX(root)` to `checkX(root, ctx)` would touch ~10 exported rule
signatures imported by 20 files, including `eval/health.ts` (8 of them) and
`linter/fix-plan.ts`. That is a wide, mechanical, review-hostile change, and the
parity suites exist precisely to catch a mechanical change that altered
behaviour.

Instead the resolved corpus travels in an **AsyncLocalStorage scope**, the same
mechanism `src/utils/output.ts` already uses for quiet/verbose mode: nested
scopes do not leak into each other, and a concurrent `lint()` and `query` cannot
corrupt one another.

Two exported helpers:

- `readLintPages(root)` — the new page reader that rules call instead of
  `collectAllPages`. Inside a scope it serves the row corpus; outside one it
  delegates to the on-disk walk, unchanged. Rules keep `(root) => Promise<LintResult[]>`.
- `withLintCorpus(env, fn)` — resolves the page source, the source documents and
  the journal once, and runs `fn` inside the scope.

`lint`, `lintByTier` and `lintBothViews` open the scope. Their signatures do not
change, so `eval/health.ts` and the MCP `lint_wiki` tool keep working untouched.

### One seam per fact, reused not invented

| Need | Existing seam |
| --- | --- |
| Pages | `withRawPageSource` (`page-source-seam.ts:178`) → `RawWikiPage` |
| Source existence + content | `withSourceDocuments` (`page-source-seam.ts:117`) |
| Journal | `withJournalSource` (`activity-log-source.ts`) |

`RawWikiPage` already carries `slug`, `pageDirectory`, `filePath`, `title`,
`frontmatter`, `body` and `parseStatus`, and the row implementation synthesizes a
diagnostic `filePath` — so `LintResult.file` survives on rows and the existing
diagnostics keep their shape.

**Retracted correction, recorded because it was wrong.** This document first
claimed `journal-health` did have a row backend and that Stage 3 was therefore
cheap threading. That was wrong, and the mistake was conflating two different
things that share the word "journal":

| | `.llmwiki/journal/` | `wiki.activity_log` |
| --- | --- | --- |
| What it holds | revert batches and pre-state bytes | operation / description / details entries |
| Read by | `classifyJournalDir`, `journalHealth` | `activity-log-store` |
| Seam | none | `withJournalSource` |

`journalHealth` needs `pending-revertable` / `unsafe` / `ok` over REVERT
batches. `withJournalSource` offers appending and reading ACTIVITY entries.
Different data, different question.

There is also nothing to back: a row is already inside a transaction and needs no
pre-state snapshot, so a revert journal has no meaning on a Stack. On such a
corpus the rule is not lying by reading disk — it is vacuous because no journal
can exist. Stage 3 is therefore a **product decision** (does this rule apply at
all to a row corpus?), not a threading task.

### Rules that need more than a page

- `checkBrokenCitations`, `checkMalformedClaimCitations`: need source existence
  and content. Resolved from the scope; on a Stack the map is keyed by source
  identity, and line counts come from `content`.
- `checkStalePages`: needs the freshness snapshot, which must be built WITH
  `stackDocuments` (D1).
- `checkJournalHealth`: needs the journal entries from the scope when present.

### Rules that need no change

`checkOrphanedPages`, `checkMissingSummaries`, `checkDuplicateConcepts`,
`checkEmptyPages`, `checkLowConfidencePages`, `checkContradictedPages`,
`checkInferredWithoutCitations`, `checkSchemaCrossLinks`,
`checkPendingEmbeddings` — all read pages only. They become row-aware for free
once they call `readLintPages`.

## Stages

Each stage is independently shippable, independently verifiable, and leaves the
frozen parity suites green.

- [x] **Stage 0 — D1, completed as `buildProjectFreshnessSnapshot`.** A first pass
  fixed only the linter call site (`f241a35`). `orchestrator-a` then found the same
  omission at three more sites, one of which is a data-loss path in export, so the
  fix moved from "pass the argument here" to "no call site passes it at all".
  Covered by `test/export-freshness-stack-documents.test.ts`.
- [x] **Stage 1 — the page scope (D2), `8e48899`.** `linter/corpus.ts` provides
  `withLintCorpus` / `activeLintCorpus` / `corpusFromRawPages`; `readLintPages`
  serves the scope when active and delegates to `collectAllPages` otherwise, so
  every rule keeps its signature and the 20 files importing `linter/rules` are
  untouched. The scope opens in `collectTieredGroups`, which is the single path all
  three entry points take.

  Row pages arrive with frontmatter ALREADY stripped (`toPage` stores only the
  body), so `buildFrontmatter` rebuilds the block before a rule parses it. Serving
  the bare body would have made every metadata rule a silent no-op.
- [x] **Stage 2 — sources (D3), `7a48d2d`.** The corpus carries document text keyed
  by FILENAME, because a page cites `^[abc123.md]` while a row is keyed by source
  IDENTITY — `filename` is the column that joins them, and it is what lands in
  `sources/` on the file path, so both backends resolve to the same document.
  `SourceDocumentListing` gained an optional `content`; the row already carried it,
  so this is no extra query.

  Three states are kept distinct: the corpus knows the text, knows the document
  does not exist (`null` — that IS the finding), or cannot answer (`undefined`, a
  file-backed project). Collapsing the last two would report every citation broken
  the moment no Stack was configured.
- [ ] **Stage 3 — journal. A DECISION, not threading.** See the corrected
  analysis above: `.llmwiki/journal/` (revert batches, pre-state) and
  `wiki.activity_log` (activity entries) are different things, and a row is
  already inside a transaction so it needs no pre-state. The question is whether
  `journal-health` has any meaning for a row corpus at all. Not implemented,
  because inventing an answer would be guesswork.
- [x] **Stage 4 — the parity proof, `458b197`.** One corpus, described once and
  rendered twice: markdown on disk, and rows as the source returns them. Findings
  compared as an exact sorted set of `rule|file|severity|message`. A second test
  asserts the shared corpus really produces findings, because a vacuous comparison
  would pass the first one while proving nothing.

## Delivered, and what is deliberately not

| Commit | What |
| --- | --- |
| `f241a35` | freshness at the linter call site (subsumed by `3cb4924`) |
| `3cb4924` | `buildProjectFreshnessSnapshot` — all five consumers |
| `afb6d3c` | honour a corpus the caller supplies |
| `0162da5` | the ingest-triggered compile's own environment |
| `8e48899` | Stage 1 — the row corpus |
| `7a48d2d` | Stage 2 — citations from rows |
| `458b197` | Stage 4 — parity proof |

**Not delivered, on purpose:** Stage 3 (a product decision) and the provenance
columns (a schema feature). Both are named above with the reason, so neither
looks like an oversight.

Every new test in this feature was proved non-vacuous by neutralising the code
path it covers and watching it fail. A test that passes for the wrong reason is
worse than no test, because it certifies the bug.

## BLOCKER found while implementing Stage 1: rows cannot carry provenance

Acceptance criterion 3 as first written — *the same corpus from rows and from
disk yields identical findings* — is **not achievable**, and the reason is not in
the linter. It is in the write path.

`wiki.pages` has these columns, and only these:

```
stack_id, page_directory, slug, title, source_identity, summary, tags,
links, body, orphaned, archived, created_at, updated_at
```

There is no `confidence`, `contradicted_by`, `provenance_state` or
`prompt_modifiers` column anywhere in `wiki.*`. `upsertStoredPage`
(`page-store.ts:348`) writes a fixed column list that omits them, so the
information is dropped **at write time**, not lost by the reader.

(`body` stores the page body only — `toPage` calls `parseFrontmatter` and passes
the STRIPPED body, so frontmatter is not smuggled in there either. And the rows
path is not allowed to fall back to opening the synthesized `filePath`: it points
at a file that does not exist, and opening it would be the disk read this whole
feature removes.)

Consequence for the four rules that read provenance:

| Rule | Frontmatter field | Exists in a row? |
| --- | --- | --- |
| `checkLowConfidencePages` | `confidence` | no |
| `checkContradictedPages` | `contradictedBy` | no |
| `computeFreshness` (`contradicted`) | `contradictedBy` | no |
| `checkBrokenCitations` | `provenanceState: imported` | no |

On a row corpus those rules are **silently vacuous**, and
`checkBrokenCitations` loses its import exemption — so an imported page would be
reported for citations it is explicitly exempt from.

This is a bigger finding than the one this feature set out to fix: a page
compiled into a Stack cannot know its own confidence or contradictions. Lint is
the messenger, not the defect.

### What this forces

Stage 1 can close D2 (pages are read from rows) but **only with an explicit,
recorded divergence**: on a row corpus, the provenance rules report nothing, and
the divergence is documented and tested rather than papered over. Criterion 3
becomes "identical findings for the rules a row can express", with the excluded
set named and pinned by a test.

Closing the gap for real needs a schema decision — either columns on
`wiki.pages`, or a provenance side table — which is **a separate feature** and
not something this document may assume.

## Acceptance criteria

1. With no Stack configured, `lint` produces byte-identical output to today for
   every existing test in the parity suites.
2. With a Stack configured and no `wiki/` on disk, `lint` reads the row corpus.
3. For every rule whose inputs a row can express, the same corpus linted from
   rows and from disk yields identical `LintResult[]` — same rules, same files,
   same messages, same order. The set of rules that cannot be satisfied from rows
   is named in one place and pinned by a test, so a rule silently joining or
   leaving that set fails.
4. `npx tsc --noEmit` clean; `npm run test:affected` keeps 715/715 files and
   5239 tests green.
5. `fallow` reports no new dead code, duplication or complexity breach.

## Adjacent findings from the report, verified separately

- `lock.ts:206` — `lockKeyFor` returns `stackIdOf(env) ?? realpath(root)`, so
  `wiki-on-postgres.md` known defect **#1 (lock keyed on path) is FIXED**. The
  document is stale at line 598. Defect **#2 is still real**.
- `wiki-parity-audit.md` §2/§3/§3d were reported stale (candidates, profile, log,
  index/MOC now wired). **Not verified by this session** — reading those sections
  to confirm is separate work, and this document does not assert it.

## Risks

- **The scope is invisible.** A rule that forgets to use `readLintPages` silently
  reads disk and reports nothing on a Stack — the same failure class being fixed.
  Mitigation: Stage 4's parity test lints through rows with NO disk tree, so a
  forgotten rule shows up as a missing finding rather than as silence.
- **Parity suites are frozen on purpose.** They pin the order and content of
  findings. Any stage that changes them has changed behaviour, not just plumbing.
- **`collectAllPages` has nine external callers** (`sources/removal.ts`,
  `eval/citation-*.ts`, `eval/stats.ts`, and others). Stage 1 must not change
  `collectAllPages` itself — it adds `readLintPages` beside it.
