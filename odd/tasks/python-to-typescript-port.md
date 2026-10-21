# Feature: Python → TypeScript port of the AKS Reference Server

## Intent

Port the entire Python/FastAPI reference server to TypeScript: 24 HTTP endpoints, 22 Pydantic
DTOs, 3 MCP tools, and the full Postgres/pgvector schema, preserving the HTTP contract 1:1.

The Python server stays alive during the port and acts as the **contract oracle**: each TS
slice is validated by sending the same requests to both servers and diffing the JSON.

## Non-goals

- No behavior changes, no new endpoints, no schema migrations.
- No business-logic improvements "while we're here".
- The Python implementation is deleted only after the full port verifies against the oracle.

## Decisions (user-approved)

| Decision | Value |
|---|---|
| Stack | Express 5 + Zod + Drizzle ORM + Vitest |
| Oracle | Python server runs on :8000 during the port |
| Scope | Full: `app/` + `db/` + MCP server |
| Execution | Wave 0 serial; fan-out decided after the walking skeleton verifies |
| Review strategy | One worktree + branch per slice → each slice is an independently reviewable PR |

## Constraints discovered during exploration

1. **Port conflict.** `docker-compose.yml` binds host `5432`, already held by
   `cmspatarutera-postgres-1`. Resolved with a compose override; the API reaches the DB over
   the internal network as `db:5432`, so only external tooling is affected.
2. **No `.env`.** Only `.env.example` exists. Required for the oracle and for LLM slices.
3. **No tests, no CI.** Zero automated verification exists in the base repo. All verification
   is oracle-diff plus focused Vitest suites added by this port.
4. **Hub modules.** `config.py` (8 importers), `database.py` (7), `auth.py` (7),
   `models/api.py` (all routers) are frozen in Wave 0 so later slices never conflict on them.
5. **LlamaIndex is confined to one file.** `app/core/extraction.py` is the only importer;
   its replacement is an isolated slice.
6. **pgvector is a hard dependency.** `vector(1536)`, HNSW cosine index, and `gin_trgm_ops`
   indexes live in the schema. Drizzle must model them or the schema stays raw SQL.

## Wave 0 — Walking skeleton (serial, single writer)

The goal is one real endpoint proving the whole vertical stack: env → config → pool →
Drizzle → Zod → Express → JSON response plus a Vitest suite.

### Tasks

- [x] **T0.1 — Environment and compose override.** Add `docker-compose.override.yml` remapping
      the Postgres host port off 5432, create `.env` from `.env.example`, verify the `db`
      service reaches healthy and the base Python app boots against it. Evidence: compose ps
      output plus a successful `GET /health` or equivalent.
- [x] **T0.2 — TypeScript project skeleton.** `package.json`, `tsconfig.json`, `.gitignore`
      additions for `node_modules`/`dist`, Vitest config, and the Express bootstrap with a
      single liveness route. Evidence: `npm run build` and `npm test` both green.
- [x] **T0.3 — Config module with Zod.** Mirror every env var from `.env.example` with the same
      names, defaults, and required/optional semantics as `app/core/config.py`. Fail fast at
      startup on a missing required var. Evidence: Vitest unit tests for defaults and for the
      missing-var failure path.
- [x] **T0.4 — Database pool and Drizzle schema.** `pg` pool with the same lifecycle semantics
      as `app/core/database.py`, plus a Drizzle schema covering all 8 tables and the constraints
      in `db/schema.sql`. Vector and trigram indexes stay as raw SQL if Drizzle cannot express
      them. Evidence: a connectivity test against the running compose DB.
- [x] **T0.5 — Auth middleware.** Reproduce `require_api_key` exactly: header name, accepted
      format, comparison method, status codes, and fail-open/fail-closed behavior when
      `AKS_API_KEY` is empty. Evidence: Vitest cases for every branch.
- [x] **T0.6 — All 22 DTOs in Zod.** One schema per Pydantic model with identical field names,
      optionality, defaults, constraints, and Literal enums. Evidence: a contract test asserting
      that a fixture corpus validates identically under both implementations.
- [x] **T0.7 — Stacks vertical (5 endpoints).** Full port of `app/routers/stacks.py` against the
      Drizzle layer. Evidence: oracle diff, Python vs TS, on create/list/get/patch/delete.
- [ ] **T0.8 — Oracle diff harness.** Script that replays a recorded request corpus against both
      servers and reports structural JSON differences. This is the verification tool every later
      slice depends on, so it belongs to Wave 0, not to the fan-out.
- [ ] **T0.9 — Wave 0 close.** Measure actual fan-out slices against real coupling, publish the
      slice plan with per-slice file surfaces, and request explicit approval before creating any
      worktree.

## Wave 1 — Fan-out (planned, not yet approved)

Candidates, subject to confirmation after Wave 0:

| Slice | Surface | Risk |
|---|---|---|
| documents | `routers/documents`, `core/files`, `core/aks_serializers` | low, no LLM |
| extraction | `core/extraction` (LlamaIndex replacement) | high |
| consolidation | `core/consolidation`, `routers/backfeed` | medium |
| pages | `core/page_generator`, `routers/pages`, `routers/synthesize` | medium |
| retrieval | `core/retrieval`, `routers/aks` | medium-high |

## Wave 2 — Serial

- `mcp_server` (472 lines, 3 tools, own protocol).
- `ingest` (orchestrates extraction + consolidation; depends on both existing).

## Review workload forecast

Base measured at 4,481 Python lines across 28 files. A TypeScript port is expected to land
around 5,000–6,000 lines, roughly 13–15x the 400-line review budget. Wave 0 alone is
estimated at 600–700 lines. The fan-out exists primarily to make the change reviewable
per slice, secondarily to shorten wall-clock time.

## Open questions

- None blocking Wave 0. LLM credentials are needed only when the extraction and page slices
  start; those slices will surface the requirement before writing code.

---

## Wave 0 evidence log

Measured outcomes, not estimates. Every line was verified independently of the
worker that produced the code.

| Task | Commit | Evidence |
|---|---|---|
| T0.1 | `e636a8c` | DB healthy on host 5434, 8 tables + vector/pg_trgm/pgcrypto, oracle live on 8000 |
| T0.2 | `cc798bf` | typecheck/build/test green; `/health` byte-identical to oracle |
| T0.3 | `493ec81` | 11/11 env vars verified against `.env.example` and `config.py`; fail-fast exits 1 with the oracle's exact message |
| T0.4 | `921b728` | 56/56 tests; microsecond precision verified on live DB (27 chars, 6 digits, `Z`) |
| T0.5 | `493ec81` | 401 detail identical to `auth.py` (63 chars); fail-open preserved |
| T0.6 | `c5f1e4e` | 194/194 tests; multi-field 422 (absent from corpus) matched the live oracle including order |
| T0.7 | `12e5ee7` | 208/208 tests; 7/7 live differential cases matched |

### Corrections made to the plan during Wave 0

Three assumptions I wrote into this document turned out to be wrong. They are
recorded here because the reasoning matters more than the outcome.

1. **"20 endpoints" was wrong twice.** My first count said 24 (inflated by
   multi-line decorators); the real OpenAPI says 20 paths / 28 schemas.

2. **"Pass timestamptz through untouched" was impossible.** Postgres sends
   `2026-10-21 04:00:16.902445+00`; the oracle emits
   `2026-10-21T04:00:16.902445Z`. The fix normalizes the string without ever
   building a `Date`. See `odd/findings/timestamp-precision.md`.

3. **"A transaction middleware" was not implementable.** On Express 5 `next()`
   returns `void`, so a middleware cannot observe a handler's async rejection
   and would commit failed requests. It is a route wrapper instead. Verified:
   throw → 500 + 0 rows, deliberate 404 after a write → 404 + 1 row committed.

### Known gaps carried forward

- Trailing-slash: FastAPI 307 vs Express passthrough on `/stacks/`. App-wide and
  pre-existing (`/health/` shows the same), not endpoint-specific.
- Malformed JSON: oracle 422 `json_invalid` vs Express 400 from body-parser.
- `PATCH` with explicit null on a NOT NULL column returns 500 on **both**
  servers; verified matching, so it is inherited behavior, not a regression.
- The oracle and the TS server share one database, so differential tests must
  use distinct fixture domains per target or they self-collide.
