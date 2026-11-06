# kg-classification-log-retention

Bounds `kg_classification_log` growth with an explicit administrative prune of
`provider_failure_preserved:*` rows. Failure rows stay per-occurrence; pruning is a
time-window DELETE, never a write-time dedupe, never a rollup.

Branch `fix/classification-log-retention`, base `a8f1925a129c22f721479923134076cb421d8e26`.

## Specs

S1. Failure events stay per-occurrence: a permanently failing classifier keeps appending
one `kg_classification_log` row per sweep per candidate. No dedupe, no collapse, no
upsert at write time.

S2. Exactly one row family is eligible for pruning: rows whose `reason` starts with
`provider_failure_preserved:`. Rows with `reason = 'refused:verified_row_preserved'` are
never eligible, and nothing else in `kg_classification_log` is eligible.

S3. Pruning is an explicit administrative operation. Never automatic, never triggered by
ingest, never inside an ingest transaction.

S4. Dry-run by default: without explicit confirmation the operation reports
`matchedCount` and deletes nothing. Only `confirm=true` deletes.

S5. Retention window is configurable and defaults to the named constant
`DEFAULT_CLASSIFICATION_FAILURE_RETENTION_DAYS = 30`. No inline magic number.

S6. Retention applies only to failure-kind rows of `kg_classification_log` in one stack.
Classification state, evidence rows, entities, relations and every other table are
byte-identical before and after a prune that deletes rows.

S7. Idempotent: a second run over an already-pruned table matches 0 rows, deletes 0, and
reports `deletedCount: 0`.

S8. Safe with in-flight ingests: the cutoff is fixed once at transaction start, the delete
is a single statement, and concurrent prunes of one stack serialize through
`pg_advisory_xact_lock`.

S9. Response contract: `{ dryRun, retentionDays, cutoff, matchedCount, deletedCount }`.

S10. Consecutive-failure counts remain observable: pruning removes only events older than
the cutoff and never inserts a summary row, so a candidate with 47 failures inside the
window still reads as 47 consecutive failures.

S11. Operator procedure and the tradeoff are documented in
`docs/configuration/kg-classification.mdx` and recorded in `odd/tasks/algo-kg.md` as `L17`.

## Tasks

T1 — storage-level prune function and its retention tests. Covers S1-S8, S10.
T2 — HTTP route, dry-run default, input validation, help text. Covers S3-S5, S9.
T3 — operator docs and the algo-kg L17 log entry. Covers S11.

## Log

L1 — user request, verbatim:

PROBLEM: `kg_classification_log` grows without bound for `preserved_after_failure` rows.
A permanently failing classifier appends one row per sweep per affected candidate. This
was deliberately kept as an append-only event log — "a refusal is state, a failure is an
event", and a row failing 47 consecutive sweeps is diagnostically different from one that
failed once during a transient outage, so deduping at write time would destroy the signal.
Do NOT change that decision: failure rows stay per-occurrence.

WHAT TO BUILD: a retention mechanism that bounds table growth without erasing the
diagnostic distinction.
1. Pruning is an EXPLICIT administrative operation, never automatic at write time, and
never inside an ingest transaction.
2. Dry-run by default. Deleting rows requires an explicit confirmation flag/argument.
Default behaviour must be "report what would be deleted", not "delete".
3. A configurable retention window. The default must be a named constant with a documented
rationale — no magic number inline.
4. Retention applies ONLY to failure-kind rows in `kg_classification_log`. It must never
touch classification state, evidence rows, entities, relations, or any other table.
5. Idempotent: a second run over an already-pruned table deletes nothing and reports zero.
6. Safe under concurrency with in-flight ingests: assume a sweep may be appending while you
prune.

BOUNDARIES: no HTTP write path for `stacks.type_catalog`; no dedup of failure rows; do not
touch the JEV adapter, the classifier, the classification-state migration, or any AKS
projection; no new services, frameworks or infrastructure.

L2 — design decision (Lead), the two viable shapes:

Shape A, time-window pruning: `DELETE FROM kg_classification_log WHERE stack_id = $1 AND
reason LIKE 'provider_failure_preserved:%' AND created_at < cutoff`.
Shape B, rollup/aggregation: collapse old failure events into a summary row carrying a
count plus first/last seen.

Chosen: A. Shape B needs a new marker column or a new table (schema.sql, drizzle mirror and
the schema parity test all move), makes idempotency a re-aggregation problem, and its
aggregate rows would have to be excluded from every history read — a change to read
semantics, which is the same destruction of the per-occurrence signal that write-time
dedupe would cause, only relocated. Shape A keeps every surviving row a real occurrence and
leaves the consecutive-failure read untouched. Accepted cost: the tail of a failure run
older than the window stops being observable; mitigated by a 30-day default window and by
documenting an export-first operator step.

L3 — why 30 days: a permanently failing classifier writes one row per sweep per candidate,
so a day of failed sweeps already dominates the table (47 sweeps ≈ minutes), while 30 days
covers a full monthly operational cycle, incident postmortems and "did this regress last
month" questions. Shorter windows lose the diagnostic tail inside the reporting period;
longer windows stop bounding growth. The window stays operator-configurable for stacks with
different incident cadences.

L4 — T1, T2 and T3 landed. Recorded here with the evidence that exists and the evidence
that does not yet exist, kept apart.

T1 (storage) — `packages/llmwiki-kg/ts/src/routes/classification-log/prune.ts` plus
`prune.test.ts`, `prune-retention.test.ts` and `prune-harness.ts`. RED: both new suites
failed to load `./prune.js`, so the absence under test was the behaviour and not the
fixture. GREEN: `npx vitest run packages/llmwiki-kg/ts/src/routes/classification-log/
--no-file-parallelism` -> `2 files passed, 8 tests passed (8)`. No tracked file was
modified: the diff is four new files, so the shared-code differential did not apply.

T2 (HTTP) — `routes/classification-log/router.ts`, mounted by `createIngestRouter`
beside `createReclassifyRouter` (`routes/ingest/router.ts:154`), plus
`prune-http.test.ts`. RED: six tests answered `expected 200 "OK", got 404 "Not Found"`
through the real router. GREEN: same directory command -> `3 files passed, 14 tests
passed (14)`, T1's two suites unmodified and still passing. Preservation evidence for
the shared router: `npx vitest run .../src/http-contract.test.ts .../src/server.test.ts
--no-file-parallelism` -> `2 files passed, 52 tests passed` (the suites pinning every
oracle path's 405 `Allow` header and the app composition).

T3 (docs) — `docs/configuration/kg-classification.mdx` gained the operator section
*Prune old failure history* (problem, ordered runbook, dry-run and confirmed `curl`,
export query, eligibility, response-key table, `422` and `401` cases, the tradeoff and
the two caveats); `docs/concepts/kg-open-classification.mdx` gained one pointer
paragraph in the classification-history discussion; `odd/tasks/algo-kg.md` gained `L17`.
No code, schema, migration or navigation file was touched.

Typecheck: `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit` -> exit 0, no
output. That tsconfig includes `src/**/*.ts`, so the new test and harness files are
covered by it.

**Not run, and not claimed:** root `npx tsc --noEmit`, `npm run build`, `npm run
test:affected` and `npx fallow` are pending the Lead's integration pass. If `fallow` is
run, note that `.fallowrc.json` ignores `packages/llmwiki-kg/**`, so a clean result would
not cover this change.

**Escaped-LIKE correction.** The brief's literal predicate,
`reason LIKE 'provider_failure_preserved:%'`, is wrong for a DELETE: `_` is a
single-character wildcard in `LIKE`, so that pattern also matches `provider-failure-preserved:`
and `providerXfailureXpreserved:` variants. S2 constrains eligibility to rows that START
WITH the literal prefix, so the implementation builds the pattern from
`FAILURE_REASON_PREFIX`, escapes `_`, `%` and the backslash, and declares the escape
character in the statement. It is still one DELETE over the same imported constant; test
(b) seeds a dashed decoy and proves it survives.

**T2 divergence from `pydanticBoolean()`.** The package's own query-boolean primitive
accepts `1/0/on/off/t/f/y/n/yes/no`, which would make `?confirm=false` and
`?confirm=no` both reach the delete decision through a coercion this operation cannot
afford. `confirm` is therefore `z.enum(["true", "false"])`: exactly two spellings, and
anything else is a `422`. The consequence is a deliberate inconsistency —
`?synthesize_descriptions=` on ingest stays lenient while `?confirm=` on prune is strict
— and the docs state it rather than implying the two behave alike.

L5 — T4 and the documentation-consistency fixup, comment and documentation text only. No
executable line, route path, query parameter, status code, response key or test assertion
changed.

The `@file` JSDoc of `routes/classification-log/router.ts` documented
`Authorization: Bearer $AKS_API_KEY` in both `curl` examples, which cannot work:
`src/auth.ts` reads only the `x-api-key` header, compares it to `AKS_API_KEY` by exact
equality, and has no prefix handling — pinned by `auth.test.ts`
("returns 401 for a Bearer-prefixed value"). Corrected to `X-API-Key: $AKS_API_KEY`. The six
files this feature added contain no other auth mention.

Two further JSDoc facts were corrected against the code rather than against this brief: the
`cutoff` example is `Z`-suffixed (`normalizeTimestamptz` in `db.ts` always returns
`${date}T${time}.${microseconds}Z`, pinned by the shape assertion in `db.test.ts`), and the
strict `confirm` enum rests on the lax `pydanticBoolean()`, which accepts `1/0/on/yes/t/y`
rather than rejecting `"false"` — the `z.coerce.boolean()` misreading the old sentence
described belongs to a primitive this package does not use for query booleans.

The same wrong cutoff form was repeated in `docs/configuration/kg-classification.mdx`,
twice: the response example's `cutoff` value now ends in `Z`, and the response-key table
now states the exact form (UTC, `Z` suffix, six fractional digits) instead of "the
database's normalized timestamptz form". A sweep of the section this feature added found no
other `+00:00` cutoff example.

Evidence: `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit` -> exit 0, no output;
`npx vitest run packages/llmwiki-kg/ts/src/routes/classification-log/ --no-file-parallelism`
-> `3 files passed, 14 tests passed (14)`, unchanged from the pre-change run. **Not run and
not claimed:** root `npx tsc --noEmit`, `npm run build`, `npm run test:affected` and
`npx fallow` remain pending the Lead's integration pass.

Known residual, deliberately untouched as out of scope: `routes/reclassify/router.ts:14`
and `:19` carry the same non-working `Authorization: Bearer` example in their `curl`
lines. That file predates this feature and is not in this feature's edit surfaces.
