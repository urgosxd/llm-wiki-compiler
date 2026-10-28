# `read_page` reads the filesystem while `search_pages` reads the registry

**Status:** open — reproduced on a live host, not yet fixed.
**Found:** 2026-10-28, by the integrating agent, which noticed the tool was not worth
granting because it could not succeed.

## Symptom

Every slug `search_pages` returns is rejected by `read_page`:

```
search_pages {question: "graph"}  -> refs: knowledge-graphs, grafos-…, entity-relationship-modeling, …
read_page    {slug: "knowledge-graphs"}
  -> isError: "Page not found: knowledge-graphs"
```

Reproduced three ways by the reporter — the plain slug, a non-ASCII slug, and with an
explicit `stackId: b8b8e801-…` — so it is not a tenant-binding problem. `search_pages`
and `query_wiki` both answer correctly against the same corpus.

## Cause

A lookup-path mismatch between the two tools, which is visible in the imports:

- `search_pages` (`src/mcp/tools.ts:138`) wraps its work in
  `withRegistrySource(process.env, …)` and resolves refs through `pickSearchRefs` /
  `loadSelectedRefs` — i.e. it reads the **registry**, which is the database-backed
  wiki dimension.
- `read_page` (`src/mcp/tools.ts:162`) calls `readPageRecord(root, slug)` directly.
  `readPageRecord` (`src/pages/read.ts:36-51`) iterates `PAGE_DIRS` and does
  `safeReadFile(path.join(root, dir, `${slug}.md`))` — i.e. it reads the
  **filesystem**.

In a deployment where the wiki lives in the database and no compiled `.md` tree exists
on disk, the two disagree by construction: search finds rows, read looks for files and
finds nothing.

Measured on the live host at the time of filing:

- `ls concepts queries` at the host's project root → neither directory exists
- `select slug from wiki.pages where stack_id='b8b8e801-…'` → rows present, including
  `architecture`, `alpha-content-placeholder-section`, and others

So the content is there. Only the reader is looking in the wrong place.

## Why this is worse than a missing tool

As the reporter put it: granting a tool that cannot succeed teaches the model that its
own capabilities are unreliable — worse than not having the tool at all. A model that
learns to distrust a working capability will hedge on the ones that do work. That is
the reason this was filed rather than worked around, and it is a product-level
consequence, not a cosmetic one.

## Fix direction

The pattern already exists in the same file: `read_page` should resolve through
`withRegistrySource` the way `search_pages` does, falling back to the filesystem only
when there is no registry to read. It must not simply swap one for the other — a
filesystem-only project (no database) is a supported deployment, and `read_page` works
there today.

## Not fixed here

Left open deliberately: the fix needs the same care as `get_context_pack` around which
source wins when both are present, and that is a decision about the reader's contract
rather than a one-line change.
