# A dimension that never runs leaves no trace

Maintainer and operator findings. Repo-facing plain `.md`, not part of the published Mintlify
site (so `docs.json` is untouched, as for `docs/turborepo.md`). Measurements are from database
`llmwiki_corpus_demo_rc1` after the demo corpus ingest; code locations are cited as `path:line`.

**Status.** The finding below and the two silent-skip sites are kept as measured, before the
per-dimension report existed. The silence they describe is still what the process emits, and it is
no longer what a consumer reads: branch `fix/ingest-dimension-reporting` made a settled run report
every dimension it knew about. See [What a settled run
reports](#what-a-settled-run-reports), which is the part of this document that describes what the
code does today.

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
`packages/llmwiki-kg/ts/src/server.ts:242`. That package has **0** production imports of
`@repo/wiki` and **0** reads of `LLMWIKI_DIMENSIONS`; it writes `public.document_chunks`
(`routes/ingest/pipeline.ts:638`) and never writes `wiki.pages` or `wiki.source_documents`.

The dimension-coordinating ingest is a **different surface**: `POST /api/ingest`
(`packages/api/src/host/api.ts:453`, dispatched at `:865`) → `requireDimensionsPort(…,
INGEST_DIMENSIONS)` (`:463`, and the async route requires the same port at `:270`) →
`INGEST_DIMENSIONS = ["wiki","kg"]` (`packages/wiki/src/services/ingest/service.ts:92`) →
`ingestDimensions` (`packages/wiki/src/dimensions/coordinator.ts:525-531`).

So the wiki dimension was **not skipped — it was never invoked**, because the route the corpus
took does not compose dimensions at all. Distinguishing the two matters because the remedies
differ: a silent skip is fixed where the name list is filtered, an unreachable surface is
fixed by choosing a route.

## Two real silent-skip sites — separate, latent, and NOT the cause

Both are genuine silences, but conflating them with the cause above would aim a fix at the
wrong place. Both now land in the report described below; neither writes a line to stderr.

1. `packages/wiki/src/dimensions/activation.ts:337` — `if (!names.includes(name)) continue;`
   emits nothing. With `LLMWIKI_DIMENSIONS` resolving to `["wiki"]` on this deployment while
   `INGEST_DIMENSIONS` asks for `["wiki","kg"]`, the `kg` dimension is dropped in silence on the
   api-host path. A run in that configuration reports it as `skipped` / `disabled`.
2. `packages/wiki/src/dimensions/coordinator.ts:228` — a dimension whose `prepare` returned
   `null` is skipped during commit, also with no message. This is the defensive branch of the
   loop, not a state either shipped dimension reaches. A run that hit it reports
   `skipped` / `declined`. The discard path that undoes those preparations is at `:194`.

## What the process emits — and what now answers the silence

The only diagnostic the dimension code writes to the process is
`packages/wiki/src/dimensions/coordinator.ts:323`, a `process.stderr.write` inside
`reportIngestFailure` (`:309-327`). The line it writes is the JSON literal at `:314-321`:

```json
{"event":"ingest_failed","outcome":"failed","source":"<identity>","dimensions":["<name>","<name>"],"attempts":2,"error":"<message>"}
```

It names every dimension the run ATTEMPTED, as a bare list of names, with one error. So it says
a run failed and which dimensions were in it; it does not say what each one did, and it says
nothing at all on a run that does not throw.

**The failure half is the whole of the stderr story, and the skip paths are still mute there:**
nothing is written when `LLMWIKI_DIMENSIONS` filters a name out (`activation.ts:337`), and nothing
is written when a dimension's `prepare` returned `null` (`coordinator.ts:228`).

**The silence is now answered where an operator actually looks.** Two read surfaces report every
dimension a run knew about: a settled ingest job carries a per-dimension report, and `POST
/api/compile` answers with one. "Every non-failure path is mute" was true of this codebase when
this document was written; it is now true only of stderr, and the version of it that a consumer
reads is [below](#what-a-settled-run-reports).

Neither silence explains the empty wiki tables: the wiki dimension never returns `null`
(`packages/wiki/src/dimensions/wiki/store-dimension.ts:247-285` always returns a handle), and
an `unchanged` ingest still writes `wiki.source_documents`
(`store-dimension.ts:300-315`; only the page row is skipped, `:331`).

## A second measured trap: compile is a silent no-op here

With `AKS_STACK_ID` non-blank, change detection returns rows rather than directory contents
(`packages/wiki/src/compiler/index.ts:1225-1227`, routing detection through
`sourceChangeDetection` at `:2173-2178`), read from `wiki.source_documents`
(`packages/wiki/src/compiler/hasher.ts:55-57`, via `sourceDocumentsChangeSource` in
`packages/wiki/src/dimensions/wiki/source-documents-store.ts:330`), which holds 0 rows. A
compile there detects **0 changes, does nothing, and reports success**. Generalised: a green
compile against an empty source table proves nothing — the signal is the change count and its
source of truth, not the exit status. The per-dimension report does not change this: a compile
that found nothing to do still reports `wiki` as `succeeded`, because the summary carries the
counts (`compiled=0 skipped=0 deleted=0 …`) and the dimension itself did not fail.

## Where sources canonically live

The wiki ingest dimension never touches the filesystem: it takes `source` and `document`
strings and writes rows (`store-dimension.ts:300-315`). The party with a `root` is the
compiler — `compile(root, …)` (`packages/wiki/src/compiler/index.ts:299`) — and that root is
the process working directory, set at `const root = process.cwd()` for `host`
(`packages/api/src/main.ts:316`) and by `--root` defaulting to the current directory for
`serve` (`packages/api/src/main.ts:372`). Under that root, `sources/` sits at
`path.join(root, SOURCES_DIR)` with `SOURCES_DIR = "sources"`
(`packages/wiki/src/utils/constants.ts:328`; the join at
`packages/wiki/src/compiler/hasher.ts:153`), and a compile scans it only when no Stack is
configured (`packages/wiki/src/compiler/index.ts:2173-2178`). Separately, the KG upload path is
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

## What a settled run reports

This is the answer to the question the tables above cannot answer — *was this dimension invoked,
and did it work?* — as it exists in this branch.

### The shape: one entry per known dimension

`DimensionOutcome` (`packages/wiki/src/dimensions/outcome.ts:67-74`) is a closed union over the
two dimensions this build knows (`KNOWN_DIMENSIONS`, `activation.ts:67` — `wiki` and `kg`). One
entry per known dimension appears on every settling path, always, in that order:

```ts
type DimensionOutcome =
  | { name; status: "succeeded"; summary }        // it committed; `summary` is what it returned
  | { name; status: "failed"; error }             // it ran and threw; `error` is the message
  | { name; status: "skipped"; reason }           // and `reason` is one of the four below
```

The producer is `describeDimensionOutcomes` (`packages/wiki/src/dimensions/report.ts:94`); it emits
one outcome per known dimension, and a dimension missing from the report is a bug rather than a
statement.

**`succeeded` — it ran and committed.** The `summary` is the dimension's own string: the value that
`commit` returned, recorded per run by `reportOf` (`coordinator.ts:492-499`), which is the same
value `IngestOutcome.summaries` carries (`summariesOf`, `:440`). Real examples: the wiki reports
`wiki:created`, `wiki:updated` or `wiki:unchanged` (`store-dimension.ts:379`), and the KG reports
its counts, for example `kg:6 chunks, 12 entities`, followed by a note per degradation
(`packages/wiki/src/dimensions/kg/index.ts:353-357`). A kg document that extracted no chunks
still commits, and says so: `kg:dry-run(0 chunks, 0 entities)` (`kg/index.ts:696`).

**`failed` — it ran and threw.** `error` carries the message, the one part that survives the wire
(`coordinator.ts:290-292`). On a rolled-back transaction the job record reports `failed` for
every dimension the run touched, because after the rollback none of their work exists — including
one that had committed before a sibling threw (`run.ts:260-275`).

**`skipped` — and the reason is the whole point.** Five non-success facts stay distinct because an
operator acts differently on each:

| reason | what it means | what an operator should conclude |
| ------ | ------------- | -------------------------------- |
| `not-in-route` | this route does not compose the dimension at all | nothing is misconfigured and no environment variable will help; the work happens on a route that composes it — `POST /api/ingest` is the one that composes both |
| `disabled` | the route composes it, but `LLMWIKI_DIMENSIONS` excludes it | change the switch: the configuration is what stopped it |
| `declined` | it ran and had nothing to commit (`prepare` returned `null`, or the producer found no run record for it) | neither shipped dimension returns `null` from `prepare` today, so this is the defensive branch; do not read it as "disabled" |
| `not-attempted` | the run failed BEFORE this dimension was reached — an unreadable source, a held lock — so the failure is upstream of it | fix the failure the job already names (`ingest.error`); nothing about the dimension is known, and its configuration is not the cause |
| *(failure)* | it ran and threw — the `failed` arm, not a skip, because it carries the error text | the run failed and nothing it wrote survived the rollback |

Precedence is route first, deliberately: when a route does not compose a dimension, reporting
`disabled` there would send someone to change a variable that would not have helped
(`report.ts:107-116`). `not-attempted` ranks below both and above every run record, because an
upstream death must not disguise a route that never composed the dimension or a switch that
excludes it — and because the two states it could otherwise be confused with, `failed` and
`declined`, both describe a dimension that RAN.

### Where it appears: one shape, three surfaces

The report is written ONCE, onto the job record, by the runner — `recordReport`
(`packages/wiki/src/services/ingest/jobs/run.ts:218-228`) calls `registry.patchDimensions`, before
the compile settles so the durable mirror persists a row that already carries it. `IngestJob`
gains an optional `dimensions` field (`packages/wiki/src/services/ingest/jobs/types.ts:265`,
declared `:236-282`); optional because the store persists the whole record as `payload jsonb`, so
every row written before this field existed lacks the key and must read back as it always did.

From there it is passthrough, not three builders:

- `GET /api/ingest/jobs/:id` answers the stored snapshot (`packages/wiki/src/viewer/api-ingest-jobs.ts:343`);
- `GET /api/ingest/jobs` answers the same snapshot per row (`:176`);
- the MCP tools `ingest_job_status` (`packages/wiki/src/mcp/job-tools.ts:91`) and
  `ingest_jobs_list` (`:127`) return it too.

All four go through the one view builder both readers already shared, `withStatusReason`
(`packages/wiki/src/services/ingest/jobs/status.ts:257`), which returns the record and adds the
derived status fields; none of them rebuilds `dimensions`. So the shape a client parses is the
shape the producer emitted — `packages/wiki/src/dimensions/outcome.ts` for the wire type, one
producer, one field.

Absent is not empty: a run in the file-authority mode (a wiki with no database) performs no
dimension commit at all and therefore carries no `dimensions` key, rather than inventing a reason
per dimension (`service.ts:155-172`). An older stored row also still reads: the shape guard checks
`id`, `source`, `ingest` and `compile` and nothing else (`job-store.ts:72-82`), so a payload
written before the field existed validates and reads back without it.

A run that settles FAILED is no longer in that category, and that is the point of `not-attempted`:
before it existed, an ingest whose source could not be read settled `failed` with no `dimensions`
key at all, which is the same silence an excluded dimension produced. Now every settling path names
every known dimension — `failed` after a rollback (`failedReportOf`, `run.ts:260-275`), and
`not-attempted` when the run died upstream of the dimensions (`notAttemptedReportOf`,
`run.ts:291-298`), whose route and switch come from the configuration because no run record
survived to say otherwise.

### The compile message is now derived, not constant

The constant `"Wiki compiled."` is gone as the answer. The message on a settled job comes from
`compiledMessageOf` (`run.ts:238-240`), which returns `describeDimensionMessage`
(`report.ts:132`) of the run's report — the constant survives only as the fallback for a run that
recorded no report at all (the file-authority mode).

The format is exactly: the dimensions that succeeded, joined with ` and ` and framed as
`Compiled <names>.` (`Nothing compiled.` when none did), then one clause per non-succeeded
dimension in canonical order — ` <name>: not part of this route.`, ` <name>: disabled by
LLMWIKI_DIMENSIONS.`, ` <name>: no changes.`, ` <name>: not attempted.` or ` <name>: failed.`

Real reported strings, in the words the operator would see:

| run | `compile.message` |
| --- | --- |
| both dimensions committed | `Compiled wiki and kg.` |
| ingest composed both, `LLMWIKI_DIMENSIONS=wiki` | `Compiled wiki. kg: disabled by LLMWIKI_DIMENSIONS.` |
| wiki committed, kg outside the route | `Compiled wiki. kg: not part of this route.` |
| neither committed | `Nothing compiled. wiki: failed. kg: not part of this route.` |
| the run died before any dimension | `Nothing compiled. wiki: not attempted. kg: not attempted.` |

### `POST /api/compile` answers with the report too

`POST /api/compile` (`packages/api/src/host/api.ts:870`) answers `200` with an ADDITIVE
`dimensions` key (`:577`), built by `compileReportOf` (`packages/api/src/host/compile-report.ts`).
The precedent is `runSyncIngest`, which appends `compiled`/`compileBusy` to the ingest body
(`api.ts:482`, `:487`): nothing existing was renamed, removed or re-typed, and a consumer that
ignores unknown keys keeps working. A body is therefore the compile result plus one key:

```json
{
  "compiled": 0, "skipped": 0, "deleted": 0,
  "concepts": [], "pages": [], "errors": [],
  "dimensions": [
    { "name": "wiki", "status": "succeeded", "summary": "wiki: compiled=0 skipped=0 deleted=0 concepts=0 pages=0 errors=0" },
    { "name": "kg", "status": "skipped", "reason": "not-in-route" }
  ]
}
```

`kg` reads `not-in-route` there because that route performs no ingest — it compiles what ingest
already stored, and nothing else (`compile-report.ts:45`). The `busy` path keeps answering `409`
and carries no report: a report of a run that never started would be a second answer to a question
the `409` already answers.

### The asymmetry that makes this report necessary

**The wiki has a compile PHASE and the KG does not.** `compileAndReport`
(`packages/wiki/src/compiler/index.ts:342`) detects changes, generates pages and links, then
embeds — over what ingest already stored. The KG dimension writes its graph during ingest, per
document, inside the same transaction, before that compile phase ever runs
(`packages/wiki/src/services/ingest/jobs/run.ts:412`, then `:423`). So the KG work happens on
every ingest and always has, and "compile" means two different things in the two dimensions.

That is the whole reason this document exists. An operator read a compile line that named only
the wiki, concluded the KG compile did not exist, and asked for a feature to build what was
already running. Nothing in the pipeline was missing; the trace was. `kg` reading `not part of
this route` on a compile-only route is truthful — that route performs no ingest — while the same
dimension's entry on an ingest job names what it actually wrote.

## What would make this observable

Two of the three suggestions below have shipped, one has not. Kept as written, with the outcome
against each.

- **Fill `wiki.ingest_job.payload`.** SHIPPED. The column exists (`jsonb`) and now carries the
  whole job record, including `dimensions` — one entry per dimension with its outcome and reason.
  "Never invoked" and "skipped" are different values instead of identical emptiness.
- **Emit the skip.** SHIPPED, but not on stderr. Rather than widen the failure-only channel at
  `coordinator.ts:323`, the skip is recorded in the report a consumer reads
  (`skipped` / `not-in-route` / `disabled` / `declined` / `not-attempted`), which reaches the
  HTTP job read and the MCP job tools. stderr still carries only the failure line.
- **Record a stage key per dimension** in `public.stack_documents.audit`, which already carries
  kg stage names (`open`, `ontology`, `classification`). NOT DONE, and still open: the report
  states an outcome per run, not a per-stage trace inside a dimension. A dimension whose absence
  is expected and named is auditable; one that is merely missing is not — the report names it,
  the tables still do not.
