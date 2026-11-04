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

### S5 — The default Stack is announced, and explicit selection is validated

When a Stack-scoped command resolves to the default Stack (neither `--stack` nor `AKS_STACK_ID` configured), it prints exactly one line to stderr:

```
Using the default Stack (no --stack or AKS_STACK_ID configured).
```

Stdout is untouched, so the `--json` output contracts hold. When a Stack is configured, no such line is printed: the caller already chose it, so there is nothing to announce and no existing output changes.

Stack enumeration is out of scope. Row-level security limits visibility on `stacks` to the bound Stack (`using (id = nullif(current_setting('app.stack_id', true), '')::uuid or domain = nullif(current_setting('app.stack_domain', true), ''))`, `packages/llmwiki-kg/db/migration_rls_tenancy.sql:50-78`), and `listStacks` takes a bound Stack id, so a CLI `stack list` could only ever print one row. Enumeration stays in the HTTP API.

### S6 — Help text and docs teach the resolution order

`--stack` is documented in the help of every command that accepts it, and the documented resolution order matches S1. Documentation states that no Stack configuration is required for a single-checkout default. Any doc or help line that presents `AKS_STACK_ID` as mandatory is corrected.

### S7 — Surfaces that were not asked to change keep their behaviour

The MCP tenant path keeps refusing when no Stack is bound. `src/mcp/tenant-db.ts:28-31` defines:

```
This project has no AKS_STACK_ID, so no Stack-scoped data can be read. Set AKS_STACK_ID to the Stack this deployment serves.
```

That message and the `{ unavailable: ... }` result must remain reachable for an MCP tool call on an unbound deployment; the defaulting in S1 applies to the CLI and ingest write path, not to the MCP deployment binding. `buildIngestEnv(undefined)` must keep returning `process.env` untouched.

## Tasks

- T1 — S1, S2 — resolver with precedence, no throw on absence; keep strict entry point for callers that must refuse — worker — commit: 44209e2
- T2 — S3 — idempotent default Stack ensure — worker — commit: 44209e2
- T3 — S1, S3 — wire ingest write path and rule-state to the resolver — worker — commit: 3fc4aa9
- T4 — S4 — `--stack` option, flag wins over env, fail-closed on unknown/malformed id — worker — commit: 57a2f3a
- T5 — S5 — announce the default Stack on stderr; no `stack list` (RLS makes it a one-row lie) — worker — commit: 57a2f3a
- T6 — S6 — help text and docs corrected — worker — commit: c152d84
- T7 — S7 — regression tests proving MCP refusal and `buildIngestEnv` are unchanged — worker — commit: c152d84
- T8 — S1, S3 — pin the same-id guarantee: wiki and kg receive one resolved default Stack id — worker — commit: 84c45c0

## Log

- L1 — user request, verbatim: "El repo no gestiona correctamente como manejar multiples stacks, hasta te pide uno via env , la meta es que el repo funcione sin uno por defecto"
- L2 — reconnaissance evidence: `requireStackId` throws at `src/dimensions/activation.ts:203-212`; write path `src/services/ingest/service.ts:129` calls `resolveStackId(env)` unconditionally, while read seams already degrade on an empty var (e.g. `src/dimensions/wiki/page-source-seam.ts:456-468`). `createDimensionsDatabase` falls back to `kgConfig.DATABASE_URL` (`src/dimensions/activation.ts:116-125`), so the Stack id is the only unconfigured requirement.
- L3 — evidence: `stacks` table has `id uuid` and `domain text not null unique` (`packages/llmwiki-kg/db/schema.sql:16-37`); `src/services/stacks/stack-store.ts` exposes only `stackExists` and `listStacks`; the CLI registers no `stack` command.
- L4 — decision (lead): the recorded refusal in `src/dimensions/activation.ts:20-36` is superseded for the CLI by the human's request. The default is a named, materialized Stack (`domain` = `default`, `name` = `Default`) rather than a silent unnamed fallback, which answers the original objection that defaulting would scatter entities into one unnamed Stack.
- L5 — decision (lead): the MCP deployment binding keeps refusing (S7) because that path serves an explicitly bound Stack; defaulting there would silently retarget a deployed server.
- L6 — decision (lead): S5's original `llmwiki stack list` bullet is withdrawn. Row-level security restricts `stacks` visibility to the bound Stack, so the command could only ever print one row; enumeration stays in the HTTP API. S5 now requires announcing the default Stack on stderr only, which is new behaviour in a path that previously refused, so no existing output contract changes.
- L7 — environment finding: the first slice-C gate run failed 2 of 6 CLI cases because the worktree's `node_modules` was a symlink to the main checkout, so the built `dist/cli.js` loaded `main`'s pre-branch `@atomicstrata/llmwiki-core`. Replacing it with a real `npm ci` install in the worktree turned the same 6 cases green with no code change. Conclusion: CLI subprocess tests were not exercising this branch until then, and `test:affected` does not include `test/cli/`, so CLI behaviour must be gated by an explicit run.
- L8 — closure: slices A-D landed as 44209e2 (resolver + default Stack), 3fc4aa9 (write path + compile pre-check), 57a2f3a (--stack + default-Stack notice), c152d84 (docs + S7 preservation tests). All tasks T1-T7 checked. Known limitations recorded, not fixed here: `ingest-session` and `context` accept no `--stack` (they still work via AKS_STACK_ID or the default Stack), and the Postgres requirement is unchanged — only the Stack id stopped being required.
- L9 — independent verification (gentle-ai-verify, not an implementer) accepted S1-S7 with its own probes: bare `ingest` exits 0 with no Stack configured, the notice appears once on stderr, stdout is byte-identical to a configured run, and the default Stack stays one row with an unchanged `updated_at` across repeated runs. It found one real defect, now fixed: the tenant-isolation page claimed a bare clone "compiles into the default Stack", but compile's page and source seams still gate on the raw `AKS_STACK_ID`, so a bare compile publishes to disk. The page now states what is actually true. Limitation recorded, not fixed: compile reads rows only when a Stack is named explicitly; `src/commands/rules.ts` and `context`/`ingest-session` likewise never see the default Stack.
- L10 — process finding: three worker turns were killed by an approval prompt on `rm -rf` in their own cleanup steps, not by product defects. Work already on disk survived each time; recovery was to re-drive only the remaining steps with `rm` forbidden.
- L11 — gate gap closed: `test/quickstart-json-stdout.test.ts` pins stdout/stderr bytes of a spawned CLI, so `scripts/test-partition.ts` classifies it `integration` and `scripts/run-affected-tests.ts` — which runs only the unit tier on a global change — could never select it. It was green only because it was run by hand. `test:affected` now always adds a minimal, documented output-contract list on top of whichever tier it selects, initially that one file, and builds once if `dist/cli.js` is missing. The spawn-free unit tier is unchanged, and no assertion was moved, weakened or suppressed.
- L12 — gap found by the KG testing project's re-baseline on this branch: the single-resolution guarantee (both dimensions receive the SAME resolved default Stack id) existed only in source, not in any test. `default-stack-ingest.test.ts` builds the wiki dimension only, and `stack-selection.test.ts:117-126` passes an explicit id and asserts only the dimension-name array. Now pinned by `test/dimensions/default-stack-both-dimensions.test.ts`, proven to bite by a temporary mutation that gave the kg dimension a different id.
- L13 — bookkeeping: T8's SHA is recorded post-hoc (84c45c0) because a commit cannot contain its own hash; the entry was authored while the commit was still uncommitted. Recorded rather than left as `pending`, since a stale record is worse than a missing one.
