# search_pages ranks from a store that cannot exist on a Stack-backed corpus

Maintainer and operator findings. Repo-facing plain `.md`, not part of the published Mintlify
site (`docs.json` untouched, as for `docs/turborepo.md` and `docs/ingest-dimension-observability.md`).
Measurements come from a live session against a freshly compiled, fully embedded demo corpus.

## The defect

`pickSearchRefs` accepts two backends — `embeddingStoreSource` for ranking and `registrySource`
for bodies (`packages/wiki/src/search/retrieval.ts:79`) — and gates the whole embedding path on
the first one (`:116-118`): omitted, it calls `loadEmbeddingsForSearch(root)` and reads the
**on-disk** store. Two of its three call sites omit it:

| call site | passes |
| --------- | ------ |
| MCP tool `search_pages` (`packages/wiki/src/mcp/wiki-read-tools.ts:135-141`, call at `:141`) | `registrySource` only |
| SDK facade `search` (`packages/wiki/src/sdk/core.ts:123-125`, call at `:124`) | `registrySource` only; the facade's options are `{ limit?, maxPages? }` (`packages/wiki/src/sdk/core-types.ts:188`), so `{ ...opts }` cannot carry a store source |
| MCP tool `query_wiki` (`packages/wiki/src/mcp/wiki-read-tools.ts:97-105`) | both |

With `outcome.store` falsy, ranking skips every embedding rung and lands on `selectFallbackRefs`
(`packages/wiki/src/search/retrieval.ts:134`). For a Stack-backed corpus — pages are rows, not
files — there is no on-disk store to load. The store is not missing; the wiring never asks for
the one that holds the vectors.

## What it looks like from outside

The tool does not error. It returns one warning and index-only refs:
`warnings: [{"code":"embedding-index-outdated","message":"No embedding index found."}]`, plus
three refs all `kind:"index"` — `concepts/desander-basin`, `concepts/sediment-abrasion-in-turbines`,
`concepts/desander-flushing-operation`.

**A reader who sees `embedding-index-outdated` should read it as a wiring fact, not as a damaged
or empty corpus.** That corpus was freshly compiled and fully embedded, and the same three pages
hydrated with 2591 / 3326 / 3305 characters of real body text. The warning describes the store the
call site chose to open, nothing about the data.

## The measured cost

For one compiled source document the ingest wrote **21 pages, 21 page embeddings and 114 chunk
embeddings**, costing **40 of 83 measured provider requests** (the rest were chat calls). Every
one of those vectors is unreachable by the agent's primary search tool — measured, not
estimated: the rows exist, the request accounting exists, the tool ranks as though neither did.

## A premise that was wrong, recorded so it is not repeated

A recon handoff described `packages/wiki/src/commands/query-selection.ts:99-140` as
`search_pages`' embedding-first fallback chain, with page retrieval by embedding at
`EMBEDDING_TOP_K = 15` (`packages/wiki/src/utils/constants.ts:738`) as its first rung.

**The chain exists; `search_pages` never reaches its first rung — nor any rung after it.**

1. `query-selection.ts:99` is `selectRelevantPages`, the **`query`** pipeline: it takes the store
   source explicitly (`:107`), runs chunk-level selection before page-level (`:125-128`), and
   falls back with the registry source (`:138`). Its caller is `generateAnswer`
   (`packages/wiki/src/commands/query.ts:194-199`), which `query_wiki` reaches; `search_pages`
   never calls it.
2. `search_pages` calls `pickSearchRefs` (`packages/wiki/src/search/retrieval.ts:112`). That
   function has its own chunk-then-page cascade (`:126`, page-level at `EMBEDDING_TOP_K` at
   `:193`) — so the ordering was right — but every rung sits behind the `embeddingStoreSource`
   gate, and with the option omitted the cascade is never entered.

The lesson: a correct description of a fallback chain does not establish that a tool is on it —
trace the call site, not the shape of the code.

## Two measured facts worth keeping

**The argument is `question`, not `query`.** The schema declares `question`
(`packages/wiki/src/mcp/wiki-read-tools.ts:130-133`), and its required-argument error reads
`Invalid input: expected string, received undefined at question`. A wrong field name produces
`MCP error -32602: Input validation error…`, which **looks exactly like a broken tool and is not**.
Reading the schema would have cost less than the two probes.

**A non-ASCII slug round-trips intact, end to end.** `central-hidroeléctrica-río-claro` survives
JSON (`é=U+e9`, `í=U+ed`), `read_page`, and the SDK `getPage` byte-identically. Following a
`links` target resolved to a 6783-character page; the negative control `nonexistent-slug-probe`
returned `Page not found` with `isError: true`. Selection is the weak point, not slugs.

## Why `score` and `links` were invisible — delivery, not design

`SelectedPageRef` on `main` (`packages/wiki/src/search/retrieval.ts:55-61`) declares exactly
`pageId, slug, title, kind`. No ref of any kind can carry a score, so an absent score is
structural rather than an incident of one query.

The `score` and `links` fields exist on branch `feat/wiki-search-score-and-links` — commits
`22f48780` (`feat(search): expose cosine similarity score on search_pages refs`) and `182c8a91`
(`feat(mcp): return outgoing wikilinks from read_page`). That branch is **not merged**: neither
commit is contained by anything but itself. `dist/api.js` is built from `main` — the artifact
holds none of the symbols those commits introduce (`chunkHitsToRefs`, `pageHitsToRefs`,
`pageLinkRefs`), and `dist/` is gitignored (`.gitignore:9`), so a running server cannot expose
them. **A delivery fact, not a product decision**: the fields are committed and invisible to the
running binary because nothing is merged.

Separately, and already on `main`: the MCP `read_page` payload is cut to `slug,title,summary,body`
(`packages/wiki/src/mcp/wiki-read-tools.ts:186-189`), while the SDK `getPage` returns the whole
`Page` with `links` (`packages/wiki/src/pages/list.ts:259-271`, built at `:217`).

## What would fix it

Suggestions only; no code and no plan.

- **Pass `embeddingStoreSource` into `pickSearchRefs` at both call sites**, as `query_wiki`
  already does: `withEmbeddingStoreSource(env, …)` around the existing `withRegistrySource`,
  threading it into the options at `wiki-read-tools.ts:141` and `core.ts:124` so ranking and
  hydration share one backend — the invariant `retrieval.ts:79` and `:80-88` were written for.
- **Pin it with a test that asserts the embedding source is used when a Stack is configured**,
  observable from outside: a Stack-backed search must not emit `embedding-index-outdated` and
  must return refs whose `kind` is not `index` for a corpus that has vectors.
- **Make the degrade visible at the call site.** `pickSearchRefs` cannot tell "the caller passed
  nothing" from "there is no store"; an explicit `embeddingStoreSource: undefined` with a
  distinct warning code would have named this defect in one response, not one investigation.
