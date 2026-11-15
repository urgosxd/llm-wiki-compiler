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

## An exact whole-object pin on a payload that is meant to grow costs every file that pins it

`test/mcp/retired-parity-payloads.test.ts` and the `readPageRecord` case in
`test/mcp-server.test.ts` assert payloads with `toEqual` on the WHOLE object. That is
the point: a whole-object assertion is the only kind that notices a REMOVED or RENAMED
key, so it is what freezes a wire shape.

The cost is that an additive change is not a one-file edit and not even reliably a
two-file edit: it is the producer plus EVERY exact pin that covers that shape. Adding
`links` to `read_page` touched three files — the producer (`pages/read.ts` and the
tool's serializer) and two frozen values, `retired-parity-payloads.test.ts` and
`mcp-server.test.ts`, and each additional pin on the same shape adds one more. Pay it.
Add the new key with its REAL expected value in every one of them and keep each
assertion exact.

Do not relax the pin to `toMatchObject`, `objectContaining`, `expect.anything()` or
`expect.any(Array)`. A relaxed pin stops protecting the shape it was written for the
first time someone adds a key, and it does so silently: the diff looks like a passing
test. An updated exact pin is a record of an intentional change; a relaxed one is a
record of a change nobody noticed.
