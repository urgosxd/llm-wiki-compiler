# Feature: Two-dimensional ingest (wiki + knowledge graph)

## Goal

Split ingest into two dimensions. Every ingest must write both dimensions
inside one transaction with rollback semantics:

- **wiki** — the existing `sources/` markdown write (`saveSource`).
- **kg** — the Agent Knowledge Standard knowledge graph, merged into this
  repository from `AKS-Reference-Server` and consumed **in process** (direct
  module import, not HTTP).

The KG implementation is not authored here; it is vendored from upstream and
wired so the compiler can call it.

## Decisions (user-selected)

| Decision | Choice |
| --- | --- |
| KG placement | `git subtree` into `packages/llmwiki-kg`, history preserved |
| KG consumption | In process (`import` its core), not HTTP |
| Commit guarantee | Durable two-phase **outbox** (`.llmwiki/dimensions/outbox/*.json`) + reconciler + content-hash idempotency |
| Activation | Environment: `LLMWIKI_DIMENSIONS=wiki,kg` plus `AKS_*` credentials |
| CLI | Unchanged for now; wiring behind the env switch |
| KG tests | Unified into the compiler suite, `describe.skipIf` without Postgres |
| 400-line rule | KG refactored to comply (no vendor exemption) |

## Verified constraints

These were measured, not assumed:

1. `git subtree add` works and preserves upstream history.
2. Importing the KG's `db.ts` does **not** hang the process (measured 1.4s;
   the module-level pool does not retain the event loop).
3. Importing from `src/` into `packages/llmwiki-kg/ts/src/` **fails** `tsc`
   with `TS6059: not under rootDir 'src'`. Requires a real workspace package
   plus path aliases (same pattern as `llmwiki-dev-backend`).
4. The KG ingest consolidation lives inside `routes/ingest.ts`
   (`consolidateEntityRows`, `consolidateRelationshipRows`), **not** in
   `core/`. In-process consumption requires extracting it.
5. The KG `config.ts` parses `process.env` into a module-level singleton at
   import time. It collides with the compiler's own configuration and must
   become injectable.

## Non-goals

- No new CLI surface. `ingest` keeps its current shape.
- No HTTP client. The vendored KG is called as a library.
- No change to upstream `AKS-Reference-Server`; this is a downstream copy.

---

## Wave 1 — Infrastructure (no behavior change)

- [ ] 1.1 Register `packages/llmwiki-kg/ts` as a workspace package.
- [ ] 1.2 Add the `llmwiki-kg` path alias to `tsconfig.json`.
- [ ] 1.3 Add the KG test glob and alias to `vitest.config.ts`.
- [ ] 1.4 Configure `fallow` for the vendored subtree entry points.
- [ ] 1.5 Verify `npx tsc --noEmit`, `npm run build`, `npm run test:affected`.

## Wave 2 — Make the KG consumable in process

- [ ] 2.1 Replace the `config.ts` import-time singleton with an injectable
      factory, keeping the current default for the standalone server.
- [ ] 2.2 Extract `consolidateEntityRows` / `consolidateRelationshipRows`
      from `routes/ingest.ts` into `core/`.
- [ ] 2.3 Verify the KG suite still passes.

## Wave 3 — Dimension port, transactional coordinator, outbox

- [ ] 3.1 Define the dimension port types.
- [ ] 3.2 Implement the wiki dimension over `saveSource`.
- [ ] 3.3 Implement the KG dimension over the vendored core.
- [ ] 3.4 Implement the durable outbox store.
- [ ] 3.5 Implement the transactional ingest coordinator.
- [ ] 3.6 Implement the outbox reconciler.
- [ ] 3.7 Wire `LLMWIKI_DIMENSIONS` activation.

## Wave 4 — Bring the KG under the 400-line rule

Measured offenders (non-test): `core/extraction.ts` 1292, `mcp.ts` 1042,
`routes/aks.ts` 1019, `errors.ts` 864, `core/page_generator.ts` 757,
`routes/synthesize.ts` 639, `routes/backfeed.ts` 599, `core/files.ts` 594,
`routes/ingest.ts` 586, `routes/pages.ts` 546, `routes/documents.ts` 524,
`core/llm_clients.ts` 520, `dto.ts` 421.

- [ ] 4.1 Split each offender below 400 lines with functions below 40.
- [ ] 4.2 Split the over-400 tests into multiple files.
- [ ] 4.3 Verify `fallow` reports no issues.

## Evidence log

| Task | Commit | Checks |
| --- | --- | --- |
| merge | `2a74a21` | subtree add, history preserved |
