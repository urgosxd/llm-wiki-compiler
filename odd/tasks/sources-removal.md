# Feature: Remove `sources/` — raw bytes into Postgres

## Goal

Make Postgres the only storage medium for the whole product, not just for
compiled pages. After this change an ingest writes no file, `compile` reads no
file, and `sources/` stops existing as a contract that consumers can rely on.

Status: **MEASUREMENT + DESIGN. NO PRODUCT CODE.** The human selected "no debe
escribir el ingest en filesystem" in this session. Nothing here is implemented;
the measurements below were taken from the repository and the live database, not
recalled.

## Why this is not part of T3

T3 moved the **compiled product** (L2) into `wiki.pages`. It deliberately left
raw source bytes (L1) on disk, and said so in the schema it shipped:

> `body` is stored inline rather than in an object store: W3 keeps L2 (the compiled
> product) in the database and leaves L1 (raw source bytes) to Wave 4. Keeping the
> two layers apart is what lets W4 move blobs without touching this table.

This document is that Wave 4. It is larger than T3 by an order of magnitude and
must not be smuggled into it.

## Measurements (verified this session)

| Fact | Value | How measured |
| --- | --- | --- |
| Files in `src/` that reference `sources/` or `SOURCES_DIR` | **30** | `git grep -ln` |
| Files in `src/` importing `node:fs` | **102** | `git grep -ln` |
| Test files asserting on `sources/` | **93** | `git grep -ln` |
| Compiler files reading a body with `readFile` | **5** | `git grep -ln` in `src/compiler/**` |
| Content column on `stack_documents` | **0** | `information_schema.columns` |

### The load-bearing reads

`compile` does not read sources through one function. It needs three distinct
things, and each has its own physical dependency:

| Need | Where | Today |
| --- | --- | --- |
| Enumerate which sources exist | `src/sources/scan.ts:50` `listSelectedSourceFiles` | `readdir` over `sources/` |
| Hash one source to detect change | `src/compiler/hasher.ts:23` `hashFile` | `readFile` |
| Read one body to extract from | `src/compiler/extraction-phase.ts:132` | `readFile` |

A fourth path, `src/compiler/index.ts:608`, re-hashes a candidate's source to
decide whether a modifier change demoted it.

**Consequence:** there is no single choke point to swap. The seam has to be
introduced and then threaded through these four needs, which is why this is a
wave and not a task.

### What the database already has

`public.stack_documents` exists and the KG dimension already writes it:
`id, stack_id, filename, storage_path, size_bytes, content_type, source_hash,
truncated, original_length, audit, ingested_at`. It has **no content column**, and
`storage_path` points at `uploads/` on disk.

`public.document_chunks` **does** store text (`content text not null`), but it is
chunked extraction output, not the source of record: reconstructing a source by
concatenating chunks would make chunking a storage format and couple the source
identity to the chunker's boundaries.

## What the human must decide before code

Both are needed before the first write; neither is the executor's call.

1. **Where do the raw bytes live?** Three shapes, each with a different cost:
   - **(a) `stack_documents.content text`** — a new nullable-then-backfilled
     column. Simplest read (`select content`), no new dependency, and the row
     already carries `source_hash`, `truncated` and `original_length`, which are
     exactly the fields `IngestResult` reports today.
   - **(b)** reuse `document_chunks.content` — no schema change, but makes the
     chunker a storage format and cannot represent a source that failed
     extraction.
   - **(c)** a real object store — the eventual shape, and the largest change.

   Recommendation: **(a)**. It moves the bytes without inventing a storage layer
   at the same time, and `source_hash` already gives content addressing.

2. **What replaces `filename` in `IngestResult`?** Today it is a path basename and
   several consumers do `path.basename(savedPath)`. With rows, the honest identity
   is `(stack_id, filename)` or `source_hash`. Changing the type is a public API
   change, so it needs a decision rather than a refactor.

## Scope verdict

Computed against `contract-cordination.json` for the paths this plan touches:

| Path | `orchestrator-a` | `orchestrator-main` |
| --- | --- | --- |
| `src/sources/store.ts` | shared-read-only | **owned** |
| `src/compiler/hasher.ts` | shared-read-only | **owned** |
| `src/compiler/extraction-phase.ts` | shared-read-only | **owned** |
| `src/dimensions/wiki/schema.sql` | **owned** | owned |
| `packages/llmwiki-kg/db/schema.sql` | forbidden | **owned** |
| `test/**` (the 93 files) | mostly forbidden | **owned** |

Almost every seam is this role's, so the work cannot be delegated to a dimension
role. Only the wiki schema is shared.

## Shape

Introduce one seam and make every physical read go through it, before moving any
byte:

```
interface SourceStore {
  list(): Promise<string[]>;              // ids, e.g. "records/note.md"
  hash(id: string): Promise<string>;      // sha256 of the body
  read(id: string): Promise<string>;      // the body
}
```

Then:

1. **Introduce the interface with a filesystem implementation.** No behaviour
   change; `compile` keeps working. This is the step that makes the rest
   reversible.
2. **Add a `SourceStore` implementation over Postgres** (`stack_documents.content`),
   and a test that both implementations return identical bodies and hashes for the
   same source.
3. **Switch ingest to write rows only.** `writeToDimensions` stops requiring
   `artifactPath`; `IngestResult.filename` becomes the row's `filename`.
4. **Switch `compile` to the store**, one read at a time: list, then hash, then
   body.
5. **Delete the filesystem implementation and `sources/`** only when nothing reads
   it. `SOURCES_DIR` is then unused, and that is the signal.

Step 5 is last for the same reason the rollback defect mattered: deleting the
fallback removes the condition the earlier steps were assuming.

## Non-goals

- Not moving `dist/exports`. Wave 4.1 mentions it; it is a second migration and
  must not ride along.
- Not changing the KG dimension's `uploads/` path. That is the vendored server's
  own storage and a different lifecycle.
- Not renaming `Stack`. That decision is already recorded and settled.

## Verification expectations

- `npx tsc --noEmit` exit 0 at every step.
- After step 2, both store implementations agree on list/hash/read for a fixture.
- After step 4, a full `compile` of a project whose sources exist only in Postgres
  produces the same pages as it did from disk.
- After step 5, `git grep SOURCES_DIR -- 'src/**'` is empty. That is the
  completion check, not a green test run.

## Evidence

- Measurements taken this session; commands are in the table above.
- `stack_documents` inspected live at `localhost:5434`, database `aks`.
- The W3 schema comment quoted above is from `src/dimensions/wiki/schema.sql`,
  which is in `main` at `e71da25`.
