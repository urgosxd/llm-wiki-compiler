# Oracle-diff harness

The reproducible differential between the Python oracle and the TypeScript port.
One command, one pass/fail, and the verification tool every Wave 1 slice depends
on.

```
cd ts
npm run test:oracle
```

## How to run it

Both servers are assumed to be up. The oracle is read-only infrastructure: the
harness never starts it, stops it, or reconfigures it.

```bash
# 1. Oracle on :8000 (start it yourself)
docker compose up -d api

# 2. TS server on :8001
cd ts
PORT=8001 DATABASE_URL=postgresql://aks:aks@localhost:5434/aks npm run dev

# 3. Diff, in another terminal
cd ts && npm run test:oracle
```

Or let the harness boot the TS server itself, which is what CI-style runs use:

```bash
cd ts
PORT=8001 DATABASE_URL=postgresql://aks:aks@localhost:5434/aks npm run test:oracle -- --boot
```

`--boot` only starts a server when `--ts-url` is not already answering
`/health`, always on `--boot-port` (default 8001), and always shuts it down again.
Port 8000 is refused unconditionally.

### Options

CLI flags win over environment variables, which win over the defaults.

| Flag | Env var | Default |
| --- | --- | --- |
| `--oracle-url <url>` | `ORACLE_DIFF_ORACLE_URL` | `http://localhost:8000` |
| `--ts-url <url>` | `ORACLE_DIFF_TS_URL` | `http://localhost:8001` |
| `--boot` | — | off |
| `--boot-port <port>` | `ORACLE_DIFF_BOOT_PORT` | `8001` |
| `--api-key <value>` | `ORACLE_DIFF_API_KEY` | unset |
| `--database-url <url>` | `ORACLE_DIFF_DATABASE_URL`, else `AKS_TEST_DATABASE_URL` | `postgresql://aks:aks@localhost:5434/aks` |

Port 5434 is the host-side Postgres port from `docker-compose.override.yml`;
5432 is taken by another project on this machine.

Both `--flag value` and `--flag=value` are accepted.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | every scenario passed and the database was left empty |
| `1` | at least one scenario diverged |
| `2` | preflight or harness failure (a server is down, auth modes disagree, a request errored) |

## What it checks

One ordered scenario list is replayed against both targets, then compared.
Coverage is the whole stacks vertical, because it is the only ported one:

| Scenario | What it pins |
| --- | --- |
| `health` | liveness body, field for field |
| `post-valid` | `201`, full `StackResponse` shape and field order |
| `post-duplicate-domain` | `409` with the oracle's `detail` string |
| `get-list` | `200`, the list body, `updated_at desc` ordering |
| `get-by-id` | `200`, identical row |
| `get-unknown-uuid` | `404` detail |
| `patch-single-field` | partial update leaves other fields untouched |
| `patch-multiple-fields` | `set` clause covering several fields at once |
| `patch-empty-body` | `400` "At least one field must be provided" (not 422) |
| `patch-unknown-uuid` | `404` |
| `delete-existing` | `204` with a genuinely empty body |
| `delete-twice` | second delete is `404` |
| `post-invalid-empty-name` | `422` `string_too_short` |
| `post-invalid-domain-pattern` | `422` `string_pattern_mismatch` |
| `post-invalid-scope-literal` | `422` `literal_error` |
| `post-invalid-missing-field` | `422` `missing` |
| `post-non-object-body` | `422` `model_attributes_type` for the bare number `5` |
| `non-uuid-path-param` | `422` `uuid_parsing` on the `path` location |
| `auth-missing-header` | `401` when a key is configured |

Dependent steps are supported: a scenario declares `dependsOn`, and the harness
binds the `id` captured from that scenario's response into its `{id}` path
template.

### Comparison semantics

Per scenario:

- **HTTP status** must be equal. Any difference is a failure.
- **JSON body** is compared structurally after normalization. An empty body
  (a `204`) is distinguished from `{}`.

Normalization, applied identically to both sides:

- every UUID (`8-4-4-4-12` hex, any case) becomes `<UUID>`;
- every timestamp (`YYYY-MM-DDTHH:MM:SS(.ffffff)?Z`) becomes `<TS>`;
- **nothing else is masked.** Domain slugs, names, `scope` values, validation
  field names and the non-UUID part of every `detail` message stay intact, so a
  divergence in any of them is still reported.

Objects are compared **order-preserving**: key order is part of these
contracts (`StackResponse` serializes in declaration order), so a reordered body
is reported as a divergence rather than normalized away. Reports name the first
differing path and both truncated values.

### Auth mode preflight

Auth in this service is configuration (`AKS_API_KEY`), not code. Before running
any scenario the harness probes an unauthenticated `GET /stacks` on both targets
and refuses to run if the modes disagree — otherwise every authenticated
scenario would compare a `401` against a `200` and blame the port. Under
`--boot`, the child inherits the harness's environment, so pass the same
`AKS_API_KEY` you gave the oracle.

## The shared-database hazard

**The oracle and the TypeScript server use the same Postgres database.** A naive
differential self-collides: the oracle creates `domain = X`, then the TS `POST
/stacks` with the same body correctly answers `409`, and the harness reports a
false failure. `GET /stacks` is worse, because it returns the whole table — a
fixture left behind by the first target shows up in the second target's list
body and fails the structural comparison.

Two mechanisms were considered: distinct fixture domains per target, and a
deterministic reset between target runs.

This harness implements the **deterministic reset**, because distinct domains
alone cannot work here. `GET /stacks` has no filter, so target-suffixed domains
would make the two list bodies differ by fixture content. Equalizing them would
mean masking `domain` — which the normalization rules forbid, and which would
hide real divergences in the exact field `post-duplicate-domain` exists to test.

The reset runs in three places:

1. before the first target run, reclaiming rows from a crashed earlier run;
2. **between** the two target runs, so both start from identical state;
3. in a `finally` after the last run, so the table is empty even when a scenario
   throws or a comparison fails.

Rows are identified by the `oraclediff-` domain prefix — `domain` is `UNIQUE`, so
it is the natural cleanup key, and the prefix is stable across runs so leftovers
are always reclaimable. Every table referencing `stacks(id)` declares
`on delete cascade`, so cleanup cannot be blocked by a foreign key. Only rows
carrying that prefix are ever deleted.

The run prints the observed counts:

```
database after run: 0 row(s) with prefix "oraclediff-", 0 row(s) in stacks total
```

A non-zero count is reported, not hidden. The harness deletes only its own
prefix, so anything else was left by another writer.

**Do not run two instances concurrently against the same database** — they share
the prefix and would delete each other's fixtures.

## Known gaps — what this harness does NOT prove

Listed rather than silently ignored:

1. **Trailing-slash equivalence.** FastAPI answers `307` to `/stacks/` vs
   `/stacks`; Express routes both through the router. A pre-existing, app-wide
   gap, out of scope for the stacks port.
2. **Malformed-JSON response equivalence.** `{bad` yields the oracle's `422` with
   `type: "json_invalid"` and Python's decoder message, versus Express
   `body-parser`'s `400`. The harness currently exercises only *valid* JSON with
   an invalid shape (`post-non-object-body`), which both servers agree on.
3. **Anything outside the stacks vertical.** Documents, AKS, backfeed, uploads
   and the rest are unported; a green run says nothing about them.
4. **Concurrency.** The `POST /stacks` uniqueness check is racy by design (a
   concurrent duplicate insert surfaces as a `500` on both sides). The scenario
   list is strictly sequential.
5. **Non-human-visible surfaces.** Response headers (beyond what status and body
   capture), `Server`/`Date`, and CORS preflight bodies are not compared.

## Type checking the harness

`tsconfig.json` sets `rootDir: src`, so plain `npm run typecheck` never sees
`scripts/`. `npm run typecheck` therefore runs both programs: the original `src`
check and `npm run typecheck:scripts`, which applies the same strict flags to
`scripts/**/*.ts` through `tsconfig.scripts.json`. The harness is held to the
full repo settings — `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` — with no `any`, no `ts-ignore` and no unchecked
casts.

## Files

- `scripts/oracle-diff.ts` — the harness.
- `tsconfig.scripts.json` — the separate typecheck program for `scripts/`.
- `contracts/openapi.json` — captured oracle OpenAPI document.
- `contracts/validation-422-corpus.json` — request bodies with Pydantic `422` shapes.
- `contracts/validation-422-expected.json` — replayed oracle responses for that corpus.
