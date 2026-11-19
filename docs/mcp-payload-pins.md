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
behind `Page.links`. The row store selects `wiki.pages.links` (`text[]`), which holds a
normalized wikilink target — a bare slug, or a qualified `<namespace>/<slug>` id when
the body named one that way. That is the column's settled shape and it is
AUTHORITATIVE: the value is a page reference, not a page name, and a bare slug cannot
be one because `primary key (stack_id, page_directory, slug)`
(`packages/wiki/src/dimensions/wiki/schema.sql:106`) lets `concepts/x` and `queries/x`
coexist. `Page.links` is built from the body, so exposing labelled refs costs no extra
query, and the export writers resolve every target against the `(page_directory, slug)`
pair (`packages/wiki/src/export/link-targets.ts`) instead of against a set of slugs. The
wire `links[].slug` of `read_page` is projected to the bare slug, because that tool
takes a slug rather than a page id — the one projection that DISCARDS the namespace, so
under a collision it names whichever page `read_page` finds first
(`odd/tasks/query-wiki-citation-targets.md`, `L10`).

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

In practice `search_pages` now ranks from the embedding store in both configurations — the on-disk
store and a Stack's row store — so the refs it scored carry `score`, and `kind:"index"` refs carry
none. Reaching the row store introduced one
failure mode; the section below records it. The asymmetry above is about the two `query` producers,
not about what the tool reaches.

## Former defect, fixed: `search_pages` used to rank without embeddings

`pickSearchRefs` used to be called with `registrySource` only, at
`packages/wiki/src/mcp/wiki-read-tools.ts` and `packages/wiki/src/sdk/core.ts`, so it never received
`embeddingStoreSource` and always ranked from the on-disk store, falling to the index path when that
store was empty. On a Stack-backed corpus every ref was therefore `kind:"index"` and every `score`
absent, whatever the database held, while `query_wiki` passed both sources.

The signature of that defect, kept because it is what an operator actually saw: a Stack-backed corpus
could hold a fully populated embedding store — measured on one: 21 page embeddings and 114 chunk
embeddings, paid for with 40 provider requests — and `search_pages` still answered `kind:"index"`
with `warnings: [{"code":"embedding-index-outdated"}]`, because ranking fell to the on-disk store,
which does not exist for a Stack-backed corpus. The embed rung was never reached, not missing.

Both call sites now pass `embeddingStoreSource`, so `search_pages` ranks from the Stack's row store
and the refs that path scores carry `score`, while `kind:"index"` refs carry none. That is the
current behaviour; the paragraph above is history.

### The failure mode reaching the row store introduced

Handing `pickSearchRefs` an `embeddingStoreSource` makes the Stack's row store reachable, and the
store load refuses a store built in a different embedding space before any ranking runs. The refusal
is `refuseSpaceMismatch` in `packages/wiki/src/utils/embeddings-load.ts`, which throws
`EmbeddingSpaceMismatchError` from both entry points the tool can take: the header-only load for a
source that can rank without a store, and the materializing load otherwise. Both are reached from the
store load inside `pickSearchRefs`, in `packages/wiki/src/search/retrieval.ts`, which runs BEFORE
`selectViaEmbeddings` is entered — so for a store whose header already disagrees, the load refuses
first, and the rethrows inside `selectViaEmbeddings` are not the deciding site.

The symptom from outside is not a degraded answer. A Stack whose stored vectors were built by another
embedding configuration makes `search_pages` FAIL: the MCP client receives `isError: true` whose text
begins `Embedding space mismatch:` and names the stored model and dimensions against the active
embedding configuration. The tool handler has no `catch`, so the message is all the client sees — no
class name, and no `kind:"index"` refs to fall back on.

This is intended, and it is not a defect in either change. Refusing beats answering confidently
wrong: a partial answer computed across two incomparable vector spaces is noise wearing the shape of
a result. The refusal is also not new in kind — it already fires for a file-backed wiki whose store
was built in another space. What is new is that a Stack-backed corpus reaches it at all: before, that
corpus never loaded a store, so it degraded to index refs and never had a space to disagree about.

An operator who meets `Embedding space mismatch:` from `search_pages` on a Stack should rebuild the
index with the `compile_wiki` tool, or restore the embedding configuration the store was built with.
Both are named in the error's own remedy text.

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
  from a measurement taken on `main`. The `pickSearchRefs` call in `registerSearchTool`
  sits at a different line on every tree — the `search_pages` description it follows has
  changed length more than once — so no numeric offset for it is quoted here; the
  `readPageBySlug` projection the relayed ranges were
  meant to identify **is not cited in this document at all** — cite it by symbol instead,
  as the return projection of `readPageBySlug` in
  `packages/wiki/src/mcp/wiki-read-tools.ts`.
  Re-deriving every citation against this branch found the numeric offsets this bullet used to
  quote were wrong on the tree that shipped them, so they are gone rather than corrected.
  The same re-derivation did find two other defects in the
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
