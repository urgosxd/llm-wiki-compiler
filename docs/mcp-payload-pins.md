# MCP payload shapes: optional fields, link sources, and pins

Maintainer reference. Repo-facing (plain `.md`, not published on the Mintlify site),
like `fallow-gates.md`: it records decisions the code cannot state where a reader would
look for them.

Adding a key to an MCP payload is a contract change, and each of the notes below exists
because a future reader would otherwise "fix" something that is deliberate.

## An optional field means "unknown", never zero

`SelectedPageRef.score` is OPTIONAL, and `search_pages` OMITS the key on
`kind: "index"` refs. That is the whole contract, not an oversight, and it must not be
"tidied" into a default.

The index fallback selects pages with an LLM over the wiki index. It computes no
similarity for anything, so at that construction site there is no score to report. A
fabricated `0` would be a CLAIM — "this page has zero similarity to the query" — about a
ref whose similarity was never computed. An agent that thresholds on scores would then
rank a page it has no measurement for as the worst possible match, and act on a number
the retrieval never used.

`NULL`/absent means unknown. `""` or `0` is a claim. The distinction is the entire
reason the key is omitted, so:

- do not write `score: hit.score ?? 0` — that converts "not measured" into a measured
  zero, and it typechecks, which is exactly why it will be proposed;
- do not write `score: 0` on the index branch "for shape stability";
- if a caller needs a uniform shape, the caller decides how to treat an absent score,
  and the tool description says which refs carry one and which do not.

A synthetic zero against index-fallback refs would have been worse than absent: it would have been a
confident wrong number on every result.

## A page's outgoing links are its body wikilinks, not `wiki.curated_links`

When `read_page` reports the links a page carries, the source is the page BODY, parsed
by `extractWikilinkTargets` (`packages/wiki/src/wiki/collect.ts`) — the same extractor
behind `Page.links`. The row store selects `wiki.pages.links` (`text[]`, slugs only),
and `Page.links` is built from the body, so exposing labelled refs costs no extra query.

`wiki.curated_links` is **not** that source and is the wrong one for a per-page
outgoing-link view. It is the curated overlay: rows scoped by `source_page_id` and
`target_page_id`, holding the links a review step added to already-written pages, with
their anchors and provenance. Two consequences follow, and both are reasons not to use
it here:

- its edge set is different — curated-only, so a page's own wikilinks would be missing
  from a view built on it;
- it needs page IDS. `Page` exposes none, so using it would mean plumbing page identity
  into a reader that deliberately works from slugs.

Producing the labelled refs from `extractWikilinkTargets` reuses the extractor instead
of writing a second wikilink regex. A second parser is a second answer to "what counts
as a link", and the two drift.

## The two ref producers disagree about `score`, and that is deliberate

`search_pages` refs carry `score`. The two selection producers behind `query` and
`query_wiki` — `packages/wiki/src/commands/query-selection.ts:193` (page-level) and
`:278` (`collapseToRefs`, chunk-level) — build refs WITHOUT one.

Leaving them alone is a decision, not an omission: `query_wiki` returns an ANSWER, not
a list of refs, so those refs are not on the agent surface an MCP client sees, and
giving them a score nobody consumes would be a field to keep correct for no reader. If
`query_wiki` ever exposes those refs — for instance if `debug: true` starts returning
them — the inconsistency is KNOWN, and the fix is to copy the score those producers
already hold at their construction sites, exactly as `search_pages` does. It is not a
discovery to be re-investigated.

In practice `search_pages` is index-only today — see the known defect below; that section is about
the producers, not about what the tool currently reaches.

## Known defect: `search_pages` ranks without embeddings

`pickSearchRefs` is called with `registrySource` only at
`packages/wiki/src/mcp/wiki-read-tools.ts:150` and `packages/wiki/src/sdk/core.ts:124`, so it
never receives `embeddingStoreSource` and always ranks from the on-disk store, falling to the index
path when that store is empty. On a Stack-backed corpus every ref is therefore `kind:"index"` and
every `score` is absent, whatever the database holds. `query_wiki` passes both sources.

This is a defect, not a configuration. A Stack-backed corpus can hold a fully populated embedding
store — measured on one: 21 page embeddings and 114 chunk embeddings, paid for with 40 provider
requests — and `search_pages` still answers `kind:"index"` with
`warnings: [{"code":"embedding-index-outdated"}]`, because ranking falls to the on-disk store, which
does not exist for a Stack-backed corpus. The embed rung was never reached, not missing.

Tracked as its own fix; this document describes the current behaviour, not the intended one.

## An exact whole-object pin on a payload that is meant to grow costs every file that pins it

`test/mcp/retired-parity-payloads.test.ts` and the `readPageRecord` case in
`test/mcp-server.test.ts` assert payloads with `toEqual` on the WHOLE object. That is
the point: a whole-object assertion is the only kind that notices a REMOVED or RENAMED
key, so it is what freezes a wire shape.

The cost is that an additive change is not a one-file edit and not even reliably a
two-file edit: it is the producer plus EVERY exact pin that covers that shape. Adding
`links` to `read_page` touched four files — the producer (`pages/read.ts` and the
tool's serializer) and two frozen values, `retired-parity-payloads.test.ts` and
`mcp-server.test.ts`, and each additional pin on the same shape adds one more. Pay it.
Add the new key with its REAL expected value in every one of them and keep each
assertion exact.

Do not relax the pin to `toMatchObject`, `objectContaining`, `expect.anything()` or
`expect.any(Array)`. A relaxed pin stops protecting the shape it was written for the
first time someone adds a key, and it does so silently: the diff looks like a passing
test. An updated exact pin is a record of an intentional change; a relaxed one is a
record of a change nobody noticed.

## A relayed `path:line` is not evidence

Every range below arrived in a handoff where the surrounding claim was true. Both looked
right, and both were wrong in the same way: measured somewhere else, quoted here.

- **A range is only valid for the tree it was derived on.** Three citations were relayed
  from a measurement taken on `main`. On this branch the `pickSearchRefs` call is
  `wiki-read-tools.ts:150` because the `search_pages` description grew by eight lines,
  while `main` has it at `:141`; the `readPageBySlug` projection the relayed ranges were
  meant to identify **is not cited in this document at all** — its correct one-line
  citation would be `wiki-read-tools.ts:189-195`, with the `links` key at `:194`.
  Re-deriving every citation against this branch found **four of four already correct
  and none needing repair**. The same re-derivation did find two other defects in the
  surrounding prose: a file count of "three" where the change touched four, and the
  false absolute corrected in the section above.
- **A confidence-shaped absolute is a claim to check, not a sentence to copy.** One
  relayed sentence read "every ref is therefore `kind:"index"` and every `score` is
  absent, whatever the database holds". It was false: when no embedding source is passed
  the ranking always comes from the on-disk store and falls to the index path only when
  that store is empty, so a file-backed wiki holding a local embedding store does return
  `chunk`/`page` refs **with** scores. It was corrected rather than pasted, and the
  corrected version is the one that shipped.

**Rule:** re-derive the range with `sed -n '<start>,<end>p'` against **the tree you are
writing about**, read the output back, and treat a relayed absolute as an assertion to
verify. This holds for a teammate, a subagent, and a manager alike — the origin of a
range says nothing about the tree it applies to. Nine relayed ranges were checked while
producing this document; the ones that mattered were the ones re-derived.
