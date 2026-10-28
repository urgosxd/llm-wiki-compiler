# Feature: Stage the source projection before COMMIT

## Goal

Collapse the one window where ingest can report failure after the transaction has
already committed: writing `sources/<slug>.md` currently happens in `afterCommit`,
so a write error leaves rows committed while the caller is told the ingest failed.

## The hole, precisely

```
attempt ─ tx ─┬─ bind app.stack_id
              ├─ wiki.commit(handle, {tx})     rows only
              ├─ kg.commit(handle,   {tx})
              └──────────────────────────────→ COMMIT
                                              ↓
                runProjections(runs)          ← no try/catch: an error here
                                              propagates with rows committed
```

`runProjections` at `src/dimensions/coordinator.ts:332` is not inside any
`try`. If `projectSourceMarkdown` throws, the caller receives an error while
`wiki.pages`, `wiki.source_documents` and `stack_documents` are already durable.
"No rows or both rows" holds; "no artifact or both artifacts" does not.

There is **no test** for this path. The existing suite only proves that no
projection runs when no dimension committed
(`test/dimensions/cross-dimension-rollback.test.ts:169`).

## Why the obvious fix does not work

`saveSource` (`src/utils/source-writer.ts:158`) does not accept a destination.
It derives the filename by reading the directory: `findFileBySourceIdentity`
scans every existing source's frontmatter, and `resolveCollisionFreeFilename`
probes with `lstat`. The destination, and the created/updated/unchanged verdict,
are known only by performing the write. So "write to a temp path and rename
before COMMIT" is not implementable as a pre-commit step that already knows its
target.

## The design that does work

The port already documents this shape. `prepare` is defined to cover "a dimension
whose `prepare` allocated something OUTSIDE the transaction — a staged upload, a
temp file" (`src/dimensions/types.ts`, `discard` doc comment). Use it as written:

| Phase | Work |
| --- | --- |
| `prepare` | No DB access, and no source write either — the target is still unknown. |
| `commit` | Rows only, inside `scope.tx`. Unchanged from today. |
| `afterCommit` | **Create** `sources/.staged-<ingestId>` with the document bytes, still under the unknown-target problem. |
| post-projection | **Rename** the staged file onto the resolved destination, which is a same-filesystem atomic operation. |

The unresolved question this feature must answer before implementing: the rename
target still comes from `saveSource`'s directory scan, so the sequence is
"stage bytes → resolve target → rename". Whether that belongs in one module that
splits `saveSource` into resolve + write, or in a new projection function that
owns staging, is the design decision this feature exists to make. Do not start
T2 before answering it.

### What it buys, stated honestly

It does **not** reach zero. It replaces "any failure of the file write after
COMMIT" with "failure of a same-directory `rename` after COMMIT". That is a much
narrower and rarer window, not an empty one. The feature must not claim otherwise.

### Temp file naming

The staged file must not be picked up as a source. `src/sources/scan.ts:51`
filters on `endsWith(".md")`, so `.staged-<ingestId>` (no `.md` suffix) is
invisible to the scan. This is the constraint that decides the name, not taste.

## Context that lowers the severity

With a Stack configured, `compile` detects changes from `wiki.source_documents`,
not from the directory (`sourceDocumentsChangeSource`,
`src/dimensions/wiki/source-documents-store.ts:334`). The `sources/` markdown is a
human-facing projection, not the corpus of record. So the residual case is
recoverable by a re-ingest; it does not corrupt the corpus. This is why the
feature is worth doing but is not urgent, and why it is sequenced after the
outbox retirement.

## Decisions (user-selected)

| Decision | Choice |
| --- | --- |
| Approach | Stage the projection before COMMIT and rename after it |
| Contract cost | The port's projection contract changes; `types.ts`, `store-dimension.ts`, `source-projection.ts` and their tests move |

## Non-goals

- Eliminating the residual rename window.
- Changing which dimension owns the markdown.

## Tasks (provisional — see the open design decision above)

| # | Task | Surfaces |
| --- | --- | --- |
| T0 | Decide where the resolve/stage/rename split lives, and record it here. | this document |
| T1 | Split target resolution from the byte write so the two are separately callable and separately testable. | `src/utils/source-writer.ts` |
| T2 | Stage on `prepare`, rename on the post-commit step, delete the staged file on `discard`. | `src/dimensions/wiki/store-dimension.ts`, `src/dimensions/wiki/source-projection.ts` |
| T3 | Land the missing test: a projection failure must not report success, and must not destroy a pre-existing file. | `test/dimensions/coordinator.test.ts`, `test/dimensions/source-projection.test.ts` |

## Verification

- `npx tsc --noEmit`
- `npm run build`
- `npm run test:affected`
- `fallow`
