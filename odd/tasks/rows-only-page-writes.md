# rows-only-page-writes — a Stack never writes a page file

## Goal

On a Stack-backed project, every page write and every page delete reaches
`wiki.pages`. No path may fall back to writing `wiki/**/*.md` or unlinking it,
because on a Stack that file is neither the page nor a copy of it — it is a second
corpus nothing reads and nothing keeps in step.

`lint-row-awareness.md` delivered this for the COMPILE pipeline only. Five other
mutation surfaces still run the file path unconditionally, and the human's decision
is explicit: **rows only, everywhere**.

## What is already row-aware, and what is not

The row capability reaches a write through `ApplyOptions` — `pageSink`,
`pageRemover`, `pageBatchTransaction` — which the compile pipeline resolves once
through `resolvePageSeams` and threads to every stage.

| Mutation surface | Entry point | Supplies the seams? |
| --- | --- | --- |
| compile (generation, seeds, orphan, resolver, link-repair) | `applyCompilePageWritesLocked` | **yes** |
| source removal | `deleteWikiPagesLocked` | **yes** (via `withPageRemover`) |
| review approve — default page | `routeDefaultPageWrite` → `applyApprovedMutationsLocked` | **no** |
| review approve / import — typed candidate | `applyTypedCandidate` → `applyApprovedMutationsLocked` | **refused** — not storable, see below |
| `promote` | `applyTypedCandidate` (same function) | **no** |
| lifecycle transition | `transitionLifecycle` → `applyApprovedMutationsLocked` | **no** |
| relation create | `createRelation` → `applyApprovedMutationsLocked` | **no** (relations are appended, not pages — see below) |
| OKF import | `writeAll` → `atomicWrite` | **no** |

Measured, not assumed: `grep -n "pageSink\|withPageSeams\|resolvePageSeams"`
returns zero hits in `promote.ts`, `lifecycle-transition.ts`, `relation-write.ts`,
and `profile-import.ts`.

## Three defects, measured — and the one that blocks the others

They were found in this order, and the order matters: the third one found is the
one that stops the other two from ever running on a Stack.

### D2 — candidate custody is filesystem-only, so `review approve` refuses before writing

Found first, fixed first, because nothing else can be observed until it moves.

`approveUnderLock` calls `candidateNamespacesPermitApproval`, which calls
`assertCandidateMutationAccess` → `assertCandidateNamespacesHealthy` →
`captureDirectory(root, ".llmwiki/candidates")`.

On a Stack `writeCandidate` takes its ROW branch — its own header says the whole
custody dance "exists to give a DIRECTORY the identity a row has for free" — so
`.llmwiki/candidates` is never created. The FS-only custody check therefore finds
no directory and raises `CandidateCustodyUnavailableError`, which the command
reports as "candidate store unavailable" and exits 1.

Measured, with a real Stack and a candidate written through `writeCandidate`:

```
! Candidate <id> not approved: candidate store unavailable.
EXITCODE: 1
FILES: false false      # wiki/ does not even exist
ROW: undefined
```

The row write in `writeCandidate` and the FS custody check in
`assertCandidateNamespacesHealthy` disagree about where candidates live. Fixing the
sink alone would leave this untouched: the CLI would still exit 1 before reaching
any page write.

### D1 — the page write never receives the row sink

`routeDefaultPageWrite` calls `applyApprovedMutationsLocked(root, planned)` with no
options, so the executor takes its file branch and writes
`wiki/concepts/<slug>.md` on a Stack — a file nothing reads, because the corpus is
`wiki.pages`.

The seam is already in the file: `review-approve.ts:58` imports `withPageSeams`
and uses it at line 412 for `resolveAndApplyLinks` and `repairAndApplyLinks`. The
main write simply does not go through it. Same shape in `applyTypedCandidate`,
`transitionLifecycle`, and the OKF import's `writeAll`.

### D3 — the returned path names a file that was never written

`routeDefaultPageWrite` ends with:

```ts
const dir = candidate.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
return path.join(root, dir, `${candidate.slug}.md`);
```

That value feeds exactly one consumer — `output.success(\`Approved → ${path}\`)` —
and on a Stack it points at a file that does not exist. Low blast radius, but it is
the CLI telling the operator something untrue about where the page landed.

## The surfaces, one by one

### 2. `applyTypedCandidate` (`promote.ts`) — NOT STORABLE ON A STACK

Called by review approve for typed candidates and by `profile-import.ts:240`. It
planned and applied with no options, so the executor wrote
`wiki/<entityType>/<slug>.md`.

**Passing the row sink does not work, and the database says why:**

```
PostgresError: new row for relation "pages" violates check constraint
  "pages_page_directory_check"
  detail: Failing row contains (..., papers, row-only-paper, ...)
```

`wiki.pages.page_directory` admits only `concepts` and `queries`
(`src/dimensions/wiki/schema.sql:73`), and that closed set is DELIBERATE — the
schema's own comment: "a typo'd directory is rejected on write instead of becoming
a page no reader ever lists."

`entity_pages` is not the answer either. It is the KG's on-demand page cache, keyed
by `ontology_entities`, in the `public` schema, invalidated by a `graph_version`
hash of the graph. An entity page must not live in the wiki dimension at all.

**Product decision (human, this session):** no entity page in the wiki dimension.
So there is nowhere to store it on a Stack, and the honest response is a typed
refusal — `TypedPageNotRowBackedError` — rather than a file that silently diverges
from the corpus. The file-backed project is untouched and still writes the file.

### 3. `transitionLifecycle` (`lifecycle-transition.ts`)

Writes the transitioned page through `applyPageMutationLocked`, which branches to
`storeRowLocked` when a sink is present. It takes no sink, so it always writes a
file. `transitionLifecycle` takes `(root, entityType, slug, toState, evidence)` and
would need the seams threaded — a signature change at its call sites.

### 4. OKF import (`import/run.ts:76`)

`writeAll` writes each imported page with a bare `atomicWrite`. An import into a
Stack produces files and no rows.

### Relations are NOT this feature

`createRelation` appends to the relations store, not to a page. Its `atomicWrite`
absence in the table above is deliberate: a relation is not a page and has no
`wiki.pages` row. Left unchanged, and named here so its absence is not read as an
oversight.

## Design

### One resolver, called by every surface — not five hand-threaded sinks

Each of the five surfaces must NOT repeat the stack-check / open-handle /
close-handle dance, and must not each invent which options to pass. The existing
`withPageSeams(env, fn)` already resolves ALL the seams together and closes the
handle in `finally`; `review-approve.ts` already proves the pattern works in a
command context.

So the shape is uniform:

```ts
await withPageSeams(process.env, async (seams) => {
  await applyApprovedMutationsLocked(root, planned, pageStoreOptions(
    seams.sink, seams.remover, seams.transaction));
});
```

`pageStoreOptions` is the same narrow helper the compile path uses, so the mapping
from seam names to option names exists in ONE place. Building the options object by
hand at five sites is how `sink`/`pageSink` drift gets introduced.

### The returned path must stop lying

`routeDefaultPageWrite` returns a `string` path. On a Stack there is no such file.
The honest options are to return the page IDENTITY (`concepts/foo`) or to return
`null` with a different report line — but the choice changes observable CLI output,
so it is a decision for the implementation, not an assumption. What is NOT
acceptable is returning a path that was never written.

### A guard, so the next surface cannot silently regress

Threading five call sites fixes today. It does not stop the sixth. The mechanism
that makes this self-policing is a test that runs each surface against a Stack and
asserts the row exists AND no file was created — the same shape
`journal-skipped-on-rows.test.ts` already uses for "creates no `.llmwiki`".

## Explicitly not in scope

- **Relations and artifacts**: different stores, already row-backed where a Stack
  applies. Not pages.
- **`.llmwiki/**` private state** (`state.json`, journal, embeddings, lint cache):
  file-backed by design on both paths. This feature is about PAGES.
- **The provenance columns** (`confidence`, `contradictedBy`): a schema feature,
  already named in `lint-row-awareness.md`.

## Tasks

Ordered by dependency, not by importance. D2 first because it gates every
observation of the rest; D3 last because it is cosmetic once D1 is true.

| # | Task | Checks |
|---|------|--------|
| 1 | Failing test: `review approve` on a Stack reaches the write at all (exit 0) | red — measures D2 |
| 2 | Make candidate custody row-aware when a Stack is configured | focused green |
| 3 | Failing test: default page approve creates the ROW and no file | red — measures D1 |
| 4 | Wire `routeDefaultPageWrite` through `withPageSeams` | focused green |
| 5 | Failing test + wire `applyTypedCandidate` (review approve AND import callers) | red then green |
| 6 | Failing test + wire `transitionLifecycle` (seams resolved INSIDE, no signature change) | red then green |
| 7 | Failing test + wire OKF `writeAll` | red then green |
| 8 | Stop returning a path that was not written | focused green |
| 9 | Package checks | `tsc --noEmit`, `build`, `test:affected`, `fallow` |

## Acceptance

1. On a Stack, none of the five surfaces creates a file under `wiki/`.
2. Each creates the corresponding `wiki.pages` row.
3. The no-Stack path is byte-identical: frozen suites unchanged.
4. No surface reports a path it did not write.
5. `npx tsc --noEmit` clean, `npm run build` green, `npm run test:affected` green,
   `fallow` no new issues.

## Risks

- **Five surfaces, one of them shared by two callers.** `applyTypedCandidate` is
  reached from review approve AND import, so a signature change touches both.
- **`transitionLifecycle` needs the seams through a public signature.** Its callers
  are the SDK and the CLI; widening it is a visible API change, so the wiring
  should resolve the seams INSIDE `transitionLifecycle` rather than adding a
  parameter — the same choice `sources/removal.ts` made.
- **Return-value change in review approve** alters CLI output, which frozen tests
  may pin. Task 1 must establish what the existing contract is before task 5
  changes it.
- **Workload**: nine tasks across five surfaces is a large slice. It should land as
  chained commits per surface, not one review.

## Evidence

Delivered as chained work-unit commits, one per surface, each with its own test:

| Commit | Surface | Fix |
| --- | --- | --- |
| `5c913e9` | candidate custody | row-aware: FS preconditions vacuous on a Stack |
| `3d580bc` | review approve (default) | takes the sink; return value stops naming a file |
| `aa451b5` | `applyTypedCandidate` | refuses — no row can hold an entity namespace |
| `322b970` | `transitionLifecycle` | refuses before the lock, same constraint |
| `776f671` | OKF import `writeAll` | takes the sink (`concepts`/`queries` only) |

Package checks: `npx tsc --noEmit` clean · `npm run build` green ·
`npm run test:affected` 725 files / 5251 tests ·
`fallow` no issues.

`test/parity-default.test.ts` fails (3 cases) both on this branch and on `main`
with the same assertions — verified by checking `main` out and re-running. It is
pre-existing and unrelated; `test:affected` does not select it.
