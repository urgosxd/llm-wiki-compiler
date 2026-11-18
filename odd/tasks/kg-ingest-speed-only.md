# kg-ingest-speed-only

Branch: `perf/kg-ingest-speed-only`

Performance-only branch. Speed is the sole variable this branch is allowed to move.

## Specs

- **S1** — Governing constraint: "no alterar el algoritmo solo queremos velocidad"
- **S2** — Acceptance criterion: "For the same input document, the extracted result must be IDENTICAL before and after." and "Same entities, same relationships, same chunk boundaries, same prompts, same per-chunk calls — a byte-identical graph, proven by comparing the output of the old code and the new on one fixture document."
- **S3** — What disqualifies an optimisation: "If an optimisation changes any extracted entity, any relationship, or how many chunks a document yields, it is out of scope — even if it is faster and looks better." and "Speed is the only variable this branch is allowed to move."
- **S4** — Item 1, `dryRun` and the spend cap: "Wire `dryRun` so a run can report what it WOULD send without sending it, and add a cap that refuses rather than truncating silently." and "House pattern for the cap: a `readTimeoutEnv`-style parser, a named default constant, a documented resolution chain and a test pinning each rejection — empty, non-numeric, zero, negative." and "Refusing loudly beats truncating: a run that extracts half a document and reports success is the defect class this repository keeps finding."
- **S5** — Item 2, chunk-hash skip: "Hash each chunk and skip the ones whose hash is already extracted for that source, so a second ingest of the same content costs almost nothing." and "a hash that fails to notice a real content change is a correctness bug, not an optimisation — pin it in both directions (same content skips, one changed character re-extracts that chunk)" and "the skip must be reported in the per-dimension outcome once the reporting branch lands, so a skipped chunk is never indistinguishable from a failed one."
- **S6** — Item 3, lock narrowing: "Extract OUTSIDE the mutation lock, commit INSIDE it" and "both dimensions still commit in ONE transaction or none does." and "Do not split the transaction to win the lock."
- **S7** — Required measurement, per item: "Report per item: wall clock, number of provider requests, number of chunks, a hash of the extracted graph, and the mutation lock's hold duration." and "A speed claim without the request count is a claim about the network, not about the code."
- **S8** — Non-negotiables: "Every premise above carries a fresh `path:line`, marked confirmed or contradicted." and "No `--no-verify`, no rebase, nothing pushed." and "Full 40-char SHAs." and "Do not touch the `KNOWN_DIMENSIONS` order, the transaction boundary, or any route's dimension composition."
- **S9** — Explicitly out of scope: "No batching of chunks into one request." and "No change to prompts, chunk size, chunking, the selection budget, or the model." and "No bounded parallelism yet. That is the fourth item and it comes after these three, with its own measured cap."
- **S10** — Manager's reframing of item 1: "`dryRun` must short-circuit in `prepare`, before `chunkAndEmbed` and before `extractGraphFromChunks`." and "the report must state what it WOULD have sent — chunks, requests — because a dry run that says only "ok" has learned nothing."
- **S11** — Manager's narrowing of item 3: "Lock around wiki's prepare plus both commits; run ONLY the kg provider-bound prepare outside it." and "Name the flag for what it asserts: that a dimension's `prepare` has no effect the mutation lock protects. A boolean named after the invariant, not after the dimension." and "state the invariant in the type's doc comment, because the flag is a promise every future dimension must keep: a lock-free `prepare` must allocate nothing that `commit` later writes."

## Tasks

- [ ] T1 — Build the measurement harness (wall clock, provider request count, chunk count, graph hash, lock hold duration) and record the baseline for the current code | S7, S2 | route: worker | commit: pending
- [ ] T2 — Make `dryRun` short-circuit in `prepare` before the embedding and extraction calls, and report would-be chunk and request counts | S4, S10 | route: worker | commit: pending
- [ ] T3 — Add the spend cap with a `readTimeoutEnv`-style parser, named default constant, documented resolution chain, and a refusal error; pin empty, non-numeric, zero and negative | S4 | route: worker | commit: pending
- [ ] T4 — Skip chunks whose content hash was already extracted for that source, reusing `document_chunks.content_hash`, with no migration unless one is proven necessary | S5, S2 | route: worker | commit: pending
- [ ] T5 — Report reused-versus-extracted chunk counts in the per-dimension outcome so a skip is never indistinguishable from a failure | S5 | route: worker | commit: pending
- [ ] T6 — Narrow the mutation lock to wiki's prepare plus both commits via a dimension contract flag asserting a lock-free `prepare` allocates nothing that `commit` writes | S6, S11 | route: worker | commit: pending
- [ ] T7 — Prove the narrowing: measured lock hold duration before and after, a test that two concurrent same-stack ingests still serialise, and the existing slug-suffix test unchanged | S6, S7 | route: verify | commit: pending

## Deferred (named, not in this branch)

- `resolveFreeSlug` allocates from an unlocked read (`packages/wiki/src/dimensions/wiki/store-dimension.ts:191-222`) and `commit` writes that slug without re-reading it (`:327-355`).
- The `on conflict … do update set … source_identity = excluded.source_identity` clause turns a slug collision into a SILENT OVERWRITE of another source's page — destroyed data, and no error is raised.
- The mutation lock is the ONLY thing preventing it: `lockKeyFor` = `stackIdOf(env) ?? realpath(root)`, so same-stack ingests serialise.
- No test catches it: `test/dimensions/wiki-store-dimension.test.ts:189-198` is sequential and keeps passing.
- Re-validating the slug inside the commit transaction is the real fix and is out of scope for a branch whose only variable is speed. Any change that relaxes or narrows the mutation lock — per-document locking, parallel dimension prepares, a shorter hold — makes this live data loss, and this must be fixed BEFORE that change lands.
- A chunk-hash skip keyed on chunk text alone ignores the prompt, model and ontology. If any of those change, a stale extraction is silently reused. Prompts, model and ontology are frozen on this branch, which is why text-only hashing is acceptable here and only here.

## Log

**L1** — human's original request:

Performance work on the KG ingest. The human's constraint is absolute and it is the first line of the spec: "no alterar el algoritmo solo queremos velocidad" — do not change the algorithm, we only want speed.

Acceptance: for the same input document, the extracted result must be IDENTICAL before and after — same entities, same relationships, same chunk boundaries, same prompts, same per-chunk calls — a byte-identical graph, proven by comparing the output of the old code and the new on one fixture document. If an optimisation changes any extracted entity, any relationship, or how many chunks a document yields, it is out of scope — even if it is faster and looks better. Speed is the only variable this branch is allowed to move.

Three items, in this order: (1) wire `dryRun` and add a spend cap, before any speed work; (2) do not re-extract chunks that did not change; (3) extract outside the mutation lock, commit inside it.

**L2** — premise verification correction: the brief said nothing consumes `dryRun`; mechanically pinned with `grep -n` it is declared once at `packages/wiki/src/dimensions/kg/index.ts:177` and read at `:695` (in `commit`) and `:725` (in `forget`), while `prepare` (`:643-691`) contains no `dryRun` reference at all. So a dry run performs the paid `chunkAndEmbed` (`:666`) and `extractGraphFromChunks` (`:677`) calls and only then skips the write. Record that the brief's "NOTHING consumes it" was contradicted and that the real defect is a dry run that spends the full budget and reports success.

**L3** — premise verification correction: the brief placed the `prepare` call at `coordinator.ts:324`; it is `prepareEveryDimension` defined at `:319`, its prepare call at `:325`, invoked at `:414`, outside any transaction, and `commit` at `:187` inside `db.transaction` opened `:181`. Record the correction rather than the original numbers.

**L4** — premise verification: extraction is one chat request per chunk, sequential, at `packages/llmwiki-kg/ts/src/core/graph-extraction.ts:543-546` with the provider call at `:544`; no per-run request cap exists. The lock is at `packages/wiki/src/services/ingest/service.ts:255`. Both confirmed.

**L5** — Manager direction: item 1 is reframed from "wire a flag" to "stop a flag that lies", and moves to the front of the branch because it is the only item that spends money while claiming not to.

**L6** — Manager direction: item 3 is narrowed to the kg dimension only, because wiki's `prepare` allocates a slug from an unlocked read; the fan-out is not to be generalised and the slug race is not to be resolved on this branch. The per-dimension contract flag is authorised with `Risk: item 3`.

**L7** — evidence: the kg commit path is additive on re-ingest, so a chunk skip can leave the graph byte-identical. Relationships upsert with `greatest(confidence, excluded.confidence)` (`packages/llmwiki-kg/ts/src/core/document-consolidation.ts:440-450`), `entity_source_documents` is `on conflict … do nothing` (`:210-211`), and the only `delete from stack_documents` (`:569`) is reached through `forget`, not `commit`. No pass prunes entities against the current chunk set. `document_chunks.content_hash` is declared at `packages/llmwiki-kg/db/schema.sql:97-105` and written at `packages/llmwiki-kg/ts/src/routes/ingest/pipeline.ts:638-643`, and is never read to drive a skip. The only existing skip is document-level on `source_hash` in the HTTP upload route (`packages/llmwiki-kg/ts/src/routes/documents/upload.ts:130-141`), a different entry point from the dimension coordinator.

**L8** — constraint recorded: `packages/foundation/src/dimensions-port.ts:69` documents that `kgDryRun` is deliberately absent from the dimensions port, which constrains where the dry-run work can be wired.
