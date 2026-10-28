# Feature: Per-ingest job status across the two dimensions

## Goal

Make one ingest observable while it runs, so a UI can answer "in what state is
this upload, in each dimension, and did it fail or retry" without waiting for a
five-minute request to return.

Today `POST /api/ingest` is synchronous and composite: it fetches, writes both
dimensions in one Postgres transaction, then compiles the whole wiki. There is no
persisted intermediate state anywhere. Progress lives in `output.status()` on
stdout and in `timeStage()`, which records to a timing file that no HTTP surface
reads (`src/utils/stage-timing.ts:65`). A client can only learn the outcome by
holding the connection open to the end.

## Decisions taken (user-owned)

| Question | Decision |
| --- | --- |
| Where does job state live | In process, plus durable failure records for the crash case |
| HTTP contract | Opt-in: `POST /api/ingest` with `{"async": true}` answers 202; without the flag it answers exactly as today |
| Meaning of "retry" | Visibility only — report the two real transaction attempts that already exist. No new retry policy |
| Scope of this change | API only. The viewer UI is a separate change that consumes this contract |

## The shape: two dimensions, not one status

A single `status` field cannot express the thing requested. Ingest and compile
are separate operations that fail separately, and the current endpoint already
proves it: a compile that fails leaves the source ingested
(`src/host/api.ts:112`, `compileBusy`). So the job carries two independent
dimensions:

```
ingest:  queued | running | succeeded | unchanged | failed
         stage: detecting | fetching | extracting | preparing | committing | projecting | journaling
compile: skipped | busy | queued | running | succeeded | failed
         stage: detect_changes | extraction | page_generation | finalize | embeddings
```

`ingest.unchanged` is a real outcome, not success: `writeStatus === "unchanged"`
means a re-ingest wrote nothing and journals nothing
(`src/services/ingest/service.ts:141`). Collapsing it into `succeeded` would tell
a UI a write happened when none did.

## Progress: no invented percentages

`progress` is `number | null` and is `null` unless the pipeline genuinely knows
its denominator. Per the request: show the real stage plus an indeterminate
indicator rather than fabricate 60%.

Known denominators today, and only these:

- `ingest` — none. The steps are discrete and unweighted; `null` throughout.
- `compile.page_generation` — merged concepts to generate, available at
  `src/compiler/index.ts:606` as the length of the extraction list.
- `compile.finalize` — written pages, available from the generation result.

Every other stage reports `null`. This is pinned by a test.

## Attempts

`attempts[]` records what actually happened, never a policy:

- coordinator transaction attempts, bounded by `MAX_TX_ATTEMPTS = 2`
  (`src/dimensions/coordinator.ts:76`, loop at `:191`)
- the existing failure line `reportIngestFailure` writes to stderr
  (`coordinator.ts:219`) keeps its shape; the observer does not replace it

Each entry is `{ attempt, startedAt, endedAt, error? }`.

## Durable failures

The in-memory job is lost if the process dies. This was accepted. The failure
event is not: every `failed` ingest appends one JSON line to
`.llmwiki/ingest-failures.jsonl` through the existing atomic-append primitive, so
a restart still explains why an upload never appeared.

## Endpoints

| Method | Path | Answers |
| --- | --- | --- |
| POST | `/api/ingest` `{"source":"...","async":true}` | 202 `{jobId, status, stage}` immediately |
| POST | `/api/ingest` (unchanged) | 200, exactly as today |
| GET | `/api/ingest/jobs/:id` | the job snapshot |
| GET | `/api/ingest/jobs` | recent jobs, newest first |

The two GET routes are registered on the **viewer**, not in `api.ts`, so they
inherit the origin policy and security headers the viewer already applies
(`src/viewer/server.ts:188`).

## Out of scope, recorded deliberately

- **SSE** (`/api/ingest/jobs/:id/events`). Polling is enough for this slice.
- **The viewer UI.** Separate change, built against this contract.
- **CSRF gap on the existing mutations.** `handleApiRequest` runs BEFORE the
  viewer (`src/host/server.ts:183`), so `POST /api/ingest` and `POST /api/compile`
  never pass `validateOriginHeaders`, contradicting the header comment at
  `src/host/api.ts:16`. Pre-existing, decided out of scope, tracked separately.
  Not made worse here: the new GET routes are mounted where the check applies.

## Tasks

- [x] 1. Job types: two dimensions, stages, attempts, nullable progress
- [x] 2. In-memory registry: create/get/list, TTL, bounded capacity
- [x] 3. Ingest observer: stage callbacks through service and coordinator
- [x] 4. Compile observer: reuse the five real `timeStage` stages
- [x] 5. HTTP: `{"async":true}` → 202 in `api.ts`; GET job routes on the viewer
- [x] 6. Durable failure record in `.llmwiki/ingest-failures.jsonl`
- [x] 7. Tests: 202 contract, transitions, attempts, no invented percentages

## Evidence

| Commit | Covers |
| --- | --- |
| `5457656` feat(ingest): track async ingest jobs across two dimensions | tasks 1, 2, 6, plus the runner that joins them |
| `5be3efc` feat(ingest): report real pipeline stages and transaction attempts | tasks 3, 4 |
| `8a8e714` feat(host): accept async ingests with 202 and expose job status reads | task 5, plus tests for all of it (task 7) |

### Follow-up: the UI lives in another project

Decided after implementation. The contract is therefore documented as a CONSUMER
surface in `docs/guides/http-ingest-jobs.mdx`, and the origin requirement is
stated as a first-class constraint rather than a footnote.

**The constraint, verified in code:** `validateOriginHeaders`
(`src/viewer/server.ts:333`) requires an exact hostname+port match, the viewer
sends no CORS headers, and it registers GET only so `OPTIONS` preflight 404s.

| Consumer | Outcome today |
| --- | --- |
| Server-side fetch (Node, server action, proxy) | works — sends no `Origin` |
| Browser `fetch` from another origin | 403, and no preflight |

A browser-direct integration needs a separate mount with explicit CORS and an
API-key story. That was offered and deliberately NOT done here: the user asked
for documentation only.

Also corrected `src/host/api.ts`'s header comment, which claimed the origin check
"already applies" to this mount when it did not.

### Checks run

- `npx tsc --noEmit` — pass
- `npm run build` — pass
- `npm run test:affected` — 688 files, 5102 tests pass, **2 unhandled
  `process.exit` rejections** in `test/commands/host-command.test.ts`. Verified
  pre-existing: stashing every change reproduces exactly the same 2 errors.
- `fallow` — no dead code, no duplication, 0 files above threshold

### Known debt this change touches but does not create

`src/compiler/index.ts` is 656 non-comment lines, over the 400-line rule. It was
644 before this change; the 12 lines added are the stage-boundary hooks. Splitting
that file is a separate refactor and doing it inside this feature would have made
the review much larger than the feature.

`test/artifacts/*` and `tsconfig.test.json` report 593 type errors, identical
before and after this change. None are in the files touched here.

