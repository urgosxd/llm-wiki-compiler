# AKS Reference Server

The reference implementation of the **Agent Knowledge Standard (AKS)** — an open spec for compiled domain knowledge that any AI agent or tool can query through a standard interface.

This server is for people who read the spec and want to see what those words actually mean — and for anyone who wants to run their own AKS-conformant knowledge layer locally or on their own infrastructure. It implements every concept in AKS: Knowledge Stacks, AKS Bundles, hybrid retrieval, entity pages, backfeed, and MCP integration. Run it, ingest some documents, query it from Claude Desktop, export a portable Bundle, and you've got compiled domain knowledge you control end to end.

The code is intentionally small and well-commented. Each major component is isolated to one file (LlamaIndex lives in `extraction.py`, only). Forking, extending, and replacing pieces is meant to be straightforward.

## Table of contents

- [Quick start](#quick-start)
- [One Stack or many?](#one-stack-or-many)
- [What you can do with it](#what-you-can-do-with-it)
- [Endpoint reference](#endpoint-reference)
- [LLM provider configuration](#llm-provider-configuration)
- [MCP integration with Claude Desktop](#mcp-integration-with-claude-desktop)
- [Architecture](#architecture)
- [Design decisions](#design-decisions)
- [Database schema](#database-schema)
- [Common operations](#common-operations)
- [Troubleshooting](#troubleshooting)
- [Extending the reference server](#extending-the-reference-server)
- [Scope](#scope)
- [Contributing](#contributing)
- [License](#license)

---

## Quick start

### Prerequisites

- Docker and Docker Compose (`docker compose version` should work)
- An OpenAI API key for embeddings
- An Anthropic API key for entity extraction
- About 500 MB of free disk space for the Postgres image and dependencies

Optionally, an OpenAI-compatible LLM gateway (LiteLLM, Portkey, or any internal/company gateway) can replace either or both providers. See [LLM provider configuration](#llm-provider-configuration).

### Run the server

```bash
git clone https://github.com/YOUR-USERNAME/aks-reference-server.git
cd aks-reference-server
cp .env.example .env
```

Open `.env` in your editor. At minimum, set:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

Then bring it up:

```bash
docker compose up --build
```

First build pulls the Postgres-with-pgvector image and installs Python deps. Expect 2-3 minutes. Subsequent starts take seconds.

When you see `Application startup complete.` and a line starting with `[AKS] Inference:`, the server is ready at `http://localhost:8000`.

Interactive API docs: `http://localhost:8000/docs`
Health check: `http://localhost:8000/health`

### Five-minute end-to-end test

Open a second terminal (leave the first one running the containers).

**1. Create a Stack:**

```bash
curl -X POST http://localhost:8000/stacks \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Stack", "domain": "test-stack"}'
```

Note the `id` field in the response. Save it for later steps.

**2. Make a test document:**

```bash
cat > /tmp/runbook.md << 'EOF'
# Incident Response Runbook

When a service produces a P1 incident, the on-call engineer is paged
through the monitoring system. The on-call engineer must acknowledge
the page within 5 minutes. The first task is to determine whether the
incident was caused by a recent deployment.

If the incident is caused by a deployment, the on-call engineer initiates
a rollback. The rollback procedure reverts the offending change and
restores service to the previous known-good version. Every rollback
generates a postmortem document within 48 hours.

The postmortem includes a timeline, a root cause analysis, and a list
of remediation actions. Remediation actions are tracked in the engineering
backlog and reviewed at the weekly engineering retrospective.
EOF
```

**3. Upload it (use your stack id):**

```bash
export STACK_ID=<paste-stack-id-here>

curl -X POST http://localhost:8000/stacks/$STACK_ID/documents \
  -F "file=@/tmp/runbook.md"
```

Note the document `id` from the response.

**4. Compile it:**

```bash
export DOC_ID=<paste-document-id-here>

curl -X POST http://localhost:8000/stacks/$STACK_ID/documents/$DOC_ID/ingest
```

This is the slow step (15-30 seconds). It runs the full LLM pipeline. The response shows how many chunks were created, how many entities and relationships were extracted.

**5. Query it in natural language:**

```bash
curl -X POST http://localhost:8000/aks/v1/context \
  -H "Content-Type: application/json" \
  -d '{
    "query": "what does the on-call engineer do during a P1?",
    "domain": "test-stack"
  }' | python -m json.tool
```

The response includes the relevant entities, their relationships, the model's reasoning for selecting them, and a confidence rating.

**6. Generate an entity page:**

```bash
curl "http://localhost:8000/aks/v1/pages/Rollback?domain=test-stack" \
  | python -c "import json, sys; print(json.load(sys.stdin)['markdown'])"
```

Returns a wiki-style markdown page synthesized from the compiled graph.

**7. Export the whole Stack as an AKS Bundle:**

```bash
curl "http://localhost:8000/aks/v1/export?domain=test-stack" > bundle.json
```

`bundle.json` is now a portable AKS Bundle that conforms to the spec's `SCHEMA.json`. Any AKS-aware tool can import this and have the same compiled knowledge.

That's the whole pipeline. Documents go in, structured queryable knowledge comes out, portable bundle goes wherever you need it.

---

## One Stack or many?

The server is **partitioning-agnostic**. It gives you Stacks as a primitive and lets you decide how to slice the world. Two patterns work, and you pick based on your queries.

### One Stack — everything in it

Best when your queries don't have clear domain boundaries. Examples:

- A personal knowledge base mixing notes, reference docs, and project files
- A small team's shared documentation where everyone reads everything
- A research project where the connections between subjects matter as much as the subjects themselves

Pros: zero routing logic, every query has access to everything, cross-domain connections surface naturally in the graph. Hybrid retrieval handles topic mixing reasonably well.

Cons: as the Stack grows, retrieval may surface less-relevant chunks. Description quality can suffer when the domain context is too broad — a Stack mixing medical and engineering documents produces vague descriptions because there's no coherent vocabulary.

### Multiple Stacks — user picks which to query

Best when your knowledge has natural ownership boundaries. Examples:

- An organization where the engineering team's docs and the customer support team's docs serve different audiences
- Multiple projects where each has its own vocabulary and the cross-pollination is intentional rather than automatic
- A homelab where each Stack covers a separate hobby or system

Pros: each Stack stays focused, descriptions are domain-aware, retrieval is precise, governance per-Stack is straightforward.

Cons: the user (or the MCP client) has to know which Stack to query. Cross-Stack questions require querying each Stack separately. There's no automatic merging.

Practical recommendation: start with one Stack. If retrieval quality drops as you grow, or if you find yourself wanting different governance per topic, split into multiple. The MCP integration handles multi-Stack routing naturally — your client (Claude Desktop, an agent, etc.) can call `list_stacks` and pick the right one based on the query.

---

## What you can do with it

| Capability | Endpoint(s) | Notes |
|---|---|---|
| Create and manage Stacks | `/stacks` (CRUD) | Each Stack is one compiled knowledge domain |
| Upload documents | `POST /stacks/{id}/documents` | Hash-deduplicated; same content uploaded twice returns the same record |
| Compile documents into knowledge | `POST /stacks/{id}/documents/{doc_id}/ingest` | Runs the LLM pipeline; idempotent on re-ingestion |
| Optionally synthesize rich descriptions | Stack setting or `?synthesize_descriptions=true` | One LLM call per entity. Off by default. |
| List or filter compiled entities | `GET /aks/v1/entities` | Filter by type, confidence, scope |
| Traverse the knowledge graph | `GET /aks/v1/traverse` | BFS from a starting entity, follows typed relationships |
| Natural-language query | `POST /aks/v1/context` | Hybrid retrieval + one LLM call to identify relevant entities |
| Export as AKS Bundle | `GET /aks/v1/export` | Spec-conformant JSON; verifies against SCHEMA.json |
| Generate human-readable entity pages | `GET /aks/v1/pages/{name}` | Wiki-style markdown, cached by graph version |
| Download all pages as a zip | `GET /aks/v1/pages` | Useful for documentation snapshots |
| Backfill descriptions for existing entities | `POST /stacks/{id}/synthesize-descriptions` | One-shot or filtered |
| Submit a proposed change for review | `POST /aks/v1/backfeed/flag` | The spec's writeback path |
| Review and approve queued changes | `GET /aks/v1/backfeed/queue` then `/approve` | Approved items absorb with `verified=true` |
| Query from Claude Desktop, Claude Code | MCP server | Four MCP tools wrap the AKS query surface |

---

## Endpoint reference

### Stack management

```
POST   /stacks                            create a Stack
GET    /stacks                            list all Stacks
GET    /stacks/{stack_id}                 fetch one
PATCH  /stacks/{stack_id}                 partial update
DELETE /stacks/{stack_id}                 delete (cascades to all data)
```

### Documents

```
POST   /stacks/{stack_id}/documents              upload (multipart/form-data)
GET    /stacks/{stack_id}/documents              list documents in a Stack
GET    /documents/{doc_id}                       fetch one
DELETE /documents/{doc_id}                       delete (and remove file on disk)
POST   /stacks/{stack_id}/documents/{doc_id}/ingest    run the compilation pipeline
```

### AKS query interface (the spec-conformant surface)

```
GET    /aks/v1/entities                          list, filter by type/confidence
GET    /aks/v1/entities/{name}                   single entity by exact name
GET    /aks/v1/traverse                          BFS from a starting entity
POST   /aks/v1/context                           natural-language query
GET    /aks/v1/export                            full Stack as AKS Bundle
```

All accept either `?stack_id=<uuid>` or `?domain=<slug>`.

### Entity pages

```
GET    /aks/v1/pages/{entity_name}               markdown page for one entity
GET    /aks/v1/pages                             zip of all pages in a Stack
```

### Description synthesis (backfill)

```
POST   /stacks/{stack_id}/synthesize-descriptions             backfill many
POST   /aks/v1/entities/{name}/synthesize-description         backfill one
```

### Backfeed (writeback loop)

```
POST   /aks/v1/backfeed/flag                     queue a proposed change
GET    /aks/v1/backfeed/queue                    list items, filterable by status
GET    /aks/v1/backfeed/{item_id}                fetch one item
POST   /aks/v1/backfeed/approve                  approve and absorb into ontology
POST   /aks/v1/backfeed/reject                   mark rejected, do not absorb
```

Full request/response schemas with examples are auto-generated at `http://localhost:8000/docs`.

---

## LLM provider configuration

The server uses a **provider-based** configuration model. You pick what you want (an embedding model, an extraction model) and where the traffic should go (openai, anthropic, or gateway). Two settings drive everything.

### The two knobs

```bash
EMBEDDING_PROVIDER=openai       # openai | gateway
EXTRACTION_PROVIDER=anthropic   # anthropic | openai | gateway
```

Set these in `.env`. The defaults are direct OpenAI for embeddings and direct Anthropic for extraction — what most users running locally will want.

### Three usage patterns

**Personal use, direct providers (default):**

```bash
EMBEDDING_PROVIDER=openai
EXTRACTION_PROVIDER=anthropic
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

**Everything through a gateway:**

```bash
EMBEDDING_PROVIDER=gateway
EXTRACTION_PROVIDER=gateway
GATEWAY_URL=https://gateway.example.com/v1
GATEWAY_API_KEY=gateway-token
```

**Mixed mode (gateway for embeddings, direct Anthropic for extraction):**

```bash
EMBEDDING_PROVIDER=gateway
EXTRACTION_PROVIDER=anthropic
GATEWAY_URL=https://gateway.example.com/v1
GATEWAY_API_KEY=gateway-token
ANTHROPIC_API_KEY=sk-ant-...
```

The startup log line `[AKS] Inference:` tells you which mode is active.

### Why this design

The gateway must present an OpenAI-compatible API. This is a deliberate constraint — every modern LLM gateway (LiteLLM, Portkey, Cloudflare AI Gateway, Azure OpenAI, vLLM, Ollama, internal gateways) speaks the OpenAI dialect. Pinning to that one shape keeps the integration trivial. If you're proxying Anthropic traffic, the gateway translates internally.

Provider validation runs at startup. If you say `EXTRACTION_PROVIDER=anthropic` but `ANTHROPIC_API_KEY` is empty, the server refuses to start with a clear error. Misconfigurations fail at boot, not on the first request.

### Cost model

For typical text documents:

| Operation | Cost (rough) | Notes |
|---|---|---|
| Embedding (per document) | $0.0001 - $0.001 | OpenAI text-embedding-3-small at $0.02/1M tokens |
| Entity extraction (per document) | $0.05 - $0.30 | Claude Sonnet, 1 LLM call per chunk |
| Description synthesis (optional) | $0.01 - $0.02 per entity | Off by default |
| Entity page generation | $0.01 - $0.03 per entity | Cached by graph version, paid once |
| Context query | ~$0.001 - $0.01 | One LLM call per query |
| Traversal, entity list | $0 | Pure SQL, no LLM |

A small Stack (10 documents, 50 entities) costs about $1 to fully compile and a few cents per ongoing query. A large Stack (500 documents, 5000 entities) costs about $50 to compile end-to-end with rich descriptions on.

---

## MCP integration with Claude Desktop

The server includes a separate MCP (Model Context Protocol) server that exposes the AKS query endpoints as tools. Once configured, Claude Desktop can query your compiled knowledge as part of its normal reasoning.

### What the MCP server exposes

| Tool | Wraps | Use when |
|---|---|---|
| `list_stacks` | `GET /stacks` | "What do I have available?" |
| `query_stack` | `POST /aks/v1/context` | Natural-language questions |
| `traverse_stack` | `GET /aks/v1/traverse` | "Show me the neighborhood around X" |
| `get_entities` | `GET /aks/v1/entities` | Inventory, type filtering |

### Configuration (Linux)

Open `~/.config/Claude/claude_desktop_config.json`. If it doesn't exist, create it. Add:

```json
{
  "mcpServers": {
    "aks": {
      "command": "/absolute/path/to/aks-reference-server/.venv/bin/python",
      "args": ["-m", "app.mcp_server"],
      "cwd": "/absolute/path/to/aks-reference-server",
      "env": {
        "PYTHONPATH": "/absolute/path/to/aks-reference-server",
        "AKS_BASE_URL": "http://localhost:8000",
        "AKS_API_KEY": ""
      }
    }
  }
}
```

Replace the paths with your actual filesystem paths. macOS uses `~/Library/Application Support/Claude/claude_desktop_config.json`. Windows uses `%APPDATA%\Claude\claude_desktop_config.json`.

The MCP server runs on your host, not inside Docker. Install its dependencies in your venv:

```bash
cd aks-reference-server
python -m venv .venv     # if you haven't already
source .venv/bin/activate
pip install mcp httpx
```

The MCP server makes HTTP calls to the AKS server (which runs in Docker), so the Docker stack must be up.

Fully quit and reopen Claude Desktop after editing the config. In a new conversation, click the tools icon — you should see `aks` with four tools.

### Using it from Claude Desktop

Just ask in natural language:

> "What Stacks do I have on my AKS server?"
>
> "Query the test-stack Stack for what happens after a P1 incident."
>
> "Traverse from On-Call Engineer in the test-stack Stack with depth 2."
>
> "List all Process-type entities in the runbooks Stack."

Claude reads the tool descriptions, picks the right tool, fills in the parameters from your message, and summarizes the response. If you have multiple Stacks, name the relevant domain in your message — the server doesn't auto-route.

---

## Architecture

The server is intentionally split into small, single-purpose files. Each major external dependency (LlamaIndex, Postgres, the LLM SDKs) is isolated to one place.

```
app/
├── main.py                      FastAPI entry point and lifespan hooks
├── mcp_server.py                Standalone MCP server (separate process)
│
├── core/
│   ├── config.py                Provider-based configuration
│   ├── llm_clients.py           Provider abstraction (OpenAI / Anthropic / gateway)
│   ├── database.py              Postgres connection management
│   ├── auth.py                  Optional API key middleware
│   ├── constants.py             Tuning knobs (chunk size, char limits)
│   ├── files.py                 Hash + storage helpers
│   ├── extraction.py            LlamaIndex pipeline (only file that imports it)
│   ├── consolidation.py         Ontology merge logic
│   ├── retrieval.py             Hybrid scoring SQL
│   ├── stack_resolver.py        stack_id/domain lookup helper
│   ├── aks_serializers.py       Row -> AKSEntity reshaping
│   └── page_generator.py        Entity page generation with caching
│
├── routers/
│   ├── stacks.py                Stack CRUD
│   ├── documents.py             Document upload and storage
│   ├── ingest.py                Compilation pipeline endpoint
│   ├── aks.py                   AKS-conformant query endpoints
│   ├── pages.py                 Entity page endpoints
│   ├── synthesize.py            Description backfill
│   └── backfeed.py              Human-review writeback
│
└── models/api.py                Pydantic request/response models

db/
└── schema.sql                   Postgres schema (8 tables)

docker-compose.yml               Two services: db (Postgres + pgvector) and api
Dockerfile                       Python 3.13 slim, FastAPI + uvicorn
requirements.txt                 Pinned dependency versions
.env.example                     Template for local config
```

### Request flow for an ingestion

```
HTTP request
    │
    ▼
routers/ingest.py
    │
    ├── verify document exists (database.py)
    ├── read file from disk (files.py)
    ├── chunk + embed (extraction.py → llm_clients.py → OpenAI/gateway)
    ├── persist chunks (raw SQL)
    ├── extract entities (extraction.py → LlamaIndex → llm_clients.py)
    ├── (optional) synthesize descriptions (extraction.py → llm_clients.py)
    ├── consolidate entities (consolidation.py)
    └── consolidate relationships (consolidation.py)
    │
    ▼
HTTP response
```

LlamaIndex appears in exactly one file. The LLM SDKs appear in exactly one file. Postgres connection management is in exactly one file. None of those concerns leak into the routers or the rest of the application.

---

## Design decisions

This section explains the why behind specific choices. If you're trying to understand the server deeply, or considering modifying it, this is the section to read carefully.

### Chunking: 1024 tokens, 200-token overlap, sentence boundaries

**Default:** `SentenceSplitter(chunk_size=1024, chunk_overlap=200)`

The 1024-token chunk size is large enough that related entities co-occur in the same chunk most of the time, which matters for relationship extraction (the LLM can only relate entities it sees together). It's small enough that the LLM stays focused on one coherent passage at a time, which keeps extraction quality high. Larger chunks increase LLM cost per call without proportionate gains in extraction quality; smaller chunks fragment relationships across chunk boundaries.

The 200-token overlap (~15%) catches relationships that would otherwise span a chunk boundary. Without overlap, an entity introduced at the end of one chunk and used at the start of the next gets two disconnected mentions instead of one connected description.

The sentence boundary respect (versus fixed character splits) keeps chunks linguistically coherent. Splitting mid-sentence produces chunks that read like garbage to the LLM, which hurts extraction quality.

For markdown with strong heading structure, a `MarkdownNodeParser` would produce cleaner chunks aligned to sections. For code, a tree-sitter AST splitter would respect function/class boundaries. Both are easy swaps in `extraction.py` if your corpus has structure worth respecting.

### Embedding: OpenAI text-embedding-3-small, 1536 dimensions

**Default model:** `text-embedding-3-small` (1536 dims).

This model is cheap (~$0.02/1M tokens), fast, and produces high-quality vectors for semantic search. The 1536-dim size strikes a reasonable balance: small enough that pgvector's HNSW index stays fast even at millions of chunks, large enough that nuanced semantic similarity is preserved.

Alternatives:

- `text-embedding-3-large` (3072 dims) — better quality but 2x storage and slower index lookups
- `voyage-2`, `voyage-large-2` — sometimes better than OpenAI for retrieval-specific tasks
- Local models via `sentence-transformers` — free, slower, no API dependency

To switch models, update `EMBEDDING_MODEL` and `EMBEDDING_DIM` in `.env`, then update the `vector(1536)` column type in `db/schema.sql` to match the new dimension. pgvector enforces dimension at the column level, so dropping the database is required after a model swap.

### The HNSW index for vector similarity

```sql
create index idx_chunks_embedding
    on document_chunks
    using hnsw (embedding vector_cosine_ops);
```

HNSW (Hierarchical Navigable Small Worlds) is the approximate-nearest-neighbor algorithm pgvector uses. It answers "find the 10 most similar vectors to this one" in roughly logarithmic time instead of linear. Without it, similarity queries scan every row in the table; with it, queries stay fast even at millions of chunks.

The tradeoff is that HNSW returns approximate nearest neighbors, not exact ones. For semantic similarity that's fine — there's no objectively "correct" answer to "what's most similar to this query." For applications requiring exact nearest-neighbor (rare), you'd switch to IVFFlat or skip the index entirely.

### Hybrid retrieval: geometric mean of vector and trigram, with recency boost

This is the most consequential design decision in the server. The `/aks/v1/context` endpoint uses this scoring formula:

```
score = sqrt(vector_similarity * trigram_similarity) * recency_multiplier
```

**Why hybrid.** Vector similarity (semantic) and trigram similarity (textual) catch different things. Vector retrieval finds chunks that mean something similar even when wording differs ("incident escalation" matches "elevating a critical issue"). Trigram retrieval finds chunks containing the same words even when meaning differs ("rollback" matches "rollback procedure"). Used alone, each surfaces irrelevant results: vector retrieval brings back semantically adjacent fluff, trigram retrieval brings back keyword matches that aren't actually relevant.

**Why geometric mean specifically.** A geometric mean penalizes results where one signal is weak, much more aggressively than an arithmetic mean would. If a chunk scores 0.9 on vector but 0.1 on trigram, the arithmetic mean is 0.5 (still ranks high). The geometric mean is `sqrt(0.9 * 0.1) = 0.3` (correctly demoted). This is the property you want — you want chunks that BOTH look semantically relevant AND mention the right words.

**The short-query fallback.** Trigram similarity scores poorly on queries under 12 characters because there aren't enough trigrams to compare. The SQL applies a neutral 0.5 in that case rather than letting trigram drag the geometric mean to zero. Without this, all short queries would return nothing useful.

**Recency multiplier.** A soft decay from 1.0 (just-ingested) to 0.85 (one year old). Old chunks still surface; they just lose a small edge against newer ones. This is intentional — knowledge ages, but old documentation isn't worthless. A multiplicative decay rather than a hard cutoff means you can't accidentally exclude relevant older content.

```sql
recency_mult = 0.85 + 0.15 * exp(-age_days / 365)
```

The whole hybrid retrieval is one SQL query against indexed columns. The geometric mean math happens in Postgres. Even at hundreds of thousands of chunks, retrieval is sub-second.

### Why /context uses only one LLM call

The `/context` endpoint receives a natural-language query and returns the relevant subgraph. Naive implementations would have the LLM read all the matching chunks and reason about them — many LLM calls, expensive at scale.

The server does the expensive part (semantic search) in pure SQL via hybrid retrieval. The LLM is asked exactly one question: "given these matching chunks and this entity catalog, which entities are relevant to the query?" It returns a structured JSON list of entity names. The server then looks up those entities and their relationships from the database.

Total LLM cost per query: about $0.001-$0.01 with Claude Sonnet. At scale this is the difference between affordable and unaffordable.

### Why traversal and entity listing have no LLM at all

`/aks/v1/traverse` and `/aks/v1/entities` are pure SQL. The compiled ontology is structured data — walking from Incident to Rollback through typed relationships is a graph operation, not a reasoning operation.

This is the entire point of compiling. Pay the LLM cost once at ingestion. After that, queries against the compiled state should be cheap and structured. If you're tempted to add LLM reasoning to these endpoints, ask first whether the cost belongs in ingestion (where it pays off many times) instead.

### Why descriptions are off by default and opt-in

When a document is ingested, every extracted entity gets `description=""` by default. The optional `synthesize_entity_descriptions` pass synthesizes 2-4 sentence descriptions per entity using the LLM, given the source chunks and sibling entity names as context. This produces rich, domain-aware descriptions but adds one LLM call per entity (roughly $0.01-$0.02 each).

Three control surfaces make the behavior explicit:

1. **Stack-level default** (`synthesize_descriptions` column): off when a Stack is created, can be flipped on
2. **Per-call override** (`?synthesize_descriptions=true|false`): wins over the Stack default
3. **Backfill endpoints**: synthesize after the fact, all entities or specific ones, all-empty or full regeneration

The default is off because surprising users with LLM bills is a worse experience than letting them opt in when they want richer output. The endpoints are documented enough that the cost is explicit.

### Why entity pages are derived from the graph, not the source documents

This is the AKS spec's hard rule. Entity pages get generated from the compiled ontology (the entity's data, its relationships, the list of contributing documents) rather than the raw source chunks. Three reasons:

1. **Domain awareness.** The LLM writing the page sees the entity's neighbors in the graph and can write a description that references them naturally.
2. **Reflecting consolidated truth.** The graph holds the merged understanding from all contributing documents. A page generated from the graph reflects what the Stack knows; a page generated from one document reflects only what that document said.
3. **Bundle portability.** A Bundle should be self-contained: another tool should be able to import a Bundle and generate entity pages from it without needing the original source documents. If page generation depended on the raw chunks, the Bundle wouldn't carry everything needed.

If you want richer pages that include source passages, the cleanest extension is the rich descriptions feature already built in. Use that to populate `entity.description` with grounded prose at ingestion time. Then page generation has rich material to work with.

### Why graph_version (not timestamps) drives the entity page cache

Entity pages are expensive to generate (one LLM call per page). You want them cached. But time-based cache invalidation can't catch the case where a related entity changes — a page about "Incident" should regenerate if a new relationship to "Postmortem" gets added, even if "Incident" itself didn't change.

Each cached page is keyed by a `graph_version` hash that includes the entity's data plus its relationships plus its contributing documents. When any of those change, the hash changes, and the next request regenerates from scratch. Time-based caches can't do this.

The hash function uses sorted relationship lists and sorted document IDs so that the same graph state always produces the same hash regardless of query order. Determinism matters — non-deterministic hashes would produce false cache misses.

### Why backfeed has no LLM

Backfeed is the human-review writeback path. An agent run produces an output that should be absorbed into the ontology. A user flags a missing concept. Either way, the proposed change arrives as a structured payload (entities to add, relationships to add). There's nothing for the LLM to do.

The reasoning happened before the item reached the queue (in the agent run, in the human review). The Stack just absorbs the result. Approved items get `verified = true` and `source_kind = "backfeed"`, which makes them eligible for scope graduation per the AKS spec.

This is the closing of the loop the spec describes. Documents flow in via ingestion. Knowledge gets compiled. Agents reason over the compiled graph. Their outputs flow back through backfeed. Approved items strengthen the graph. The Stack compounds with use, not just with content.

### Why LlamaIndex is fully isolated

LlamaIndex appears in exactly one file: `app/core/extraction.py`. The rest of the codebase never imports it. The two public functions (`chunk_and_embed` and `extract_graph_from_chunks`) plus four dataclasses (`ChunkResult`, `ExtractedEntity`, `ExtractedRelationship`, `ExtractionResult`) are the entire surface other modules see.

This is a deliberate tradeoff. LlamaIndex moves fast and breaks compatibility frequently between versions. By isolating it, every upgrade is a one-file change instead of a refactor. Replacing LlamaIndex with LangChain, Instructor, or a hand-written extractor is also a one-file change.

### Why we chose Postgres over a graph database

Multiple AKS implementations could choose Neo4j, ArangoDB, JanusGraph, or any other graph-native database. This server uses Postgres with pgvector and pg_trgm. Why?

1. **Operational familiarity.** Most teams running this server already run Postgres. Adding a separate graph database adds operational complexity that isn't justified by the workload.
2. **The graph is small and shallow.** Typical AKS Stacks have hundreds to thousands of entities, not millions. Recursive CTEs in Postgres handle BFS traversal at this scale fine. Graph databases earn their keep when you need millions of nodes and deep traversal.
3. **Vector and text similarity in the same database.** pgvector and pg_trgm let us do hybrid retrieval as one SQL query against indexed columns. Splitting these into separate stores would introduce coordination complexity for marginal gains.
4. **Single source of truth for transactions.** When a backfeed item is approved, we update entities, relationships, the queue item, and metadata atomically. With multiple stores, you'd need a saga or two-phase commit.

For a Stack with ten million entities and complex multi-hop traversal, you'd want a graph database. For a Stack with five thousand entities and 2-3 hop traversal, Postgres is the right choice.

### Why we use raw SQL instead of an ORM

The server uses `psycopg2` directly with `RealDictCursor`. No SQLAlchemy, no ORM models for the Postgres tables. Why?

1. **The schema is small (8 tables) and stable.** ORMs earn their keep on schemas with dozens of tables and complex relationships. At this scale the abstraction adds more friction than it removes.
2. **The queries are not standard CRUD.** The hybrid retrieval query, the recursive CTE for traversal, the consolidation UPSERTs — these are SQL-native operations that ORMs make harder, not easier.
3. **Reading the code is reading the data flow.** When the SQL is right there in the router, you can see exactly what the database is doing. ORM abstractions hide this.

The downside is more boilerplate per endpoint. The upside is that nothing about the data flow is hidden.

---

## Database schema

Eight tables, defined in `db/schema.sql`:

| Table | Purpose |
|---|---|
| `stacks` | Top-level container; one Stack = one compiled domain |
| `stack_documents` | Uploaded documents with hash, size, truncation flags |
| `document_chunks` | Chunks with embeddings (pgvector) and trigram-indexed content |
| `ontology_entities` | Compiled entities with confidence, type, description |
| `ontology_relationships` | Typed directed edges between entities |
| `entity_source_documents` | Many-to-many: which documents contributed to each entity |
| `entity_pages` | Cached generated markdown pages, keyed by graph_version |
| `backfeed_queue` | Pending and processed human-review items |

Foreign keys cascade on delete. Deleting a Stack removes all its documents, chunks, entities, relationships, pages, and queue items in one operation.

### Indexes

Most tables have only the unique-key indexes you'd expect. Two indexes earn their keep specifically:

```sql
create index idx_chunks_embedding
    on document_chunks
    using hnsw (embedding vector_cosine_ops);

create index idx_chunks_content_trgm
    on document_chunks
    using gin (content gin_trgm_ops);
```

The HNSW index makes vector similarity sub-second at scale. The GIN trigram index makes text similarity scoring fast. Together they're what makes hybrid retrieval affordable.

---

## Common operations

### Watch logs

```bash
docker compose logs -f api          # follow API logs (Ctrl+C to stop)
docker compose logs db | tail -50   # last 50 db lines
```

### Open a Postgres shell

```bash
docker compose exec db psql -U aks -d aks
```

Useful psql commands once inside:

```
\dt                        -- list tables
\d ontology_entities       -- describe a table
\dx                        -- list extensions
\q                         -- quit
```

### Drop the database completely (start fresh)

```bash
docker compose down -v
docker compose up --build
```

The `-v` removes the named volume containing all database data.

### Apply a schema change without losing data

```bash
docker compose exec db psql -U aks -d aks -f /docker-entrypoint-initdb.d/schema.sql
```

This re-runs `schema.sql`. Existing tables with `if not exists` are skipped. New tables and indexes are created. **Does not** add columns to existing tables — for column additions, use a manual `ALTER TABLE` or drop the volume.

### Drop into the Python REPL inside the container

```bash
docker compose exec api python
```

Useful for poking at modules without going through HTTP. For example:

```python
>>> from uuid import uuid4
>>> from app.core.extraction import chunk_and_embed
>>> chunks = chunk_and_embed("Some test text", uuid4(), uuid4())
>>> len(chunks), len(chunks[0].embedding)
```

### Restart just the API after a code change

Files in `app/` are mounted into the container and uvicorn watches them with `--reload`. Save the file and the server restarts itself. If reload gets stuck:

```bash
docker compose restart api
```

For dependency changes (anything in `requirements.txt`), a rebuild is required:

```bash
docker compose up --build
```

### Run validation on an exported Bundle

```bash
pip install jsonschema
curl "http://localhost:8000/aks/v1/export?domain=test-stack" > bundle.json
python -c "
import json, jsonschema
schema = json.load(open('SCHEMA.json'))
bundle = json.load(open('bundle.json'))
jsonschema.validate(bundle, schema)
print('Valid AKS Bundle')
"
```

(`SCHEMA.json` lives in the AKS spec repo.)

---

## Troubleshooting

### `column "X" of relation "Y" does not exist`

The database has a stale schema. The volume was created before you added the column.

```bash
docker compose down -v
docker compose up --build
```

### `service "db" is not running`

The db container isn't up. Diagnose:

```bash
docker compose ps
docker compose logs db
```

If port 5432 is taken by another Postgres on your machine, either stop it or change the port mapping in `docker-compose.yml`.

### `openai.AuthenticationError: 401`

Your OpenAI API key isn't reaching the container.

```bash
docker compose exec api env | grep OPENAI
```

If empty: either `.env` doesn't have a real key, or `docker-compose.yml` doesn't pass it through (look for `OPENAI_API_KEY: ${OPENAI_API_KEY:-}` in the api service's `environment:` block).

### `port is already allocated`

Something on your host already uses port 5432 or 8000.

```bash
sudo lsof -i :8000     # or :5432
```

Either stop the conflicting process or change the port mapping in `docker-compose.yml`.

### MCP tools don't show up in Claude Desktop

Check the MCP log:

```bash
cat ~/.config/Claude/logs/mcp-server-aks.log
```

Common causes:
- `no configuration file provided: not found` — Docker can't find `docker-compose.yml`. Add a `cwd` field in your Claude config, or switch to running the MCP server directly on your host (recommended)
- `ModuleNotFoundError: app` — `PYTHONPATH` isn't set correctly. Add it to the `env` block in your Claude config
- `command not found` — the path in `command` doesn't exist. Use the full absolute path to the venv's Python

### The REPL paste is mangling multi-line code

Some terminals choke on multi-line pastes. Easiest workaround: drop into a bash shell and use a heredoc to write a temporary script.

```bash
docker compose exec api bash
cat > /tmp/test.py << 'EOF'
# your python code here
EOF
python /tmp/test.py
```

---

## Extending the reference server

The architecture is set up to make extension straightforward. A few common extensions and where to make them:

**Add a new file format** (PDF, DOCX, HTML). The format-specific text extraction belongs in `app/core/files.py` (or a new `app/core/text_extractors.py`). The ingestion router calls `try_decode_as_text()` near the top — replace that with format detection and route to the right extractor. The rest of the pipeline doesn't need to change because chunks are text regardless of source format.

**Swap the extraction backend.** All LlamaIndex usage lives in `app/core/extraction.py`. Replace that file's two public functions (`chunk_and_embed`, `extract_graph_from_chunks`) and four dataclasses with a different implementation. LangChain, Instructor (pydantic-based structured output), and direct Anthropic-SDK extractors are all reasonable alternatives.

**Add a new chunking strategy.** The `_build_splitter()` function in `extraction.py` is the only place that constructs the chunker. Add a strategy parameter to the public functions if you want per-call control, or set it via env var if you want it deployment-wide.

**Use a different embedding model.** Update `EMBEDDING_MODEL` and `EMBEDDING_DIM` in `.env`, then change the `vector(1536)` column in `db/schema.sql` to match. pgvector enforces dimension at the column level. After the model swap, drop the database (`docker compose down -v`) so the new column dimension applies on rebuild.

**Add format-specific entity types.** The default extractor uses generic types (PERSON, EVENT, CONCEPT). To get domain-specific types (Process, Role, System, Document), pass `possible_entities` and `possible_relations` to `SchemaLLMPathExtractor` in `extraction.py`. A small number of constrained types usually produces a more useful ontology than fully unconstrained extraction.

**Background ingestion.** Currently ingestion runs synchronously in the request thread. To push it to a background queue: add Celery or RQ, change the ingest endpoint to enqueue a job and return a job ID, add a new endpoint to poll job status. The compilation pipeline itself doesn't need to change — only the orchestration around it.

**A new MCP tool.** Wrap any AKS endpoint as an MCP tool by adding a Tool definition to `list_tools()` in `mcp_server.py`, a routing branch in `call_tool()`, and an implementation function. About 30 lines per tool. Pages, Bundle export, and ingestion status are all reasonable candidates.

**Multi-user support.** The `auth.py` module currently does API-key auth (single user). For multi-user: replace it with JWT validation, add a `users` table, attach `user_id` to Stacks, document_chunks, etc., enforce per-user isolation in every router. This is a meaningful refactor — be aware of what you're taking on.

**Per-Stack pipeline configuration.** Add columns to the `stacks` table for chunking strategy, chunk size, embedding model, etc. Update `extraction.py` to read per-Stack config rather than global config. Lock the embedding model after first ingestion to prevent dimension mismatches.

For deeper changes (sharded deployment, replication, multi-tenant SaaS), the AKS spec is the contract — anything that respects the spec's API surface is conformant, no matter how the server is rearchitected internally.

---

## Scope

The server is deliberately kept simple to demonstrate the spec clearly. A few things that are intentionally out of scope:

- **Production deployment patterns.** No clustering, replication, failover, or horizontal scaling out of the box. A single server handles small to medium workloads fine; production deployments need more.
- **Multi-user, RBAC, and tenancy.** Authentication is a single optional API key. For per-user permissions and multi-tenant isolation, you'll need to extend `auth.py` and add user-scoping to every relevant router.
- **Connector framework.** Documents are uploaded directly via HTTP. Continuous ingestion from Slack, Jira, Notion, Drive, etc. is not built in.
- **Federation across multiple Stacks.** The server gives you Stacks as a primitive but doesn't provide automatic query routing, cross-Stack merging, or composition logic. The user (or the MCP client) picks which Stack to query.
- **Format support beyond UTF-8 text.** PDF, DOCX, HTML, etc. need to be plugged in (see [extending](#extending-the-reference-server)).
- **Synchronous ingestion.** Compilation runs in the request thread. For long documents or high throughput, push to a background queue.

These are real gaps for production use. They're also opportunities — if you're building tools on top of AKS, this is where you add value. The reference server is a starting point, not an end product.

---

## Contributing

Contributions are welcome. Especially valuable:

- Bug reports with reproduction steps
- Documentation improvements
- New extraction backends (LangChain, Instructor, hand-written prompts)
- New chunking strategies (markdown-aware, code-aware)
- New embedding providers (Voyage, sentence-transformers, etc.)
- Format extractors (PDF, DOCX, HTML)
- MCP tool additions
- Test harnesses and benchmark integrations

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

Apache 2.0. See [LICENSE](LICENSE).

The AKS spec itself is also Apache 2.0, governed by an open community process. See the [spec repository](hhttps://github.com/Agent-Knowledge-Standard/AKS-Specification) for governance details.

---

## Related

- **[AKS Specification](https://github.com/Agent-Knowledge-Standard/AKS-Specification)** — the open spec this server implements
- The spec repo also tracks other AKS implementations and tools built on the standard