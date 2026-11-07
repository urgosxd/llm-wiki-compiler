# Response after the COMMIT: move the transactional boundary

Feature branch `fix/response-after-commit`. Base commit `fea6291ad1456ccfb8cc964b9ef66fc9413559ba`.
The HTTP request-transaction wrapper commits AFTER the handler has already sent the response.

## Specs

S1 — Decision (verbatim). The user chose: "Mover la frontera transaccional"
in answer to: "El handler HTTP responde antes del COMMIT. Eso produce tres síntomas
distintos, bajo contención. ¿Qué hacemos?"

S2 — The defect. `createRequestTransactionWrapper`
(`packages/llmwiki-kg/ts/src/db.ts:341-358`) runs `database.transaction(handler)` where
THE HANDLER SENDS THE HTTP RESPONSE, so the COMMIT lands AFTER the client already has
its answer. A follow-up statement therefore sees pre-commit state. Observed symptoms:
a write's row not yet visible to the next statement; `23503` foreign-key violations on
`stack_documents` under contention; and an entity left `pending` because a decision
UPDATE read pre-commit state.

S3 — The change (verbatim): "COMMIT BEFORE RESPONDING". The transactional boundary
moves. Eventual consistency and patching the test amplifier are explicitly NOT options.

S4 — Every path accounted for. Every path through the wrapper is enumerated. If any
handler streams a response, commits lazily, or cannot know its final status before
sending, that case is NAMED and its handling stated — never silently excluded.

S5 — Error semantics, a deliberate contract change. Today a client can receive 200 for
a transaction that later rolls back. After this change a failed COMMIT produces an
error response, not a success. A commit failure reuses the repository's existing
server-error contract: HTTP 500, `Content-Type: text/plain`, body `Internal Server
Error`, produced by `handleError` (`packages/llmwiki-kg/ts/src/server.ts:264-273`)
through the existing `errorStatus` mapping (`server.ts:312-320`), which yields 500 for
any error carrying no numeric `status`. No new status code is introduced: the live HTTP
API already uses only 400, 404, 405, 422 and 500 (`server.ts:155`, `:249-251`,
`http-contract.ts:335`, `routes/ingest/response.ts:19`, `:264-273`), and giving a sixth
code a new meaning would be a larger contract change than the decision requires. This is
documented as a BEHAVIOUR CHANGE, not a bug fix: callers that used to receive a success
for a rolled-back write now receive an error.

S6 — Rollback on error preserved. A handler that throws must still roll back and return
today's error shape. The write-then-throw case is named explicitly rather than left
implicit: today a handler that sends its response and THEN throws leaves the client
holding the success while the transaction rolls back silently; after this change nothing
is committed and the client receives the error response instead. That difference is a
deliberate consequence of moving the boundary and is documented as such.

S7 — No long-held transactions. This repository already forbids holding a database
transaction open across a long external call (classifier or extractor). If moving the
commit would force a transaction to span such a call, STOP and report the conflict;
that rule is not negotiable and this change must not undo it.

S8 — Byte-for-byte bodies. Response bodies are preserved byte-for-byte for every
endpoint. The only permitted differences are the ordering against the commit and the
new commit-failure response.

S9 — Tests. (a) After the client receives a 200, an INDEPENDENT follow-up statement
must observe the committed row, proven through the public interface. (b) A commit
failure yields an error response with the documented code and shape and leaves no
committed row. (c) A handler that throws still rolls back and returns today's error
shape. (d) Every endpoint the wrapper serves returns the same body as before for the
same input: a differential check comparing old and new implementations on the base
commit in a `mktemp -d` scratch copy (never committed). Any unrequested difference is
a regression to fix and pin with a test. RED is demonstrated before GREEN, and the
central assertion is proven to bite by reverting the ordering and showing it fail.

S10 — Process. One writer at a time: the git index, `dist/` and `node_modules/` are
single resources. `rm`, `rm -rf`, `git clean`, `git checkout --`, `git restore` and
`git stash` are forbidden; stop and report instead of seeking approval for a
destructive step. Revert probes are done by inverse edit, never checkout. Scratch stays
on disk and is listed in the report. `--no-verify` is never used.

S11 — Gates, each with exact scope and every non-run named: `npx tsc --noEmit`,
`npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit`, `npm run typecheck:tests`
(baseline is NOT regenerated), `npm run typecheck:kg`, `npm run build`,
`npm run test:affected`, `npm test`, `./node_modules/.bin/fallow`. `.fallowrc.json`
ignores `packages/llmwiki-kg/**`, so a clean fallow result is never coverage of that
package.

S12 — Delivery. No push, rebase, merge or integration. The report states the full
40-character HEAD SHA and proves `fea6291ad1456ccfb8cc964b9ef66fc9413559ba` is an
ancestor of it.

## Tasks

| ID | What | Specs | Commit |
| --- | --- | --- | --- |
| T1 | Feature document | — | uncommitted |
| T2 | Enumerate every path through the wrapper with `path:line` evidence | S4 | uncommitted |
| T3 | Design the boundary move and its commit-failure error semantics | S3, S5, S6, S7 | uncommitted |
| T4 | RED tests: post-200 independent visibility, commit failure, preserved rollback | S9 | uncommitted |
| T5 | Implement the transactional boundary move | S3, S5, S6, S8 | uncommitted |
| T6 | Document the behaviour change | S5 | pending |
| T7 | Differential check against `fea6291` in a `mktemp -d` scratch copy | S8, S9(d) | uncommitted |
| T8 | Gates | S11 | pending |
| T9 | Contention AFTER measurement on the integrated tree — not run here; argument by construction only | S2, S9 | pending |
| T10 | Ingest success path: answer only after the third transaction commits (authorized option (a)) | S3, S5, S9 | uncommitted |
| T11 | Ingest early-exit responses (`:532`, 404/415) still written inside a read transaction — NOT authorized, reported only | S2, S7 | not implemented |
| T12 | S44 violations on `POST /aks/v1/context` and `POST /stacks/:stackId/synthesize-descriptions` — pre-existing, NOT fixed here, reported to the Manager | S7 | not implemented |

## Log

L1 — The user's request, verbatim: "Mover la frontera transaccional"
— en respuesta a: "El handler HTTP responde antes del COMMIT. Eso produce tres
síntomas distintos, bajo contención. ¿Qué hacemos?"

L2 — Defect located. The wrapper is `createRequestTransactionWrapper` at
`packages/llmwiki-kg/ts/src/db.ts:341-358`. There is no root `src/db.ts` (verified: file
absent; the package file is 394 lines).

L3 — Path census. Every endpoint served by the wrapper writes its response INSIDE the
transaction callback: `routes/stacks.ts:281` (POST /stacks), `:299` (GET /stacks), `:428`
(GET /stacks/:id), `:448` (PATCH /stacks/:id), `:502` (DELETE /stacks/:id),
`routes/documents/upload.ts:250` (POST .../documents), `routes/documents/delete.ts:87`
(DELETE .../documents/:doc_id), `routes/ingest/pipeline.ts:506` (POST .../ingest), plus
the reclassify and classification-log prune routers. No wrapped handler registers
`res.on('finish')`, `res.on('close')`, `res.on('drain')`, `setImmediate` or
`queueMicrotask`, so nothing depends on the response being flushed mid-transaction.

L4 — Streaming case named. `GET /aks/v1/pages` responds through `sendArchive`
(`routes/pages/all-pages.ts:72-77`): `res.status(200)`, two `setHeader` calls,
`res.write(archive)`, `res.end()`, where `archive` is an already-materialised `Buffer`.
It is not progressive streaming, so deferring the response loses nothing there; the
case is not excluded from the change.

L5 — Design decision: defer the response. The handler writes to a fail-closed recording
response; when the handler resolves the transaction commits; only then are the recorded
calls replayed, in order, on the real `Response`, so the body is produced by the same
Express calls as before. The rejected alternative was committing at the first write: it
keeps streaming intact, but it converts a write-then-throw from a rollback into a
commit, which is the worse failure.

L6 — Long-transaction rule holds. Ingest deliberately splits its work across three short
transactions and keeps the provider/classifier stages outside them
(`routes/ingest/pipeline.ts:479-508` and its docstring), so moving the commit does not
force a transaction to span a long external call.

L7 — The long-transaction rule, and where this branch stands on it. Primary form, under the heading
`### One attempt, one transaction` in `odd/tasks/ingest-atomicity.md:99-101`: "`prepare` stays outside
the transaction. It runs `chunkAndEmbed` and `extractGraphFromChunks`, which are seconds of provider
latency; holding a Postgres transaction open across them would pin a connection and invite timeouts."
Restated under `### What does NOT change` in `odd/tasks/kg-atomic-ingest-proposal.md:196-199`. Enforced
in code as rule id S44: `packages/llmwiki-kg/ts/src/routes/ingest/wiring.ts:26` — "Refusing to keep a
database transaction open across classifier calls (S44)."

The ingest pipeline honours it: provider stages run outside its three short transactions, and the
response write was synchronous (`routes/ingest/pipeline.ts:506` before this branch).

CORRECTION — an earlier version of this entry claimed "the wrapped handler's transaction still contains
only database work". That claim was FALSE. Two endpoints served by the request wrapper DO hold their
transaction open across provider calls:
- `POST /aks/v1/context`: `routes/aks.ts:68 deps.wrap(contextQuery)`, and inside that handler
  `routes/aks/context.ts:363 await embedQuery(...)` and `:382 await complete(prompt, 1024)` — both
  outbound HTTP (`core/llm/embeddings.ts:110`, `core/llm/complete.ts:65`) — with `res.json` at `:435`
  in the same handler.
- `POST /stacks/:stackId/synthesize-descriptions`: `routes/synthesize/router.ts:52 deps.wrap(backfillStack)`
  and `routes/synthesize/description.ts:227 await complete(...)` once per candidate, writing with the
  same `tx` at `:237`.
Both are PRE-EXISTING at base `fea6291`: those route files are byte-identical to base. This branch
neither introduces nor fixes them. It does not lengthen the transaction — `database.transaction` spans
exactly the handler in both versions — but on those two endpoints the client now waits for a COMMIT that
follows an LLM call, so their response latency worsens rather than improves. Remediating S44 on those
two endpoints is NOT part of this change.

L8 — Response surface, enumerated. Wrapped handlers call `res.status`, `res.json`, `res.end`,
`res.setHeader`, `res.write`, and read `res.statusCode` and `res.headersSent`. No wrapped handler
registers `res.on` or `res.once`: every `res.on(` hit in the tree is the test client's response in
`routes/pages-pages.test.ts` and `routes/pages-gateway.test.ts`. `res.type(` has no hits. The single
live `res.write(` is `routes/pages/all-pages.ts:76`, inside the wrapped `getAllPages`, and its payload
is an already-materialised `Buffer`. The recorder therefore covers the union of what handlers call and
register, and fails closed on anything else.

L9 — What the move closes, stated precisely. For the 24 endpoints served by the request wrapper — 25
`deps.wrap(` registration sites, the one non-route site being `routes/ingest/router.ts:100`, reached
only when `deps.run` is absent, i.e. in tests — the
invariant now holds: no client observes a success before that transaction COMMITs. It does NOT
extend to three routes, verified at `routes/ingest/router.ts:94-103` and `:144-161`:

- `POST /stacks/:stackId/documents/:doc_id/ingest` bypasses the wrapper in production. `wrap` is used
  only when `deps.run === undefined` (`:94`), while `DEFAULT_DEPENDENCIES` sets
  `run: withTransaction` (`:72`) and `createApp()` supplies no overrides (`server.ts:241`,
  `:297-301`). Production therefore takes the `:103` branch and writes the 200 at
  `ingest/pipeline.ts:506` from inside the callback passed to `run` at `:544`, whose COMMIT lands only
  after that callback resolves (`db.ts:286-290`). **The `23503` ingest window is NOT closed by this
  change.**
- `POST /stacks/:stackId/reclassify` and `POST /stacks/:stackId/classification-log/prune` receive no
  `wrap` at all (`:144-161`). Their responses are written in a `.then()` after the runner resolves
  (`reclassify/router.ts:146`, `classification-log/router.ts:233`), so they already commit before
  responding and are unaffected either way.

`odd/tasks/reach-test.md:389-398` remains the pre-existing statement of the ingest race. This branch
does not claim to fix it. Widening the change to the ingest boundary is a scope decision that was put
to the Manager and is not taken here.

L10 — Differential result, with its limits. Two trees in `mktemp -d`
(`/tmp/wrapper-diff.gAlCBt/base` from `git archive fea6291ad…`, and `/tmp/wrapper-diff.gAlCBt/new`
from the working tree) ran one byte-identical probe through the real `createApp` plus
`createRequestTransactionWrapper` over the 22 endpoints that could be stood up deterministically (the
wrapper serves 24; 2 were skipped, below): 50 records, 50 identical,
0 differing, reproduced across two run pairs, with a base-vs-base control also 50/50 identical.
Headers were compared after dropping `date`, `etag`, `connection` and `keep-alive`; `/aks/v1/pages`
was compared on entry names and normalised entry content because its README embeds a wall-clock
timestamp. Two endpoints were SKIPPED: `POST /aks/v1/context` (the 200 branch issues a real LLM call)
and the ingest endpoint (needs extraction and embedding stubs). An ingest comparison that was skipped
cannot support any ingest claim.

L11 — Authorization and implementation of the ingest success path, with the review that followed. The
Manager relayed the human's decision: option (a), success path only. Implemented in
`routes/ingest/pipeline.ts`: `finishIngest` drops its `res` parameter and returns the parsed payload
built inside the transaction, and `ingestDocument` writes the response after the third `run(...)` at
`:544` resolves, i.e. after that transaction COMMITs. File length unchanged, 694 -> 694. The runner in
`db.ts` and `routes/request.ts` were not touched.
RED before GREEN: the new test `routes/ingest/ingest-response-boundary.test.ts` failed with "the client
already had status 200 while the last transaction's COMMIT was gated"; after the change it passes and
asserts status, content type and the body parsed through `IngestionResult`.
Two independent reviewers then ran. Their material findings, all acted on in the same delivery:
- The ingest test could false-pass, because its hold window was measured from request start rather than
  from gate engagement. Fixed: the gated runner now signals engagement and the assertion depends on that
  signal. Re-proved by inverse edit (response put back inside the transaction -> test fails), restored by
  inverse edit with a matching `git diff` hash.
- The recorder module had no direct test for its fail-closed branches, its `statusCode`/`headersSent`
  model, or its `on`/`once` deferral.
- A mid-replay failure after headers were sent was swallowed by the wrapper's `headersSent` guard,
  leaving a truncated response; the recorder now terminates the response and rethrows.
- The module header justified modelling `headersSent` by naming three routers that branch on it, but
  those routers run unwrapped on the real response and never receive the recorder. The justification was
  corrected rather than the modelling removed.
Known gaps this change does NOT close, named rather than implied: the ingest early-exit at
`routes/ingest/pipeline.ts:532` (`loadIngestInput` -> `sendDocumentNotFound`, `readDocumentText`) still
writes 404/415 responses from inside a read transaction; `routes/documents/delete.ts:78` unlinks the
file inside the transaction, so a failed COMMIT now answers 500 with the bytes already deleted and the
row rolled back; and the two S44 violations recorded in L7.
