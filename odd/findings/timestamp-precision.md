# Finding: JavaScript truncates timestamps to milliseconds

Discovered while capturing the live oracle contract during Wave 0. Affects every
endpoint that returns a `timestamptz` column, which is most of them.

## Evidence

Python oracle, `GET /stacks/{id}`:

```
created_at: "2026-10-21T03:16:59.138144Z"   27 chars, 6 fractional digits, Z suffix
```

Node, `new Date().toISOString()`:

```
"2026-10-21T03:16:59.228Z"                  24 chars, 3 fractional digits, Z suffix
```

## Why it matters

`Date.prototype.toISOString()` is specified to emit exactly three fractional
digits. Postgres `timestamptz` carries microsecond precision. Any TS serializer
that round-trips a row through `Date` and then calls `toISOString()` silently
loses the last three digits, and a naive oracle diff will report a mismatch on
every timestamped response even when behavior is otherwise identical.

The problem is asymmetric and easy to misdiagnose: the difference only shows up
when the microsecond remainder is non-zero, so roughly 999 out of 1000 rows
mismatch, making it look like flaky output rather than a systematic bug.

## Options for the TS serializer

1. Carry the raw Postgres text and emit it unchanged. Cheapest and most faithful:
   the oracle's string is already correct, so never parse it into a Date at all.
2. Parse to a Date plus keep the original string, preferring the string on
   serialization.
3. Format from a Date with a custom 6-digit formatter. Works, but requires a
   Date that did not already lose precision, so the value must arrive as text
   rather than as a JS Date.

Option 1 is the recommendation: configure the driver so timestamptz columns are
delivered as strings, not Date objects, and pass them through untouched.

## Contract notes captured alongside this

- Timestamps are tz-aware and always end in `Z`, never `+00:00`.
- `stacks.compilation_strategy` is NULLABLE in the database
  (`is_nullable = YES`) even though `StackCreate` requires it with default
  `'incremental'` and `StackResponse` types it as non-optional `str`. A row
  inserted outside the API could therefore violate the response model. The
  Python server would raise a response-validation error in that case. The port
  must decide consciously: mirror the strictness or tolerate the null.
- `stacks.id` defaults to `gen_random_uuid()` server-side, so inserts never
  supply an id.
