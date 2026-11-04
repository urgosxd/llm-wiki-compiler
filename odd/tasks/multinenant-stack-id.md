# Multistack stack-id resolution: work without a configured Stack

Three defects share one root cause: the Stack id is a required environment variable (`AKS_STACK_ID`) instead of a resolved selection. Reads already degrade when it is empty; writes throw. This document makes writes agree with reads, adds a deterministic default Stack, and gives the CLI an explicit multi-stack selector.

Scope: `src/dimensions/`, `src/services/stacks/`, `src/services/ingest/`, `src/compiler/rule-state.ts`, `src/cli/`, `docs/`. Non-goal: removing the Postgres requirement — the `wiki` dimension is row-backed by a recorded decision, and this change does not revert that.

## Specs

### S1 — Stack selection has an explicit precedence, and no env var is required

Human's words, verbatim:

> "El repo no gestiona correctamente como manejar multiples stacks, hasta te pide uno via env , la meta es que el repo funcione sin uno por defecto"

A Stack-scoped command resolves its Stack in this order, highest first:

1. `--stack <id>` command-line option.
2. `AKS_STACK_ID` environment variable.
3. The deterministic default Stack (S3).

Resolution must never fail merely because nothing is configured. The following message exists today (`src/dimensions/activation.ts:203-212`) and must no longer be reachable from a Stack-scoped command that was given no Stack:

```
LLMWIKI_DIMENSIONS enables "wiki" but AKS_STACK_ID is not set. Set it to the knowledge stack the documents belong to.
```

### S2 — A bare checkout runs

From a checkout with `AKS_STACK_ID` unset and no `--stack` option, `llmwiki ingest`, `llmwiki compile`, `llmwiki refresh`, `llmwiki query` and `llmwiki watch` must reach their normal work instead of exiting with a Stack error. `AKS_DATABASE_URL` keeps its existing fallback (`kgConfig.DATABASE_URL`) and is not part of this change.

### S3 — The default Stack is deterministic, single, and materialized idempotently

When S1 step 3 applies, the resolved Stack is the row in `stacks` whose `domain` is exactly:

```
default
```

and whose `name` is exactly:

```
Default
```

Rules:

* First use creates that row; every later use reuses the same row. Two runs of the same command must not create two Stacks.
* Creation must be idempotent and must never overwrite an existing Stack row (no update of `name`, `domain`, or any other column).
* The default Stack is exactly one Stack. Several Stacks may exist; they never merge, and an explicit selection (S1 step 1 or 2) always wins over the default.

### S4 — An explicit selection that cannot be honoured fails closed, naming it

`--stack <id>` given with an id that is not an existing Stack row must fail with an error whose message contains the offending id and the word `stack`, and must not fall back to the default Stack. A malformed (non-uuid) `--stack` value must fail the same way, before any query. An explicit selection must never silently become the default.

### S5 — The active Stack is observable, and Stacks are listable

* Every Stack-scoped command states which Stack it used and where that came from: one of `--stack`, `AKS_STACK_ID`, or the default. The statement must name the resolved Stack id.
* `llmwiki stack list` exists, is registered on the root program, and prints the Stacks of the current connection. Help text: `List the knowledge Stacks this connection can see.`

### S6 — Help text and docs teach the resolution order

`--stack` is documented in the help of every command that accepts it, and the documented resolution order matches S1. Documentation states that no Stack configuration is required for a single-checkout default. Any doc or help line that presents `AKS_STACK_ID` as mandatory is corrected.

### S7 — Surfaces that were not asked to change keep their behaviour

The MCP tenant path keeps refusing when no Stack is bound. `src/mcp/tenant-db.ts:28-31` defines:

```
This project has no AKS_STACK_ID, so no Stack-scoped data can be read. Set AKS_STACK_ID to the Stack this deployment serves.
```

That message and the `{ unavailable: ... }` result must remain reachable for an MCP tool call on an unbound deployment; the defaulting in S1 applies to the CLI and ingest write path, not to the MCP deployment binding. `buildIngestEnv(undefined)` must keep returning `process.env` untouched.

## Tasks

- T1 — S1, S2 — resolver with precedence, no throw on absence; keep strict entry point for callers that must refuse — worker — commit: pending
- T2 — S3 — idempotent default Stack ensure — worker — commit: pending
- T3 — S1, S3 — wire ingest write path and rule-state to the resolver — worker — commit: pending
- T4 — S4 — `--stack` option, fail-closed on unknown/malformed id — worker — commit: pending
- T5 — S5 — active-Stack line and `llmwiki stack list` — worker — commit: pending
- T6 — S6 — help text and docs corrected — worker — commit: pending
- T7 — S7 — regression tests proving MCP refusal and `buildIngestEnv` are unchanged — worker — commit: pending

## Log

- L1 — user request, verbatim: "El repo no gestiona correctamente como manejar multiples stacks, hasta te pide uno via env , la meta es que el repo funcione sin uno por defecto"
- L2 — reconnaissance evidence: `requireStackId` throws at `src/dimensions/activation.ts:203-212`; write path `src/services/ingest/service.ts:129` calls `resolveStackId(env)` unconditionally, while read seams already degrade on an empty var (e.g. `src/dimensions/wiki/page-source-seam.ts:456-468`). `createDimensionsDatabase` falls back to `kgConfig.DATABASE_URL` (`src/dimensions/activation.ts:116-125`), so the Stack id is the only unconfigured requirement.
- L3 — evidence: `stacks` table has `id uuid` and `domain text not null unique` (`packages/llmwiki-kg/db/schema.sql:16-37`); `src/services/stacks/stack-store.ts` exposes only `stackExists` and `listStacks`; the CLI registers no `stack` command.
- L4 — decision (lead): the recorded refusal in `src/dimensions/activation.ts:20-36` is superseded for the CLI by the human's request. The default is a named, materialized Stack (`domain` = `default`, `name` = `Default`) rather than a silent unnamed fallback, which answers the original objection that defaulting would scatter entities into one unnamed Stack.
- L5 — decision (lead): the MCP deployment binding keeps refusing (S7) because that path serves an explicitly bound Stack; defaulting there would silently retarget a deployed server.
