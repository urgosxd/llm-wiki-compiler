# Architecture Decisions

This document records the design decisions made for the **AKS reference server**. Each decision is recorded as a short ADR (Architecture Decision Record): context, decision, and consequences.

For decisions about the AKS specification itself (terminology, schema shape, endpoint design), see `DECISIONS.md` in the [aks-spec](https://github.com/aks-standard/aks-spec) repository. The decisions below are about the *implementation*, not the spec.

---

## ADR-0001: FastAPI as the web framework

**Status:** Accepted

**Context.** The reference server needs to be readable, modern, and demonstrate good Python practices for an AKS implementation. The major options were FastAPI, Litestar, Flask + extensions, and Django REST Framework.

**Decision.** Use FastAPI.

**Consequences.** FastAPI provides automatic OpenAPI generation, native Pydantic integration, and first-class async support — all of which align with what an AKS implementation needs (typed schemas, async DB calls, machine-readable API docs). The trade-off is that FastAPI is opinionated about dependency injection; we lean into that rather than fight it. Litestar would have worked as well but has a smaller ecosystem; Flask would have required more boilerplate; DRF is sync-first and would have made async DB access awkward.

---

## ADR-0002: PostgreSQL with pgvector for storage

**Status:** Accepted

**Context.** AKS requires storing typed entities, typed relationships, structured pages, source records, run records, and vector embeddings. Options include a dedicated graph DB (Neo4j), a dedicated vector DB (Pinecone, Weaviate, Qdrant), or PostgreSQL with extensions.

**Decision.** Use PostgreSQL with the pgvector extension. Store the graph as adjacency tables, not in a graph-native DB.

**Consequences.** One database means one operational story. Postgres handles transactional writes, JSON-typed fields for flexible schema, full-text search via trigram indexes, and vector similarity via pgvector — all in a single system anyone can run locally. The cost: graph traversal queries are recursive CTEs rather than native graph queries, which is slower for very deep traversals. For the depths AKS targets (typically 1–3 hops), this is not a meaningful constraint. Avoiding a managed vector service also keeps the reference server vendor-neutral, which matters for a *reference* implementation.

---

## ADR-0003: Async-first throughout

**Status:** Accepted

**Context.** SQLAlchemy 2.0 supports both sync and async. Mixing them in one codebase is painful.

**Decision.** Use async everywhere — `asyncpg` driver, `AsyncSession`, async route handlers. The only sync code is Alembic migrations and the health probe.

**Consequences.** Higher I/O concurrency and better performance under load with no extra threads. The trade-off is that some libraries (notably some embedding providers' sync SDKs) need to be wrapped or replaced. Two `DATABASE_URL` env vars are required — one async (`postgresql+asyncpg://`) for the app, one sync (`postgresql://`) for Alembic and probes — which is a known papercut.

---

## ADR-0004: Flat layered architecture for the reference server

**Status:** Accepted

**Context.** A reference implementation should demonstrate the spec clearly. Code legibility is the primary product attribute — readers should be able to clone the server, run it, and follow a feature end-to-end without learning a layered abstraction first.

**Decision.** Three flat layers:
routers/     HTTP endpoints, request/response validation
core/        Business logic and database access mixed together
psycopg2     Raw SQL with RealDictCursor, no ORM

Functions in `core/` both compute logic AND execute SQL. There is no separate service or DAL layer.

**Consequences.** The reference server stays small and readable. A reader can understand a feature end-to-end in one or two files. The reference server is intentionally unsuitable for direct production use — implementations with substantial business logic, multi-tenancy, or team workflows should choose an architecture appropriate to those concerns.  The reference server's purpose is to be a clear, minimal, and correct demonstration of the AKS spec, not to be a production-ready architecture template. The trade-off is that some patterns (e.g., raw SQL in business logic) are not ideal for large codebases but serve the goal of simplicity here.

---

## ADR-0005: Pydantic v2 for all request and response schemas

**Status:** Accepted

**Context.** AKS defines its schemas in JSON Schema (`SCHEMA.json`). The server needs to validate inbound requests and serialize outbound responses against that schema.

**Decision.** Mirror every AKS schema as a Pydantic v2 model in `aks_server/schemas/`. Generate JSON Schema from those models in CI and diff against the canonical `SCHEMA.json` from the spec repo. Fail the build on drift.

**Consequences.** Single source of truth for types within the server, automatic validation at the HTTP boundary, and a mechanical check that we have not silently diverged from the spec. The drift check is slightly expensive to maintain but catches every silent schema regression.

---

## ADR-0006: Alembic for schema migrations

**Status:** Accepted

**Context.** Standard options are Alembic, raw SQL files with a runner, or schema-managed-by-ORM (e.g., `Base.metadata.create_all`).

**Decision.** Alembic, with autogenerate as the starting point but every migration reviewed and edited by hand before merge.

**Consequences.** Reproducible schema across environments, downgrade paths, and a clear audit trail. Autogenerated migrations are reviewed because Alembic occasionally misses constraint changes or generates suboptimal SQL. `Base.metadata.create_all` is convenient but unsafe for any production-adjacent use; raw SQL migrations are reproducible but lose Alembic's dependency tracking.

---

## ADR-0007: Hybrid retrieval with geometric mean scoring

**Status:** Accepted

**Context.** The `/aks/v1/context` endpoint must rank entities against a free-form query. Vector similarity alone is fuzzy on names and acronyms. Trigram similarity alone is rigid on paraphrases. Recency matters for stacks that change over time.

**Decision.** Compute three scores in `[0, 1]` — vector similarity, trigram similarity, and a recency boost — and combine them with a geometric mean. Return all three components in `score_components` so consumers can see why a result ranked where it did.

**Consequences.** The geometric mean is unforgiving — a near-zero in any component pulls the total toward zero. This is the desired behavior: a result needs to be reasonable on every dimension to rank, not just dominant on one. The arithmetic mean rewarded results that were excellent on one axis and useless on others. The components being exposed in the response makes the scoring debuggable in production and during conformance testing.

---

## ADR-0008: 500-entity hard cap per query

**Status:** Accepted

**Context.** Without a cap, a malformed pagination call or a wide filter can return tens of thousands of entities, blowing memory and downstream context windows.

**Decision.** Cap `limit` at 500 in the `/aks/v1/entities` endpoint. The default page size is 100. Requests exceeding the cap are silently clamped, with the actual returned count visible in the response.

**Consequences.** Predictable memory usage and response times. Clients that need more than 500 entities must paginate. The trade-off: clients sometimes want one big call. We considered a higher cap (5,000) but settled on 500 as the threshold beyond which clients should genuinely be paginating, not making one giant request. I wonder where this came from, but claude and me didnt have any kind of chat about it... unless I'm forgetting something... 

---

## ADR-0009: Optional bearer token authentication, no auth by default

**Status:** Accepted

**Context.** A reference server should be runnable in 30 seconds with `docker compose up`. Mandatory auth defeats that. But shipping with no auth at all sets a bad example for implementers who copy this codebase.

**Decision.** If `API_BEARER_TOKEN` is set in the environment, all `/aks/v1/*` endpoints require `Authorization: Bearer <token>`. If unset, endpoints are open. The OpenAPI spec reflects which mode is active.

**Consequences.** Friction-free local development; a clear path to enabling auth for any deployment that needs it. Production AKS-aware platforms (which need real multi-tenant auth) should not deploy this server as-is — auth is implementation-specific and out of scope for a *reference* server. This is documented prominently in the README.

---

## ADR-0010: Apache 2.0 license

**Status:** Accepted

**Context.** The AKS spec is Apache 2.0. The reference server could be Apache 2.0, MIT, or AGPL.

**Decision.** Match the spec: Apache 2.0.

**Consequences.** Vendors building proprietary AKS-aware platforms can copy patterns from this codebase without legal friction. This serves the goal of broad spec adoption. AGPL would force every implementer to open-source their fork, which is appropriate for a product but inappropriate for a reference implementation whose purpose is to be copied. Production AKS-compliant systems (e.g., ThoughtFoundry) may adopt stricter licenses for their full platforms while remaining spec-compliant.

---

## Decisions deferred

The following have been raised but explicitly deferred until post-1.0:

- **Caching layer.** Redis or in-memory LRU for hot context queries. Deferred until benchmarks identify a real hot path.
- **Background workers.** Celery, ARQ, or RQ for backfeed processing. The current implementation processes backfeed synchronously, which is fine at reference-server scale.
- **Multi-stack federation.** Cross-stack queries via an alignment layer. This is a beyond the scope, and not a reference-server concern for now.
- **Embedding provider abstraction.** Currently the sample loader uses a single provider. A pluggable interface would be useful but isn't required for spec conformance. Uhh... I need to verify this... 
