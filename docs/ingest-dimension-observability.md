# A dimension that never runs leaves no trace

Maintainer and operator findings. Repo-facing plain `.md`, not part of the published Mintlify
site (so `docs.json` is untouched, as for `docs/turborepo.md`). Measurements are from database
`llmwiki_corpus_demo_rc1` after the demo corpus ingest; code locations are cited as `path:line`.

## The finding

A run that executes and skips a dimension, and a run that never reaches the dimension code at
all, are indistinguishable after the fact. Both leave identical tables; the difference lived
only in a process that has exited.

| where | observed |
| ----- | -------- |
| `wiki.ingest_job` | **0 rows**. Columns: `stack_id, job_id, source, ingest_status, compile_status, payload jsonb, created_at, updated_at`. `payload` is empty. |
| `public.stack_documents.audit` | records kg stages only — `open`, `ontology`, `classification`. No `wiki` key, no per-dimension key. |
| `wiki.activity_log`, `wiki.event_log`, `wiki.source_compile_state` | **0 rows** each. |
| a per-dimension trace table | **none exists** anywhere in the schema. |

The KG side visibly ran: `public.kg_classification_log` holds 283 rows and
`public.document_chunks` holds 6; the wiki side holds 0 pages and 0 source documents. Nothing
recorded a start, a skip, or a failure for any dimension. That absence is why establishing the
cause required tracing routes and import boundaries rather than reading tables: the tables can
answer "did this dimension leave output?", never "was this dimension invoked?".

## The cause in this instance — and what it was NOT

The corpus entered through the KG package's own routes: `POST
/stacks/:stackId/documents/:doc_id/ingest` at
`packages/llmwiki-kg/ts/src/routes/ingest/router.ts:143` (handler `:89`), mounted root-only at
`packages/llmwiki-kg/ts/src/server.ts:240-241`. That package has **0** production imports of
`@repo/wiki` and **0** reads of `LLMWIKI_DIMENSIONS`; it writes `public.document_chunks`
(`routes/ingest/pipeline.ts:638`) and never writes `wiki.pages` or `wiki.source_documents`.

The dimension-coordinating ingest is a **different surface**: `POST /api/ingest`
(`packages/api/src/host/api.ts:478`) → `requireDimensionsPort(…, INGEST_DIMENSIONS)` (`:389`)
→ `INGEST_DIMENSIONS = ["wiki","kg"]` (`packages/wiki/src/services/ingest/service.ts:78`) →
`ingestDimensions` (`packages/wiki/src/dimensions/coordinator.ts:400-411`).

So the wiki dimension was **not skipped — it was never invoked**, because the route the corpus
took does not compose dimensions at all. Distinguishing the two matters because the remedies
differ: a silent skip is fixed where the name list is filtered, an unreachable surface is
fixed by choosing a route.

## Two real silent-skip sites — separate, latent, and NOT the cause

Both are genuine defects, but conflating them with the cause above would aim a fix at the
wrong place.

1. `packages/wiki/src/dimensions/activation.ts:311-313` — `if (!names.includes(name)) continue;`
   emits nothing. With `LLMWIKI_DIMENSIONS` resolving to `["wiki"]` on this deployment while
   `INGEST_DIMENSIONS` asks for `["wiki","kg"]`, the `kg` dimension is dropped in silence on the
   api-host path.
2. `packages/wiki/src/dimensions/coordinator.ts:186` — a dimension whose `prepare` returns
   `null` is skipped during commit, also with no message (discard path `:152`).

The only dimension diagnostic in the codebase is `coordinator.ts:269`, a
`process.stderr.write` inside `reportIngestFailure` — failure-only; every non-failure path is
mute. Neither explains the empty wiki tables: the wiki dimension never returns `null`
(`packages/wiki/src/dimensions/wiki/store-dimension.ts:247-285` always returns a handle), and
an `unchanged` ingest still writes `wiki.source_documents` (`store-dimension.ts:300-315`; only
the page row is skipped, `:331`).

## A second measured trap: compile is a silent no-op here

With `AKS_STACK_ID` non-blank, change detection returns rows rather than directory contents
(`packages/wiki/src/compiler/index.ts:1994-2001`), read from `wiki.source_documents`
(`packages/wiki/src/compiler/hasher.ts:51-58`, via `sourceDocumentsChangeSource` in
`packages/wiki/src/dimensions/wiki/source-documents-store.ts:330`), which holds 0 rows. A
compile there detects **0 changes, does nothing, and reports success**. Generalised: a green
compile against an empty source table proves nothing — the signal is the change count and its
source of truth, not the exit status.

## Where sources canonically live

The wiki ingest dimension never touches the filesystem: it takes `source` and `document`
strings and writes rows (`store-dimension.ts:300-315`). The party with a `root` is the
compiler — `compile(root, …)` (`packages/wiki/src/compiler/index.ts:281`) — and that root is
the process working directory, set at `const root = process.cwd()` for `host`
(`packages/api/src/main.ts:278`) and by `--root` defaulting to the current directory for
`serve` (`packages/api/src/main.ts:322`). Under that root, `sources/` sits at
`path.join(root, SOURCES_DIR)` with `SOURCES_DIR = "sources"`
(`packages/wiki/src/utils/constants.ts:284`; the join at
`packages/wiki/src/compiler/hasher.ts:153`), and a compile scans it only when no Stack is
configured (`packages/wiki/src/compiler/index.ts:1994-2001`). Separately, the KG upload path is
`uploads/<stack>/<docid>.md`, relative to the **KG server's** working directory
(`packages/llmwiki-kg/ts/src/core/files/constants.ts:26-27`; composed at `core/files/storage.ts:61`),
recorded per document in `stack_documents.storage_path` (`routes/documents/upload.ts:178`)
and read back by the KG pipeline (`routes/ingest/request.ts:278`, called at
`routes/ingest/pipeline.ts:414`). Nothing in code bridges the two trees: the KG package
imports no `@repo/wiki` and never writes `wiki.source_documents`. The two options are therefore
(a) push the uploaded documents through the dimension-composing ingest, so the rows the
compiler reads exist, or (b) place the documents under `<root>/sources/` in the format
`SOURCES_CONTRACT.md` defines — noting that on a deployed Stack the directory scan is not
consulted, so files there become visible to a compile only once rows exist.

## What would make this observable

Suggestions, not a plan; no schema or code change is proposed here.

- **Fill `wiki.ingest_job.payload`.** The column exists (`jsonb`, currently empty). Recording
  the resolved dimension set, each dimension's outcome, and its reason would make "never
  invoked" and "skipped" different rows instead of identical emptiness.
- **Emit the skip.** Both skip sites (`activation.ts:311-313`, `coordinator.ts:152,186`) can
  use the stderr JSON channel that already exists at `coordinator.ts:269`, with
  `outcome: "skipped"` and the dimension name.
- **Record a stage key per dimension** in `public.stack_documents.audit`, which already carries
  kg stage names (`open`, `ontology`, `classification`). A dimension whose absence is expected
  and named is auditable; one that is merely missing is not.
