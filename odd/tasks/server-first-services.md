# Server-first: one service layer for the CLI, MCP, and HTTP

## Why

The compiler was merged with a knowledge-graph service. `ingest` now writes across
two systems (filesystem + Postgres) that share no transaction manager, so the
project lock and the dimension coordinator are the only things keeping them in
sync. Every client that wants to ingest must reach that same code, or the
guarantee is void for whoever took a different path.

Today three clients diverge:

| Client | Reaches the transaction via |
| --- | --- |
| CLI | `src/commands/ingest.ts` |
| MCP | `ingestSource` / `compileAndReport` imported from the core barrel |
| HTTP | nothing — no host is even started by any command |

There is also no command that runs the unified host: `view` starts the old
viewer, `serve` is MCP over stdio, and `startHost` is reachable only from tests.

## Decision

Adopt a **shared service layer** as the single owner of each transaction, with
HTTP as a transport on top of it.

```
CLI ──────┐
MCP ──────┼──> IngestService / CompileService ──> lock + dimension coordinator
HTTP ─────┘
```

Chosen over "the CLI makes an HTTP request" because that requires a daemon: a
port, a PID, liveness detection, orphan cleanup, and a race between two CLIs
starting at once. The user's goal is one transaction path, not a daemon.

Chosen over "HTTP server is mandatory" because it breaks standalone CLI use in
scripts and CI.

## Non-goals

- Deleting the KG route suites. They are the fidelity contract measured against
  the Python oracle, not scaffolding. They move to consume services; they do not
  get removed.
- A job queue. `compile` stays synchronous and reports busy via the lock.

## Risk

`src/commands/ingest.ts` is 420 lines, over the repo's 400-line limit, and mixes
CLI presentation, source-type detection, fetching, journaling, and the
transaction. Extracting the service also fixes that overage.

## Tasks

- [x] 1. Extract `IngestService` from `src/commands/ingest.ts` — `e73099b`
- [x] 2. Extract `CompileService` from `src/compiler/index.ts` — `5453575` (the service already existed; added the `busy` signal)
- [x] 3. Point the CLI at the services — reached via re-exports
- [x] 4. Point MCP at the services — verified no bypass
- [x] 5. Mount official `POST /api/ingest` and `POST /api/compile` on the host — `468ad47`
- [x] 6. Add a `llmwiki host` command that starts the unified listener — `f543ca9`
- [x] 7. Verify KG route suites still measure fidelity through the services — 575 pass; 2 flaky under Postgres contention
