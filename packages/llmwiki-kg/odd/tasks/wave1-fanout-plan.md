# Wave 1 fan-out plan — measured, not estimated

Produced at the close of Wave 0 by analysing the real Python import graph
(`from app.core.X import` / `from app.routers.X import` across all 28 files).

## Slice surfaces are disjoint

Every slice owns a disjoint set of files, so **there are zero merge conflicts**
on file ownership:

| Slice | Files | LOC |
|---|---|---|
| documents | routers/documents, core/files, core/aks_serializers | 424 |
| extraction | core/extraction, core/llm_clients | 516 |
| consolidation | routers/backfeed, core/consolidation | 703 |
| pages | routers/pages, core/page_generator, routers/synthesize | 679 |
| retrieval | routers/aks, core/retrieval | 690 |
| ingest | routers/ingest | 218 |
| mcp | mcp_server | 472 |
| **total** | | **3,702** |

## But slices are NOT dependency-independent

Disjoint files is necessary, not sufficient. The import graph shows real
edges between slices:

```
consolidation -> extraction
ingest        -> consolidation, extraction
pages         -> extraction
retrieval     -> documents, extraction
```

`extraction` is the bottleneck: 4 of 7 slices depend on it.

## Topological waves

Naively launching all 7 in parallel produces broken imports. The graph
resolves into three waves:

- **Wave 1 (3 parallel):** documents, extraction, mcp
- **Wave 2 (3 parallel):** consolidation, pages, retrieval
- **Wave 3 (1):** ingest

## Implication for worktree parallelism

Worktrees solve file-level conflicts. They do **not** solve dependency order.
The honest parallel ceiling here is 3 concurrent writers, not 7, and only
after each wave's branches are merged and the shared interfaces are stable.

Since TypeScript rewrites mean every slice re-implements rather than
transliterates, a further constraint applies: the service interfaces that
cross slice boundaries (the extraction contract in particular) must be fixed
before Wave 2 starts, or Wave 2 writers will invent incompatible signatures.

## Review workload

3,702 LOC of Python is roughly 4,500–5,000 LOC of TypeScript, or 11–12x the
400-line review budget. The slice split exists to make each piece reviewable
independently; parallelism is a secondary benefit.
