# Functional parity audit — Postgres wiki vs the filesystem wiki

Question: **does a Stack-backed project have every capability the filesystem project had?**

Method: every artifact constant in `src/utils/constants.ts` was paired with a table
in the live database, and its production references were classified as
*row-backed*, *file-only*, or *unwired*. Nothing here is inferred from DDL; the table
and column lists come from `information_schema` on the running database.

Reproduce:

```bash
docker exec -i llmwiki-kg-db-1 psql -U aks -d aks -tAc \
  "select tablename from pg_tables where schemaname='wiki' order by 1"
grep -rn "<CONSTANT>" src/ --include=*.ts | grep -v constants.ts
```

## Verdict

**No. Parity is not there yet.** Five capabilities that exist on the filesystem have
no row equivalent at all, and two more have storage that production never calls.

## 1. Full parity — row-backed in production

| Artifact | Table | Evidence |
|---|---|---|
| `.llmwiki/state.json` | `wiki.source_compile_state` | compile passes `stateRows` → `draft.flush(root, stateRows)` (`compiler/index.ts:907`) |
| `wiki/graph/events.jsonl` + `.llmwiki/events.head` | `wiki.event_log` | `appendEventToRows` / `readEventsFromRows` |
| `wiki/graph/relations.jsonl` | `wiki.relation_edges` | `appendRelationToRows` / `readRelationsFromRows` |
| `.llmwiki/rule-state.json` | `wiki.rule_extractor_state` | `readRuleStateFromRows` (just migrated, `4586f0b`) |
| pages | `wiki.pages` | `PageContentSource` / `resolvePageSeams` |
| `.llmwiki/lint-cache.json` | `wiki.lint_cache` | store exists; production reader is still file-gated (**see §3**) |
| `.llmwiki/pending-embeddings.json` | `wiki.embedding_refresh_marker` | store exists; production reader still file-gated (**see §3**) |
| frozen slugs / entities / prompt modifiers | `wiki.compile_config` | read AND written by `wiki-state-source.ts`, which is what `wikiStateRowsBackend` returns |

## 2. NO row equivalent — the wiki cannot do these on Postgres

| Artifact | Written by | Consequence |
|---|---|---|
| `.llmwiki/profile.json` | `profile/scaffold.ts:101`, `profile/templates/install.ts:197` | A Stack-backed project still writes its profile as a FILE. Decision 1 answered "per Stack"; that was never implemented. |
| `wiki/index.md` | `compiler/indexgen.ts` via `regenerateIndices` | `regenerateIndices` READS from rows but always WRITES the file. Decision 3 answered "rows"; not implemented. |
| `wiki/MOC.md` | `compiler/obsidian.ts:125` | Same as index — unconditional `atomicWrite`, no row branch. |
| `log.md` | `utils/activity-log.ts:123` | Unconditional `appendFile`. Best-effort (warns, never throws), so it fails silently on a read-only filesystem. |
| `.llmwiki/quarantined-embeddings.json` | `utils/embeddings-retry.ts:81,98` | Quarantine state has no table. An embedding that fails permanently is recorded only in a file. |

> These five are **not** the `stackId === ""` fallbacks. Those at least have a row
> branch. These have no row path at all: a Stack-backed project writes files for
> them regardless.

## 3. Storage exists but production never calls it

| Table | Store | Status |
|---|---|---|
| `wiki.review_candidates` | `dimensions/wiki/candidate-store.ts` | **Only the test imports it.** Candidates still persist through `compiler/candidates.ts:254` (`atomicWrite`). Step 3 was storage-only and never wired. |
| `wiki.page_embeddings` / `wiki.page_chunk_embeddings` | `utils/embeddings-database.ts` | Read side adapts to the loader seam and no production caller passes it; write side has no database implementation at all. |

The embedding CORPUS is the biggest artifact of the lot and is still **file-only in
both directions**: `persistEmbeddingStore` (`utils/embeddings-storage.ts:109`) writes
`.llmwiki/embeddings.json` unconditionally, and `EmbeddingStoreSink` — the interface
that would let a caller persist to rows — has no database implementation. The tables
exist and other paths populate them, which is what makes the gap easy to miss.

## 4. What this means for the migration order

The `stackId === ""` work I was about to continue is the *smaller* half. Removing a
fallback means "stop doing the file thing when you could do the row thing". Five
artifacts above have no row thing to switch to, so removing a fallback there is not
possible — the row path has to be **built** first.

Revised order:

1. **Build the missing row backends**: profile, index/MOC, log, quarantine.
2. **Wire the unwired stores**: `review_candidates`, embedding source/sink.
3. Then continue removing `stackId === ""` fallbacks (markers → seams → events).
4. Lock last.

Step 2 of the old plan ("wire Step 3 candidates to production") stops being a
cleanup item and becomes a prerequisite for deleting any candidate file path.

## Evidence limits

- Capability parity, not byte parity: a row-backed project round-trips the same
  data, but file *formatting* (key order, indentation) has no row analogue by design.
- `LOC` and reference counts are grep-derived and will drift; the table/column lists
  are queried live.
