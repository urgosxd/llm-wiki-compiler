# Feature: `GET /stacks/{stack_id}/graph` — the KG render payload

## Goal

Open a read endpoint that returns the knowledge graph of **one** Stack as
node-link JSON, so a client can render it without reading four tables itself.

```
GET /stacks/{stack_id}/graph
{
  "stack_id": "8f2c…",
  "nodes": [{ "id", "label", "type", "confidence", "properties" }],
  "edges": [{ "id", "source", "target", "type", "confidence" }],
  "truncated": false
}
```

## Why it exists

The KG dimension writes `ontology_entities` and `ontology_relationships`, and the
only read path for them is `/aks/v1/*` — a 1:1 port of the Python reference
server, pinned against `oracle/contracts/openapi.json`. `/aks/v1/export` already
carries the whole Stack, but in the AKS Bundle shape (`entities[]` with a nested
`source` block, `relationships[]` keyed by `from_entity_id`/`to_entity_id`), not
in the `nodes`/`edges` shape a renderer consumes. Adapting the bundle on the
client means every consumer re-implements the same projection.

So this endpoint is the same rows, reshaped once, on the server.

## Decisions (user-selected)

| Decision | Choice |
| --- | --- |
| Direction | Server pushes the JSON; the StackId is the whole input (read-only pull) |
| Scope | Endpoint only — no wiki read door, no routing unification in this change |
| Route | `GET /stacks/{stack_id}/graph`, StackId in the path |
| Placement | Its own router mounted at `/stacks`, so `/aks/v1` keeps oracle parity |

## Non-goals

- No write path. Nothing is persisted; the graph is read from Postgres per request.
- No new `/aks/v1` route. Adding one would break the parity contract measured
  against `oracle/contracts/openapi.json` and the 422 corpus.
- No SVG/HTML rendering. The endpoint returns data; the client draws.
- No `POST` variant. A submit-and-render endpoint is a different feature.

## Constraints discovered while exploring

1. **`/stacks` already has a 405 contract.** `http-contract.ts` walks
   `app.router.stack` and reports the *first* partial match's methods. Mounting a
   second router at the same prefix keeps `PUT /stacks/<uuid>` at `allow: GET`
   because the first mount wins the partial match. Pinned by a test.
2. **Responses are validated, not hand-built.** Every read path in this package
   hands its assembled object to a Zod schema, which fixes JSON key order. This
   endpoint follows that rule.
3. **Timestamps are strings.** `db.ts` installs a `timestamptz` parser that keeps
   the microsecond text; no `Date` is constructed anywhere.
4. **RLS is bound from the caller's reference.** `resolveStack` binds
   `app.stack_id` before reading, so an unknown UUID is a 404 produced by the
   database, not by a guard.
5. **`tsc --noEmit` already reports 21 errors** in this package (unused imports
   in harness files, `unknown` narrowing in ingest tests). Unrelated to this
   change; recorded so a later green/red read is not mistaken for a regression.

## Tasks

- [x] 1. Write the failing test: route shape, key order, node/edge projection,
      truncation, 404, 422 on a bad UUID and a bad `limit`
- [x] 2. Add the read module `core/stack_graph.ts` (Zod schemas + the reads)
- [x] 3. Add the router `routes/stack_graph.ts` and mount it at `/stacks`
- [x] 4. Pin the 405 `Allow` behaviour that the second mount must not perturb
- [x] 5. Verify: `vitest related`, `tsc --noEmit`, `fallow`

## Outcome

Commit `9b18f63` on `feat/orchestrator-b`.

The endpoint shipped with two bounded query parameters the request did not name:
`min_confidence` (`[0, 1]`, default `0`) and `limit` (`[1, 2000]`, default `500`).
The default is 500 rather than the AKS entity default of 100 because a graph view
is unreadable past a few hundred nodes anyway, while 100 would truncate an
ordinary Stack on the first request. The upper bound is what keeps one response
from materializing an unbounded Stack in memory.

### Verification (scope and result reported together)

| Check | Scope | Result |
| --- | --- | --- |
| `npx vitest run` (package) | all 78 files in `packages/llmwiki-kg/ts` | 764 passed, 4 skipped, 0 failed |
| `npx vitest run src/routes/stack-graph.test.ts` | the new suite | 10 passed |
| `npx vitest run src/http-contract.test.ts` | the 405 contract | 46 passed |
| `npx tsc --noEmit` (package) | whole package | 21 errors, all pre-existing, none in the new files |
| `npm run build` | repo root | succeeded |
| `npx fallow` | repo root | no dead code, no duplication, 0 above threshold |
| `npm run test:affected` | repo root, 1203 files | 21 failed — **all pre-existing and environmental** |

The `test:affected` failures are not from this change. They are
`DimensionActivationError: LLMWIKI_DIMENSIONS enables "wiki" but AKS_STACK_ID is
not set`, an ambient-environment requirement of this worktree, and they were
measured identical with the change stashed (`8` of `8` in `test/host` and
`test/commands/host-command.test.ts`, `24` of `24` across the five CLI/quickstart
suites sampled). Zero new failures, zero fixed.

### What was deliberately left out

- No wiki read door. The asymmetry you described is real —
  `createWikiPageReader` exists and no production caller uses it — but it is a
  different dimension and would have doubled the review surface.
- No routing unification. `src/host/server.ts` still dispatches by prefix and
  `src/viewer/server.ts` still has its hand-written `if` table. That is the
  movement with the highest payoff and the highest risk, and it deserves its own
  change with its own tests.
- No `openapi.json` entry. The file under `oracle/contracts/` is the Python
  server's measured contract; adding a TypeScript-only route to it would make the
  oracle comparison lie.
