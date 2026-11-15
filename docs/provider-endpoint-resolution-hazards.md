# Two ways a provider setting lies: the endpoint it ignores, and the 200 that proves nothing

Maintainer and operator findings. Repo-facing plain `.md`, not part of the published Mintlify site
(`docs.json` untouched, as for `docs/turborepo.md`, `docs/ingest-dimension-observability.md` and
`docs/search-pages-embedding-store-gap.md`). Code locations are cited as `path:line`; measurements
come from a live session against database `llmwiki_corpus_demo_rc1` and the running services.

Both entries describe the same failure shape: a configuration knob that accepts a value, returns a
plausible result, and leaves the operator with no signal that the value meant something else.

## A provider name that ignores the configured endpoint

`EXTRACTION_PROVIDER` and `EMBEDDING_PROVIDER` are plain provider names, and each resolves its own
URL and credential in a `switch`: the extraction request at
`packages/llmwiki-kg/ts/src/core/llm/endpoints.ts:54-64` (gateway arm `:55-58`, openai arm `:60-64`)
and the embeddings request at the same file's `:109-118` (gateway arm `:110-113`, openai arm
`:115-116`). The `gateway` arms read the configured `GATEWAY_URL` and `GATEWAY_API_KEY`.

**The `openai` arm does not read a configured base URL.** It reads `OPENAI_BASE_URL`
(`endpoints.ts:62`, `:116`), and that symbol is a hardcoded vendor constant —
`export const OPENAI_BASE_URL = "https://api.openai.com/v1"`
(`packages/llmwiki-kg/ts/src/core/llm/constants.ts:31`, documented at `:30` as "Base URL of the
OpenAI API, used when `*_PROVIDER=openai`").

**The defect, stated plainly.** The problem is not that some variable went unset. The problem is
what the value means: setting `*_PROVIDER=openai` selects *the vendor's own endpoint*, and it does so
**silently**, because `OPENAI_BASE_URL` is not operator-configurable at all — it is a constant. An
operator who has configured a gateway, an internal mirror, or any OpenAI-compatible host elsewhere
in the environment is not overridden by `openai`; they are simply not consulted. There is no warning,
no log line, and no startup refusal that distinguishes "this deployment points at
`api.openai.com`" from "this deployment points at the endpoint I configured".

**It fired on a real run, and the consequence class is credential egress.** A diagnostic run set
`EXTRACTION_PROVIDER=openai`. The resulting chat request carrying the operator's credential was
transmitted to `api.openai.com` and rejected with `401`. Nothing authenticated, nothing was
retrieved, and no data changed — **and the secret had still left the machine.** The value that
mattered was not whether the call succeeded; it was destination. Recorded as a consequence class,
not an anecdote: **one variable of misconfiguration reached a third party**, the scope of the leak
being set by the vendor constant rather than by any operator setting. A rejected request is a
successful exfiltration attempt followed by a refusal.

**The operator-facing lesson for this deployment.** The correct value is `gateway`, with
`GATEWAY_URL` and `GATEWAY_API_KEY`
(`packages/llmwiki-kg/ts/src/config.ts:87-88`; the provider names are declared at `:77` for
embeddings and `:81` for extraction). `openai` is not "the OpenAI-compatible option" — it is the
vendor-locked option, and on a deployment whose services are not at `api.openai.com` it is always
wrong regardless of what else is configured.

**What would fix it.** Suggestions only; no code is proposed here.

- `openai` should honour a configured base URL before falling back to the vendor constant, so the
  provider name selects a *protocol* (OpenAI-compatible chat/embeddings) and not a *destination*.
- Or, keeping the current semantics, the vendor constant should stop being reachable from a
  configurable provider name: a `*_PROVIDER=openai` that resolves to a hardcoded host is a
  disclosure risk, and the two options — "vendor endpoint" and "configured endpoint" — deserve
  distinct, self-describing names.

**Note for whoever writes the test.** A test that pins this behaviour must assert the **resolved
URL** (`embeddingEndpoint().endpoint`, `extractionEndpoint().endpoint`), not that a variable is
accepted without complaint. A test asserting "config parses" or "no error thrown" passes today, in
the defective state, and would keep passing after any fix that changed destination silently.

## A 200 is not an acceptance condition; the vector space is

**The measurement — what the store actually holds.** `public.document_chunks.embedding` is
`vector(768)` — declared at `packages/llmwiki-kg/ts/src/schema.ts:193`
(`vector("embedding", { dimensions: 768 })`) — and every row measures `vector_dims` = 768.
`wiki.page_embeddings` (21 rows) and `wiki.page_chunk_embeddings` (114 rows) measure 768 as well.
`wiki.embedding_store_meta` carries the header the read path gates on: `model`, `dimensions`,
`backend`, `endpoint` (`packages/wiki/src/utils/embeddings-database.ts:136-137` reads
`model, dimensions`; the row is written with `backend` and `endpoint` at
`packages/wiki/src/utils/embeddings-database-write.ts:218-229`). It records the stored model as
`hf:nomic-ai/nomic-embed-text-v1.5` at 768, produced at the embeddings host — cross-checked against
`OPENAI_EMBEDDINGS_BASE_URL`, which matched, while `OPENAI_BASE_URL` did not.

**The trap: an embedding-model mismatch does not error.** A wrong model id is a perfectly valid
request. It returns `200` and a vector of the wrong width — or the right width drawn from a
different space — and the only place the contradiction surfaces is arithmetic that nobody checks.
During the investigation this was the near miss: `query_stack` would have begun answering
**successfully, in a vector space the stored data does not live in**. Confident, plausible, wrong.
Had it been "fixed" to any id the gateway lists, `query_stack` would have started answering in the
wrong vector space. — this investigation.

That sentence is the whole finding. The stored corpus was produced at 768 by
`hf:nomic-ai/nomic-embed-text-v1.5`; a gateway-listed chat or reasoning model that accepts
`/embeddings` and answers `200` would have changed nothing visible and everything semantic. The
read path can detect this (`storeMatchesActiveEmbedding`,
`packages/wiki/src/utils/embeddings-store.ts:459-464`, comparing the store's fingerprint or model
against the active configuration) — but only if the configuration that runs is the one that built
the store.

**The rule, as a testing rule.** For retrieval, acceptance is **consistency with stored state** —
model and dimension match — not the absence of an HTTP error. A test for an embedding path should
assert the **resolved model and dimension against what the store records**, so a mismatch fails
loudly at test time instead of degrading quietly at answer time. `200` is evidence that a server
answered; it is not evidence that the vectors are comparable.

**Where the `hf:` prefix comes from — it looked like a bug and was not.** The KG schema's default
for `EMBEDDING_MODEL` is `text-embedding-3-small`
(`packages/llmwiki-kg/ts/src/config.ts:75`), so the `hf:…` value is not a source default. It is the
operator's `LLMWIKI_EMBEDDING_MODEL` bridged into `EMBEDDING_MODEL` by
`fillIfAbsent(bridged, KG_MODEL, readPresent(env, WIKI_EMBEDDING_MODEL))` in
`packages/llmwiki-kg/ts/src/wiki-credential-fallback.ts:284`, and only when the operator named one
(`:269`). A prefixed, non-vendor model id was therefore the *correct* signal that this corpus was
deliberately configured — not a corrupted default.

**The open structural conflict: one knob, two hosts.** A single `GATEWAY_URL` governs both chat and
embeddings — the chat gateway arm reads it at `endpoints.ts:57`, the embeddings gateway arm at
`:112` — while this deployment serves the two functions from two hosts holding two distinct keys.
One variable cannot describe that topology, and `*_PROVIDER=openai` does not rescue it because that
arm ignores the configured base URL entirely (Entry 1). The split is being addressed on its own
branch; it is a source change, out of scope for these notes.

A fan-out proxy holding both keys was considered for this and **rejected deliberately**: it
invents a new secret store to work around a configuration defect, and it would put a second copy of
both credentials in a place that exists only because the configuration cannot express what the
deployment already is. Fix the knob, not the topology.
