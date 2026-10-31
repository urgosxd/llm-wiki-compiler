# Feature: Fix the two defects that kept the kg dimension switched off

## Goal

The `kg` dimension is off by default because it was not ready. Two measured
defects blocked it. Fix both, so the dimension can be turned on with a
guarantee that a failure is never silent.

## The two defects, both measured (not inferred)

Measured against the live test Postgres (`localhost:5434`) and a local fake
gateway that returns a valid tool call.

### Defect 1 — a provider failure is swallowed and reads as success

`chunkTriplets` in `packages/llmwiki-kg/ts/src/core/graph-extraction.ts` catches
every provider failure and returns "no triplets for this chunk". No log, no
counter, no error.

Measured with embeddings working and chat answering 500:

```
COMMIT SUMMARY: kg:1 chunks, 0 entities
ROWS: { docs: '1', entities: '0', chunks: '0' }
```

The commit is reported as successful, the document row is written, and the graph
is empty. That outcome is **indistinguishable** from "the document legitimately
contained no entities". An operator cannot tell a broken extraction from a
corpus with nothing to extract.

Worse, it violates the principle this codebase already applies to the ontology:
a malformed declaration fails the run rather than degrading to permissive
behaviour, precisely because "an operator who declared a schema and silently got
default extraction would believe the graph is constrained when it is not". An
empty graph believed to be populated is the same failure with a different hole.

### Defect 2 — the adapter never writes `document_chunks`

`src/dimensions/kg/index.ts` calls `chunkAndEmbed` and throws the chunks away
after extraction. The only caller of `upsertChunk` — the function that writes
`document_chunks` — is `packages/llmwiki-kg/ts/src/routes/ingest/pipeline.ts`,
which belongs to the vendored server's HTTP path, not to the dimension.

Measured:

```
READER with text: {"ok":true,"value":{"entities":[],"relationships":[],"chunks":[]}}
document_chunks rows: { n: 0 }
```

`reader.read({ text })` returns `chunks: []` **structurally**, for every query,
forever. Half the reader's advertised capability is dead in production while
reporting `ok: true` — the same lie as defect 1, wearing a different shape.

## Decisions (user-selected)

| Decision | Choice |
| --- | --- |
| Extraction failure | Retry first. When it still fails after the attempts are spent, it follows the **atomic transaction flow** — the ingest fails and nothing is committed |
| Chunk retrieval | **Cut it.** Remove `chunks` from the kg reader's contract and answer `unavailable` instead of an empty list |
| Transient vs permanent | A transient provider failure (transport error, 429, 5xx) is retried; a permanent one (401/403/400/404) is not — retrying a bad API key only delays the same answer |
| Chunk-keyed outcome | A part that fails to ingest **must not** be committed silently as a smaller graph |

## Non-goals

- **No write to `document_chunks` from the dimension.** The decision above is to
  cut the capability, not to build it.
- **No change to `ReadChunk` or `DimensionAnswer`.** Both are shared with the
  `wiki` reader, which DOES produce chunks. Removing the field would break a
  working dimension to fix a broken one.
- **No new env variable to tune retries.** The attempt count is a module
  constant, so it cannot drift between the compiler and the vendored core.
- **No change to the vendored HTTP routes.** `POST /ingest` keeps the oracle's
  per-chunk tolerance, because that path is measured against the Python server
  and changing it would break the fidelity guarantee.
- **No switch-on.** Turning `kg` on is the user's decision, made after these
  fixes land.

## Acceptance criteria

1. A chunk whose extraction fails transiently is retried, and a retry that
   succeeds yields its entities — the document is not lost to one bad response.
2. A chunk whose extraction still fails after the attempts are spent makes
   `prepare` **throw**, so the coordinator commits nothing. Measured: no
   `stack_documents` row, no entities, no partial graph.
3. A permanent provider error (401) is not retried (`toolCalls()` stays 1) and
   fails the run with a message naming the endpoint.
4. The vendored HTTP ingest path keeps its per-chunk tolerance: a chunk that
   exhausts its attempts is skipped there, not fatal.
5. `createKgReader().read({ text })` answers `ok: false` with code `unavailable`
   and a message saying the kg dimension does not serve passages — it never
   answers `ok: true` with an empty list.
6. `createWikiReader` keeps returning chunks, unchanged.
7. `npx tsc --noEmit`, `npm run build`, `npm run test:affected` and `fallow` are
   clean.

## Design

### Retry policy lives in the vendored core, not the adapter

`packages/llmwiki-kg/ts/src/core/llm/retry.ts`:

- `TRANSIENT_ATTEMPTS = 3` (one try plus two retries), asserted by a test so the
  constant cannot drift.
- `isTransientProviderFailure(error)` — true for a transport failure (an
  `LlmError` with no status) and for 429/5xx; false for any other status and for
  anything that is not an `LlmError`.
- `withProviderRetry(work)` — retries transient failures with exponential
  backoff and equal jitter, then rethrows the last error.

Placed in the core so both consumers share one policy: the dimension (fatal when
exhausted) and the HTTP pipeline (tolerant when exhausted). One policy, two
outcomes — exactly as the two paths already differ.

### Why the failure escapes only when the WHOLE document fails

The oracle tolerates one bad chunk and loses the rest of that chunk's
information. That tolerance is what makes a 40-chunk document survive one odd
response. But when EVERY chunk has failed, there is no partial result to protect:
either the provider is down or the credential is wrong, and both are conditions
the operator must see.

So the contract is:

- some chunks succeeded → commit the entities that were extracted, and report the
  failed chunk count in the commit summary so the degradation is visible;
- no chunk succeeded, and there was at least one chunk → throw.

That distinction is the difference between "a thin extraction" and "an outage",
and it is measured rather than assumed.

## Open question, deliberately not decided here

`registerDocumentRow` is the ONE write in `core/document-consolidation.ts` that
does not call `bindCallerStack`, while `consolidateEntityRows` and
`consolidateRelationshipRows` do. Measured: under the `llmwiki_app` role that
write is refused with SQLSTATE `42501`. It is harmless today because production
connects as `aks` (superuser, `BYPASSRLS`, so RLS is inert), but switching the
production connection to the app role would break document registration.

This is latent debt, not an active defect, and it is outside the two defects this
feature fixes. Recording it so it is not rediscovered from scratch.

## Evidence log

| Task | Commit | Checks |
| --- | --- | --- |
