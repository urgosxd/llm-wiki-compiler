# KG extraction budget: what the fix does, and two facts that outrank it

Read this before retargeting extraction with configuration alone. The code fix
below is small; the two findings under "What configuration alone cannot do" are
the ones that cost a debugging session, because both make a *correct* deployment
look like a broken one.

## The defect and the fix

`POST /aks/v1/context` asked for `max_tokens: 1024` and got back
`finish_reason: "length"` with `choices[0].message.content === null`. Measured
against OpenRouter with a realistic 8.3 kB extraction prompt: 0 of 8 usable at
1024, 8 of 8 at 4096 with at most 748 reasoning tokens. Upstream answered HTTP
200 in 46 of 46 calls with no 429, so the provider was healthy and the *budget*
was the defect: the model spends tokens reasoning before it writes an answer, and
1024 was the size of the answer alone.

Three changes, each with its own reason:

1. **The budget is derived, not bumped.** `packages/llmwiki-kg/ts/src/routes/aks/context.ts`
   keeps the answer's own size (`SELECTION_ANSWER_TOKENS = 1024`) and adds the
   measured reasoning allowance (`SELECTION_REASONING_HEADROOM_TOKENS = 3072`);
   `SELECTION_MAX_TOKENS` is their sum. A number typed for one model's answer
   shape is exactly what failed; a headroom that the call justifies is what
   survives the next model. A model that does not reason simply leaves it unused,
   which costs nothing, while a missing one costs the whole call.
2. **An exhausted budget is a distinguishable failure.** `chatMessageContent`
   raises `LlmBudgetExhaustedError` with an explicit `502` when the body carries
   `finish_reason: "length"` and no `content`. A `content: null` WITHOUT that
   finish reason stays a plain, status-less `LlmError`: unknown is still unknown,
   and that difference is the signal a caller has to tell "budget too small" from
   "provider down".
3. **Two sites, and why both.** The status is fixed at the source (the error
   class above). `handleError` in `packages/llmwiki-kg/ts/src/server.ts` had to
   change as well, because it rendered every `status >= 500` as a bare
   `text/plain` 21-byte `Internal Server Error` — the original 500 was invisible
   in exactly the way a truncation needs to not be. The change there is narrow: one
   `instanceof` branch answering `{ "detail": ... }` for this one error, whose
   text is a fixed string naming no endpoint, no model and no credential. Every
   other 5xx keeps the measured oracle body byte for byte.

## What configuration alone cannot do

### 1. The image `Cmd` beats `--env-file`

`docker run --env-file <file>` **cannot** retarget extraction. The image's own
`Cmd` assigns the extraction provider and the gateway URL itself, and a shell
assignment inside `Cmd` runs *after* the env-file has been loaded, so it wins:

```text
EXTRACTION_PROVIDER=gateway GATEWAY_URL="$OPENAI_EMBEDDINGS_BASE_URL"
```

An operator who follows a configuration-only instruction will edit the env file,
restart, see extraction still hitting the old host, and conclude the code is
broken. It is not: the container never received the variable. Retargeting requires
recreating the container with an overridden `Cmd`, or an image whose `Cmd` stops
assigning what the env file is supposed to decide.

### 2. Embeddings must NOT follow `GATEWAY_URL`

`GATEWAY_URL` is the CHAT host. Retargeting it alone silently moves the
embeddings dimension onto that same host, and the failure is quiet: the vectors
that come back either have the wrong dimension for the `vector(768)` column or
come from a model nothing else uses, so retrieval degrades instead of erroring.
To keep embeddings where they are, set `GATEWAY_EMBEDDINGS_BASE_URL` and
`GATEWAY_EMBEDDINGS_API_KEY` explicitly — the embeddings endpoint reads those two
and only falls back to the chat pair when they are blank.

### 3. `AKS_DATABASE_URL`: adopted verdict, no action

Removing `AKS_DATABASE_URL` changes nothing **while `DATABASE_URL` is present**,
because resolution falls back to it — and it is **UNSAFE if `DATABASE_URL` is ever
absent**, because the schema default is the `aks` database, the drifted one this
campaign refused to touch. It is load-bearing for the *negative* case and inert
for the positive one. Verdict adopted as-is: **not removed, not acted on.** A
future cleanup that deletes it as "a leftover" makes a configuration mistake
resolve to the wrong database instead of failing.

## Verification recorded with this fix

- `packages/llmwiki-kg/ts/src/core/llm/content-null.test.ts` — four cases: the
  error's message kind, its explicit status versus the status-less unknown case,
  the route answering `502` with a JSON `detail` instead of the 21-byte body, and
  the outgoing `max_tokens` being adequate for the prompt. The last one pins the
  behaviour (measured reasoning spend plus the answer the call must produce) and
  deliberately does not pin the literal `4096`.
- Scope run is recorded in `odd/tasks/kg-extraction-budget.md`. No full `pnpm
  test` was run: that tier belongs to CI.
