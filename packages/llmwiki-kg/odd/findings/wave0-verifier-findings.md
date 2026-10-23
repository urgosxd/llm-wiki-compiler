# Wave 0 verifier findings

> **STATUS: ALL FIVE MAJOR FINDINGS CLOSED.**
>
> M1 and M2 fixed in `8960986`. M3, M4 and M5 fixed in `be83455`.
> Each fix was re-verified independently against the live oracle rather than
> accepted on the implementing worker's report: 9/9 method/Allow cases match,
> the 500 is 21 bytes text/plain on both sides, allow-methods is identical
> including QUERY, a no-Origin GET omits allow-origin on both, and all six
> emoji boundary cases agree. Full suite 253/253 across 8 files, oracle-diff
> 18 passed exit 0.
>
> The three MINOR items (timestamp-mask fraction optional, case-insensitive
> UUID mask, 204 content-type) remain open as coverage gaps, not live bugs.
>
> The findings below are kept in their original form as the record of what
> the verifier found and how it was confirmed.

Produced by an independent read-only verifier, then each MAJOR finding
re-confirmed by hand against the live oracle before being accepted.

Approximate 120 hand-built probes found five classes of divergence the
oracle-diff harness could not see. That number is the empirical measure of the
harness's blind spot, not an estimate.

## MAJOR

### M1 — Harness reports PASS when both URLs point at the same server
`ts/scripts/oracle-diff.ts` has no `oracleUrl !== tsUrl` guard.

Re-confirmed by hand:
```
npx tsx scripts/oracle-diff.ts \
  --oracle-url=http://localhost:8000 --ts-url=http://localhost:8000
→ 18 passed, 0 failed ... RESULT: PASS   exit 0
```

Eighteen green checks for a comparison that structurally cannot fail. This is
the third silent-green class in this harness; the other two (ids captured from
the normalized body, and aborted runs printing PASS) were already fixed. The
guard belongs beside them.

### M2 — `name` length counts UTF-16 units where Python counts code points
`ts/src/errors.ts` uses `value.length`; Python's `max_length=200` counts
code points. Astral characters are 2 UTF-16 units each.

Re-confirmed by hand:

| name | code points | UTF-16 units | oracle | port |
|---|---|---|---|---|
| 100 × emoji | 100 | 200 | 201 | 201 |
| 101 × emoji | 101 | 202 | **201** | **422** |
| 150 × emoji | 150 | 300 | **201** | **422** |
| 200 × "a" | 200 | 200 | 201 | 201 |

Correct at the BMP boundary, wrong for astral text. Fix: count with
`[...value].length`. Not covered by any test.

### M3 — Method-not-allowed family diverges wholesale
`ts/src/server.ts` catch-all returns 404; FastAPI returns 405 with an `Allow`
header. Re-confirmed: `HEAD /stacks` 405 vs 200, `PUT /stacks` 405 vs 404,
`DELETE /stacks` 405 vs 404, `PATCH /health` 405 vs 404. Ten cases in the
verifier's matrix.

`HEAD /stacks` returning 200 with a full body is the worst of these.

### M4 — 500 wire format diverges
Re-confirmed with real rows: both return 500, but
oracle → `text/plain`, body `Internal Server Error` (21 bytes);
port → `application/json`, body `{"detail":"Internal Server Error"}` (34 bytes).

This retroactively weakens a documented "known gap": the PATCH-explicit-null
case was recorded as "500 on both", which is true only for the status code.

### M5 — CORS differs in two ways
- Preflight `access-control-allow-methods`: oracle includes `QUERY`, port does not.
- With no `Origin` header: oracle omits `access-control-allow-origin`, port sends `*`.

The port's comment claims to mirror the oracle exactly.

## MINOR

- Harness timestamp mask makes the fraction optional (`(?:\.\d{6})?Z`), so a
  total loss of fractional seconds compares equal. A 3-digit `toISOString`
  regression is still caught, so the primary risk is covered.
- Harness UUID mask is case-insensitive, so a casing regression is invisible.
  Current code emits lowercase correctly; coverage gap, not a live bug.
- 204 content-type header differs; body is genuinely empty on both.

## What held up

Contract drift: none. All 22 Pydantic models match all 22 Zod schemas field for
field and in declaration order, verified programmatically. `max_length=200` is
present in both — the earlier scout summary that dropped it was wrong and the
code was right.

Timestamp precision: correct end to end, 27 chars, 6 fractional digits, `Z`, on
create, read-back and PATCH. No `Date` anywhere on the serialization path.

Transactions: rollback confirmed after a real write (serialization failure
rolls back the UPDATE), commit confirmed on deliberate non-2xx with actual row
counts.

## Verdict carried forward

The stacks vertical is a faithful port of the **response** contract. It is not
a faithful port of the full **HTTP** contract: what diverges lives in the
Express mount, the error handler and the CORS shim, not in the DTO/route logic
the port concentrated on.

The harness is the more consequential problem: green means less than it
appears.
