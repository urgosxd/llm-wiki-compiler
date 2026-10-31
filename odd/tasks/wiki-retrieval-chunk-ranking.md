# Feature: Answer chunk ranking from the store header, not from 16.1MB of vectors

## Goal

`pickSearchRefs` used to materialize every vector in the Stack before it could
rank anything. For the 1696-chunk Stack that means transferring 16.1MB of
`vector::text` and parsing it with `split(",").map(Number)` — 196ms to fetch,
236ms to parse — to answer a question Postgres can answer over an index with
four metadata numbers.

The change moves chunk ranking into SQL, keeps the freshness walk in Node, and
leaves the page level untouched.

## What the change is worth, measured

```
ranking path           271ms -> 16ms        (16.1MB stops crossing the wire per query)
end-to-end latency     no appreciable change (the embedding provider dominates: 736-1398ms)
fallback (hypothetical) ~1037ms             (NOT reachable in the current corpus)
```

**The justification is not latency.** It is that the cosine floor now compares an
EXACT cosine computed in SQL (`1 - (vector <=> $1)`) instead of `1 - dist` from a
possibly approximate index scan, and that four eligibility filters which only
existed in Node now travel into the query.

Anyone reading this later should not repeat the mistake made here: the first
version of this work was justified with "271ms -> 16ms, 16.8x", which describes
our side of the request and not what a user waits for. Both numbers are true;
only one is about the user.

## Decisions taken

| Question | Decision |
| --- | --- |
| Where the ranking runs | SQL, over `wiki.page_chunk_embeddings`, joined to `wiki.pages` |
| Where the freshness check runs | Node, unchanged (`walkFreshChunks`) — see below |
| Threshold | No chunk-count threshold: SQL wins at every N measured, including N=1 |
| Page-level ranking | Unchanged, in memory (419 rows; no measurement justifies moving it) |
| Typed namespaces | Out of scope; the chunk table's foreign key to `wiki.pages` makes them unreachable there |
| Cache of the query embedding | Rejected — there is one embed per request, so it would save ~0ms |

## The four filters, and why they had to travel

Ranking in SQL silently bypasses everything the Node path applied before scoring.
Each of these was found by asking "what does the old path do that the new one
does not", not by reading the new code:

| Filter | Where it lived | What breaks without it |
| --- | --- | --- |
| `pageScope` (caller's narrowing) | `query-selection.ts` `narrowToScope` | Measured 5/5 chunks returned outside a 2-page scope |
| `excludedNamespaces` | `passesSurfaceFlag` (per-namespace, from the profile) | Pages the profile opted out of retrieval appear anyway |
| `orphaned` | `isLegacyScanEligible` | Dead pages ground answers |
| `hasTitle` (`title <> ''`) | `isLegacyScanEligible` | Untitled pages are rankable |

`schema.sql` does NOT constrain `title`, and `title` is `not null default ''`, so
an untitled page is a reachable state — not a hypothetical one.

## Why the freshness walk stays in Node

`stalePageIds` does not mean "dead page". It means **content drift**: the stored
`content_hash` differs from the hash of the page's LIVE body. The join against
`wiki.pages` can see absence, never drift.

Measured on the real corpus: 23 of 28 pages in stack `7f1b3b36` have drifted
content — 82% — while the 1696-chunk stack has none. Skipping the walk because
"the join already filtered dead pages" would return obsolete vectors for 82% of
that stack with no warning.

Two distinct causes, deliberately separated:

- **dead page** -> excluded by the join, never reaches the walk, not reported
- **drifted page** -> passes the join, the walk sees a mismatched hash, reported as stale

## Invariants a future change must not break

1. **The eligibility gate is the prefilter, not the hash read.**
   `liveEntry` deliberately returns hashes for an orphaned page while
   `recordPairs` drops it: they answer different questions ("what are this page's
   hashes, if it exists?" versus "may I show this as evidence?"). Both the row
   backend and the disk backend behave this way. Rejecting orphans inside
   `liveEntry` would make the two backends disagree, which
   `page-registry-source.ts`'s docblock forbids.

2. **The light load is a separately NAMED function, not a store with empty
   arrays.** `loadMetaForSearch` cannot be mistaken for a full store because
   there is no store to mistake. An earlier attempt made
   `loadEmbeddingsForSearch` take the light path internally and silently deleted
   the page-embeddings level of the cascade; four existing tests caught it.

3. **`rankChunks` replaces the scoring, never the walk.**

4. **A slug's grammar is `isValidPagePart`, not `isSlugSafe`.** `isSlugSafe` is
   the NAMESPACE grammar. Applying it to slugs in SQL would drop **369 of 1777
   chunk rows (21%)** — every page whose slug carries Spanish accents. Those rows
   pass the real gate today.

## Deuda documentada, not pending work

`materializeForPages` re-loads the store (342ms) when the chunk level yields no
hits, and the page level then embeds the same question again (694ms). Total
~1037ms.

**This is not reachable today**, verified two ways:

- zero pages in the whole database have a `page_embedding` and no chunks
- `min_similarity` is `NULL` on the big stack, so nothing filters, so the chunk
  level always returns hits

It becomes real the day a corpus has chunk-less pages, or a store's floor filters
everything. Until then, paying down this debt buys nothing measurable.

## Verification

`test/dimensions/wiki-rank-chunks-parity.test.ts` — 9 cases, seeded corpus:

- top-k parity between the SQL path and the in-memory path
- `archived` pages ARE included (pinned: archiving is a freshness signal, not an
  eligibility gate, and the disk path has no such concept) — adding
  `and not archived` fails two cases
- no leak outside `pageScope`; nothing from an excluded namespace
- exact cosine on every hit, not a distance
- a store built by another model degrades with `embedding-index-outdated`
  (deleting the gate fails this case)
- content drift is reported stale, not returned as a hit
- the prefilter, not the hash read, is the eligibility gate

The corpus is SEEDED, not the production one, on purpose: the real corpus has
zero orphaned rows, zero untitled rows and zero archived rows, so a parity test
over it would compare two sets that are both "every row" and pass no matter what
the filters do. That vacuity was found twice today by different people.
