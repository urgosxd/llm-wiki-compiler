# Compile concurrency default exceeds a provider's real ceiling, and the retry path cannot recover it

**Status:** open — measured, not yet fixed.
**Found:** 2026-10-28, during a live integration run against a provider that caps
concurrent requests at 4.

## The defect, stated so the fix is unambiguous

Not "5 is too high". The statement is:

> The retry path cannot recover a rate limit whose ceiling is below the configured
> **baseline** concurrency.

Both halves are load-bearing, and the second is why more retries would not help.

## What was measured

Against a provider that answers `429 "Too many concurrent requests"`:

| concurrent requests | succeeded |
| --- | --- |
| 3 | 3 / 3 |
| 4 | 4 / 4 |
| 5 | 4 / 5 |

The ceiling is exactly 4. A single isolated request also succeeds, so this is a
concurrency cap, **not** a quota — a distinction worth measuring rather than
inferring, because the two produce the same status code and call for opposite
actions. (An earlier reading of a single `429` was generalised to "quota
exhausted"; the sweep above is what corrected it.)

## Why retrying does not save it

The product already anticipates 429 and still loses:

- `src/utils/constants.ts:70` — `COMPILE_CONCURRENCY = 5` (the default)
- `src/utils/constants.ts:73` — `COMPILE_CONCURRENCY_MAX = 50`
- `src/utils/constants.ts:76` — `ENV_COMPILE_CONCURRENCY = "LLMWIKI_COMPILE_CONCURRENCY"`
- `src/compiler/concurrency.ts:31` — the env is actually read here
- `src/utils/llm.ts:36` — `NON_RETRIABLE_RE = /^4(?!29)\d\d\b/` deliberately excludes
  429, so rate limits **are** retried
- `src/utils/constants.ts:79` — `RETRY_COUNT = 3`, with jittered backoff
- `src/utils/llm.ts:50-52` — the jitter exists precisely because high compile
  concurrency produces synchronised retry bursts

So the retry machinery is there and pointed at the right error. It still cannot win:
when the **baseline** concurrency (5) exceeds the ceiling (4), every retry is itself a
new concurrent request competing with the load that caused it. Retrying recovers a
transient spike. It cannot recover a ceiling the steady state already exceeds.

## Fix options, in order of how much they actually fix

1. **429-aware downshift** — on repeated 429 at the current width, reduce in-flight
   concurrency for the rest of the compile. This is the only option that fixes the
   class rather than one number, and it also survives a provider that changes its cap.
2. **Lower the default** — 4 would already fail against a cap of 4 once any retry
   overlaps; a default of 3 leaves headroom. Cheaper, but only correct for providers
   whose cap is at least 4.
3. Document the ceiling and leave the default. Cheapest, and wrong: the failure is
   silent in the sense that matters — extraction dies partway and the user is told
   nothing about why.

## Observed cost

Two real ingests failed at `stage=extraction` with `429 "Too many concurrent
requests"` before the concurrency was lowered. With `LLMWIKI_COMPILE_CONCURRENCY=3`
the same input reached `compile=succeeded`, `stage=embeddings`, message
`Wiki compiled.` — so the only difference between failure and success was the
concurrency setting, not the provider, the key or the document.

## Not fixed here

Deliberately left open: the choice between option 1 and option 2 is a product
decision about the default, not a demo repair, and it should not be smuggled in
alongside a live run.
