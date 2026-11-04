# KG dimension: reuse the wiki dimension's provider credentials

Branch `feat-kg-shared-provider-credentials`, base `2c42ef3`. Enabling the `kg` dimension dies against the embedding provider before it reaches the database, because the vendored core reads its own provider namespace and never sees the settings llmwiki already resolves. This document is the specification for the bridge, its precedence order, and its fail-closed rules.

## Specs

### S1 — The authorized request

The request that authorizes this feature, quoted verbatim and unsummarized:

> 2 usa las mismas credenciales de la dimension wiki en la dimension KG

Its scope: one credential source for both dimensions, no duplicated configuration. Non-goals, binding: do not redesign the KG's embedding client, do not add a new provider, do not change which providers llmwiki supports. Extraction is in scope: the same mechanism, with the same precedence, supplies the kg dimension's extraction endpoint, credential and model from the provider the wiki dimension resolved. Only an embedding credential would be half the credentials the request names.

### S2 — Credential bridge

When a KG-namespace variable is ABSENT, the kg dimension resolves that value from the variables the wiki dimension already uses. Per-variable order, first present value wins:

| KG variable | 1st | 2nd | 3rd | fallback |
| --- | --- | --- | --- | --- |
| `EMBEDDING_PROVIDER` | `EMBEDDING_PROVIDER` | `gateway`, derived when `W` is `openai` and the wiki embedding endpoint override is set | `openai`, derived when `W` is `openai` | schema default `openai` |
| `OPENAI_API_KEY` | `OPENAI_API_KEY` | `OPENAI_EMBEDDINGS_API_KEY`, only when the resolved provider is `openai` | — | `""`, then S4 |
| `GATEWAY_URL` | `GATEWAY_URL` | `OPENAI_EMBEDDINGS_BASE_URL`, then `OPENAI_BASE_URL`; only when the resolved provider is `gateway` | — | `""`, then S4 |
| `GATEWAY_API_KEY` | `GATEWAY_API_KEY` | `OPENAI_EMBEDDINGS_API_KEY`, then `OPENAI_API_KEY`; only when the resolved provider is `gateway` | — | `""`, then S4 |
| `EMBEDDING_MODEL` | `EMBEDDING_MODEL` | `LLMWIKI_EMBEDDING_MODEL`, only when that variable is explicitly set | — | schema default `text-embedding-3-small`; the wiki default table is never mirrored |

Definitions: `W` is the wiki embedding provider, `LLMWIKI_EMBEDDING_PROVIDER` when set, otherwise `LLMWIKI_PROVIDER`, lowercased and trimmed; when both are unset `W` is `anthropic`, which has no kg equivalent. "The wiki embedding endpoint override is set" means `OPENAI_EMBEDDINGS_BASE_URL` or `OPENAI_BASE_URL` is non-empty. Empty and whitespace-only values count as absent, everywhere.

Only these five variables are bridged: `EMBEDDING_PROVIDER`, `OPENAI_API_KEY`, `GATEWAY_URL`, `GATEWAY_API_KEY` and `EMBEDDING_MODEL`. Everything else keeps its own resolution and is never derived from the wiki side: `DATABASE_URL` and `AKS_API_KEY` describe unrelated credentials, and `EMBEDDING_DIM` is metadata the client never sends. `EXTRACTION_*` is not bridged through THIS table either: the extraction side travels on the provider descriptor named in S1, which supplies endpoint, credential and model per request and never touches these five variables. `EMBEDDING_MODEL` travels because the model decides the vector width and the kg column is `vector(768)`; it is taken only from an explicitly set `LLMWIKI_EMBEDDING_MODEL`, never from the wiki's default model table, whose default for these providers is 1536-wide and therefore unstorable.

When `EMBEDDING_PROVIDER` is absent and `W` has no kg-dimension equivalent, the key and endpoint rows are not derived either: the 2nd and 3rd sources apply only when a provider that the kg dimension can use actually results. The configuration is then refused by S4's no-equivalent message rather than silently falling back to the schema default, because a key the wiki dimension never used would otherwise be sent to a provider the operator never chose.

### S3 — An explicit KG-side value still wins

This is backward compatibility and it is not negotiable. The variables that decide the KG side's own embedding backend are `EMBEDDING_PROVIDER`, `GATEWAY_URL`, `GATEWAY_API_KEY` and `EMBEDDING_MODEL`; an explicitly set one of those keeps exactly the behavior it has today, and the bridge only fills absences. `OPENAI_API_KEY` is deliberately NOT in that set: both namespaces read it, so setting it cannot mean the operator chose the KG backend. It is treated as the shared credential, and when the KG side names no backend of its own the resolved provider descriptor supplies the endpoint, credential and model — which reach the same endpoint and the same credential the configuration already implied.

### S4 — Fail closed, with a deterministic message

A missing or partial credential fails before any HTTP request, with a message naming the variable the operator must set. A provider 401 and a stack trace are both defects. The required message text is fixed:

- resolved provider `openai`, no key:
  `EMBEDDING_PROVIDER=openai but no API key is configured. Set OPENAI_API_KEY, or OPENAI_EMBEDDINGS_API_KEY to reuse the wiki dimension's credential.`
- resolved provider `gateway`, no URL:
  `EMBEDDING_PROVIDER=gateway but GATEWAY_URL is not set. Set GATEWAY_URL, or OPENAI_EMBEDDINGS_BASE_URL to reuse the wiki dimension's endpoint.`
- resolved provider `gateway`, URL but no key:
  `EMBEDDING_PROVIDER=gateway but GATEWAY_API_KEY is not set. Set GATEWAY_API_KEY, or OPENAI_EMBEDDINGS_API_KEY to reuse the wiki dimension's credential.`
- `W` has no kg equivalent:
  `LLMWIKI_EMBEDDING_PROVIDER="<value>" has no kg-dimension equivalent. The kg dimension embeds through EMBEDDING_PROVIDER=openai or gateway; set one of those with its credential.`

The check runs on the kg dimension path, immediately before the first provider call, and it applies only to the kg dimension. `validateConfig` and the standalone server's startup validation keep their current behavior exactly, message for message.

### S5 — No secret exposure

No credential value may appear in stdout, stderr, logs, thrown errors, or test output, on the failing path or the succeeding path. No environment dump, and no debug print of the resolved config object that could serialize a key. Tests use obvious fake credentials such as `test-key-not-real`.

### S6 — Tests

One RED-first test per rule this change adds or modifies, observed failing before the implementation. Plus one test proving an explicitly set KG-side variable still wins (S3), because that existing behavior shares the code being changed. Each test asserts the observable effect of its rule: the resolved value, the exact error message, and that a rejected configuration performs no HTTP request. Tests use fake credentials only.

### S7 — Documentation

Whatever page documents dimensions and providers must state the shared-credential behavior and the S2 precedence table, so a user can discover it without reading source.

### S8 — End-to-end proof

An ingest with `LLMWIKI_DIMENSIONS=wiki,kg` reaches the embedding provider and succeeds, and the kg rows land in the same `stacks.id` as the wiki rows for the freshly ingested source. If a live provider cannot be used, the cheapest legitimate local substitute is used and the report states precisely what it proves and what it does not.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1-S8 (tracking) | worker, `odd/tasks/kg-shared-provider-credentials.md` | C0 |
| T2 | S2, S3, S4, S5, S6 | worker, `packages/llmwiki-kg/ts/src/*`, `src/dimensions/kg/*` | C1 (isolated: Risk item 2) |
| T3 | S7 | worker, `docs/**/*.mdx` | C2 |
| T4 | S8, S6 | gentle-ai-verify, independent | — |
| T5 | S2, S4, S6 | worker, `packages/llmwiki-kg/ts/src/{config,db}.ts`, `src/cli*` | C1 (same isolated commit) |
| T6 | S2, S7 | worker, `src/dimensions/kg/shared-provider-conformance.test.ts`, `docs/**` | C2 |
| T7 | S1, S2, S4, S6 | worker, `packages/llmwiki-kg/ts/src/chat-backend.ts`, `src/dimensions/kg/*` | C10 |
| T8 | S2, S6 | worker, `packages/llmwiki-kg/ts/src/core/**`, `packages/llmwiki-kg/ts/src/document-consolidation.ts` | C11 |

## Log

L1: "2 usa las mismas credenciales de la dimension wiki en la dimension KG"

L2: Manager relayed a second human instruction, verbatim: "la dimension wiki usa un endpoint open-ai like, revisa como esta y mandale a que lo haga asi" — the wiki dimension already talks to an OpenAI-compatible endpoint, and the kg dimension must use that same mechanism the same way, not a second convention invented next to it.

L3: Decision (architecture): the bridge lives in the vendored core's env resolution, not in the host. `packages/llmwiki-kg/ts` is the standalone private package `aks-reference-server` with its own build and its own HTTP server entry, so it cannot import the host's `src/utils/embedding-provider.ts` without inverting the dependency. Non-drift between the two dimensions is enforced by a conformance test that derives the expected variable names from the host tables instead.

L4: Decision (precedence order): S4's no-equivalent case is reported before the missing-key case only when the KG side sets no `EMBEDDING_PROVIDER` and no `OPENAI_API_KEY`. A literal reading of S2 would newly fail every deployment that works today on the `openai` schema default with its own key, which S3 forbids.

L5: Decision (verbatim copy): a KG-side value that is present is copied into the schema verbatim, without trimming or lowercasing; only blankness is judged by trim, so a configured value reaches the schema exactly as it did before this feature.

L6: Defect found by independent verification and fixed: configuration supplied only through a project `.env` never reached the bridge, because `config.ts` and `db.ts` snapshot `process.env` at module init and the CLI facade externalizes `@atomicstrata/llmwiki-core`, whose chunk is evaluated before the entry body. Evidence: an `env -i` ingest with only a project `.env` exited 1 with the S4 message and the stub received zero requests (`STUB_LINES before=6 after=6`). Fix: both snapshots resolve on first access and memoize, and `.env` is loaded as the CLI's first import. After the fix the same run exits 0 and the stub logs `POST /v1/embeddings auth=Bearer test-key-not-real`.

L7: Observed fact for S8: the kg dimension's ingest write set is `stack_documents`, `entity_source_documents`, `ontology_entities` and `ontology_relationships`. `document_chunks` is written only by the vendored HTTP route (`src/dimensions/kg/reader.ts:19`), so it stays at zero rows on the ingest path; that is pre-existing behavior, not an effect of this change.

L8: Accepted side effect: loading `.env` earlier also lets `packages/llmwiki-kg/ts/src/mcp/config.ts:11,14` (`AKS_BASE_URL`, `AKS_API_KEY`, outside the CLI ingest graph) see the project file where they previously always fell back to defaults.
L9: Work-unit commits on feat/kg-shared-provider-credentials: C0 748dbe0 (feature document), C1 b1a6475 (credential bridge and import-time snapshot fix, isolated as Risk item 2), C2 087090c (conformance test), C3 dc7afb2 (documentation).
L10: C5 09f84 shares the wiki embedding model with the kg dimension (the load-bearing fix for a real deployment whose wiki embeddings use a non-OpenAI model); C6 ef5ef adds the optional provider seam.

L11: The product owner approved sharing the embedding model, verbatim: "Model bridge: APPROVED, with one condition attached." The condition: a user who never names a model must be refused before any request with a message naming the variable and the 768 requirement, not left to discover it in Postgres. Implemented as the width/provenance gate in C5.

L12: Independent verification found the provider seam unreachable in any real deployment: `configuresOwnEmbeddingBackend()` counted `OPENAI_API_KEY` — the variable both namespaces share — as a KG-side choice, so the descriptor was never installed, and its regression test could not fail when the descriptor reported the chat client. Fixed by narrowing the set to the variables the KG side alone owns, and by making the test exercise the descriptor path and prove it has teeth under mutation.

L13: C8 cbcba3a8 narrows the kg-side backend set to the variables the kg side alone owns, makes the provider descriptor reachable in a real deployment, and gives its regression test teeth under mutation.

L14: The product owner withdrew the extraction non-goal, verbatim: "The non-goal on extraction is withdrawn." The human's own environment proved the narrower scope unusable: with his `.env` the kg dimension embedded successfully against a real endpoint and then reached ANTHROPIC for extraction, which is half the credentials the request names. The chat backend now gets the same descriptor treatment, with the same precedence and the same fail-closed rules, and the chat/embeddings descriptors are pinned apart by a different-hosts test in both directions.

L15: Verifying the live run found the stored provenance naming the configured model rather than the model that actually ran: `extracted_by_model` recorded `claude-sonnet-4-5` while the request used `deepseek/deepseek-v4-flash`. Corrected so stored rows name the model that produced them, with a test for both the injected and the un-injected path.
L16: C10 d307184004 reuses the wiki chat backend for extraction; C11 9d6c81f3aa fixes the recorded extraction model.

L17: The product owner's standard, verbatim: "la extracion debe ser con las credencioles de .env no con antropci ni openai". Pinned as tests: the extraction host comes from the resolved chat client's base URL and never from the provider's NAME (the wiki's provider is named `openai` while it points at another host), the credential is the one that client carries, and no run may reach `api.anthropic.com` or `api.openai.com` while a descriptor is installed.

L18: C13 839151253b501 pins the extraction host to the resolved client's base URL and forbids the anthropic and api.openai.com fallbacks.
