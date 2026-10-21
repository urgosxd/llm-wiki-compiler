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

1. Carry the raw Postgres text and emit it unchanged. **This does NOT work —
   corrected in T0.4 after measuring the wire format.** See below.
2. Parse to a Date plus keep the original string, preferring the string on
   serialization. Loses nothing if the string is kept, but the Date is dead
   weight and a future refactor can start using it by mistake.
3. Format from a Date with a custom 6-digit formatter. Broken: the Date has
   already lost the precision by then.
4. **Recommended, and what shipped.** Normalize the raw text into the oracle's
   shape with a string transform that never constructs a Date.

## Correction: pass-through is impossible

The original recommendation in this document (option 1) was wrong. Postgres
does not transmit the oracle's format:

| Source | Value |
|---|---|
| Postgres wire text | `2026-10-21 04:00:16.902445+00` — space, no `T`, `+00` suffix |
| Python oracle | `2026-10-21T04:00:16.902445Z` — `T`, `Z` suffix |

Emitting the wire text untouched fails both "ends with Z" and "6 fractional
digits". Postgres also trims trailing zeros, so `.100000` arrives as `.1` and
`.000000` arrives with no fraction at all — the digits are not even
fixed-width on the way in.

The correct boundary is `normalizeTimestamptz()` in `ts/src/db.ts`: it rewrites
the **string**, padding the fraction to 6 digits and substituting `T`/`Z`. The
microsecond digits survive as characters throughout; no `Date` is ever built.
This is not the anti-pattern the finding warns about — that anti-pattern is
formatting a `Date` after precision is already lost.

Two supporting details, both load-bearing:

- `drizzle()` silently overwrites the OID 1184 parser with an identity parser,
  so the parser must be re-installed **after** `drizzle()` runs. Otherwise the
  fix is discarded and `Date` objects come back.
- `DateStyle=ISO, MDY` and `TimeZone=UTC` are pinned on the connection so the
  parser's input grammar is guaranteed. `normalizeTimestamptz` throws on
  unrecognized text rather than falling back silently, because a silent
  fallback would reintroduce the precision bug.

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
