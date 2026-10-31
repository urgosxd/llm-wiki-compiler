# Audit: which wiki-dimension MCP tools read the database, and which still read disk

**Status:** findings — read-only audit, nothing changed.
**Date:** 2026-10-28.
**Why:** two tools had already been caught reading the wrong source (`read_page`,
`search_pages` was fine; URL typing was a separate defect). The question raised was
whether the rest of the surface has the same problem, and specifically whether the tests
gave false confidence.

## The method, because a test-passing audit would repeat the original mistake

Reading the handlers was not enough: `query_wiki` and `read_page` both "look fine" until
you notice one wraps itself in a seam and the other does not. So every tool was also
**called against a live host whose wiki exists only in the database**:

- `wiki.pages` holds **73 rows** for stack `b8b8e801-…`
- the host's project root has **no `concepts/` and no `queries/` directory at all**
  (verified: `ls` finds neither)

Any tool that returns content is reading the database. Any tool that returns nothing —
or, worse, a healthy-looking empty result — is reading disk.

## The result

| tool | source | live result against a DB-only wiki |
| --- | --- | --- |
| `query_wiki` | `withRegistrySource` (tools.ts:113) | **works** |
| `search_pages` | `withRegistrySource` (tools.ts:138) | **works** — returns real slugs |
| `wiki_status` | `withPageScan` (tools.ts:205) | **works** — reports 73 pages |
| `export_okf` | `withRawPageSource` (export/okf/run.ts:15) | **works** — 24 concepts written |
| `ingest_source` | writes sources by design | **works** — sources are the filesystem case |
| `read_page` | `readPageRecord(root, slug)` (tools.ts:162) | **BROKEN** — "Page not found: architecture", and `architecture` exists in the DB |
| `lint_wiki` | `lint(root)` (tools.ts:182), no seam | **SILENTLY EMPTY** — `{errors: 0, warnings: 0, results: []}` on a 73-page wiki |
| `get_context_pack` | `buildViewerSnapshot` → `withRawPageSource` (snapshot.ts:68) | **PARTLY WORKS** — `project.pages: 73` read from the registry, `primary: 5`, `neighbors: 10`; but `chunks: []` because the embedding seam is not wired |
| `run_eval` | `runAllLintRules(root)` (eval/health.ts:88) | **MISLEADING** — `health.score: 100` on a wiki it cannot see |
| `compile_wiki` | compile pipeline | not exercised here; see below |
| `verify_artifact` | artifact store by ref | not page-derived |

## The three failure shapes, and why two are worse than the first

1. **`read_page` fails loudly.** It says "Page not found". Annoying, but honest — the
   caller knows the tool declined.
2. **`lint_wiki` fails silently.** It returns a well-formed success containing
   nothing. A client cannot distinguish "no findings" from "I looked at an empty
   directory", and the second is a lie dressed as a clean bill of health.

> **Correction, measured after the first draft of this table.** `get_context_pack`
> was recorded here as "silently empty — `pages: 0, chunks: 0`". That was wrong, and
> the error was mine: I read the top-level JSON for `pages` and `chunks`, keys the v1
> envelope does not have. The real keys are `primary` and `neighbors`. Against the
> DB-only Stack the tool returns 73 pages, 5 primary and 10 neighbors, all from the
> registry — because `buildViewerSnapshot` has used `withRawPageSource` all along
> (`src/viewer/snapshot.ts:68`). The audit table inherited a shape mistake and then
> repeated it as a finding.
>
> What IS broken there is narrower and was hidden by the same mistake: `chunks` is
> genuinely empty, and the warning is `embedding-index-outdated` — "No embedding index
> found" — while the Stack holds **73 rows in `wiki.page_embeddings` and 217 in
> `wiki.page_chunk_embeddings`**. `retrieveSemanticChunks` accepts an
> `EmbeddingStoreSource` (`src/context/retrieval.ts:82`) and `withEmbeddingStoreSource`
> exists to supply it (`page-source-seam.ts:220`), but `buildContextPack` never asks for
> one: its options type has no such field and `build.ts:113` calls the retriever with
> three arguments. So the pack answers with lexical ranking only, on a corpus whose
> vectors are fully present. The failure is silent in the worst way — the pack looks
> complete, and its `chunks: []` is indistinguishable from "nothing was relevant".
3. **`run_eval` fails misleadingly.** `health.score: 100` is the most confident wrong
   answer in the surface: it reports a perfect score for a wiki it never opened.

The reported `read_page` bug was the *least* dangerous of the three, because at least it
admitted failure. That is the finding worth acting on.

`get_context_pack` now belongs in shape 2 rather than shape 3, and for a specific reason
worth naming: it does look in the right place for PAGES, so a caller who checks
`primary` sees a plausible pack and has no reason to look further. The missing
half is `chunks`. That is a quieter wrongness than `run_eval`'s perfect score — the pack
is real, only narrower than it claims — and it is the reason the `chunks: []` row is
followed all the way down to the row counts instead of being read as "no matches".

## Why the tests did not catch any of this

Every tool above has passing tests. They pass because a fixture project is written to
disk and the tool reads it from disk — the source and the fixture agree, so the seam is
never exercised. The tests prove the *rule* is right, not that the *source* is.

This is the same defect class recorded earlier as "the fixture did not contain the
condition": the fixture contained pages, so nothing could expose a tool that reads the
wrong place. A test that would have caught it needs a wiki that exists **only** in the
database, with no on-disk tree — which is exactly the deployment this host is running.

## The seams already exist, which makes the fix smaller than it looks

`src/dimensions/wiki/page-source-seam.ts` already provides the mechanism; the tools
simply are not all using it:

- `withPageSource` (:56) — pages as records
- `withPageScan` (:82) — page scan, `undefined` means "read `wiki/` from disk"
- `withRawPageSource` (:141) — raw pages, `undefined` means the on-disk scan
- `withRegistrySource` (:192) — the registry the search/answer paths ask
- `withEmbeddingStoreSource` (:220) — falls through to a disk enumeration with no source

So the pattern is established and three tools demonstrate it working. The gap is not
missing infrastructure; it is three call sites that never adopted it.

## Open question the audit cannot settle

`lint_wiki` and `run_eval` take only `root`. Making them page-source
aware is not a drop-in: `lint` walks categories and rules that may legitimately depend on
files that are *not* pages (schema, freshness snapshots), and `run_eval` aggregates those
same rules. Deciding which of their inputs become seam-aware is a contract question about
what "lint this wiki" means when the wiki is a database row set rather than a directory.

That is why this is recorded as an audit rather than fixed: `read_page` has an obvious
repair (adopt the seam the other readers already use), but the other three need a
decision about their inputs first, and quietly handing them a page source would silently
change what their existing tests assert.

## Not changed

Nothing. This document records what was measured; no code was modified for it.
