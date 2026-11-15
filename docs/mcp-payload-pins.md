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
