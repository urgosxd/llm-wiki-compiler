# Float bounds cannot be reproduced in JSON from JavaScript

## Observation

Pydantic distinguishes a float bound from an integer bound when it serializes
a validation error, and the live oracle proves it:

```
confidence: 1.5  -> {"type":"less_than_equal", ..., "ctx":{"le":1.0}}
limit=0          -> {"type":"greater_than_equal", ..., "ctx":{"ge":1}}
```

The TypeScript port emits `{"le":1}` in both cases.

## Why it cannot be fixed

It is a language limitation, not an implementation defect.

```
JSON.stringify({ le: 1.0 })  ===  '{"le":1}'
1 === 1.0                     ===  true
```

JavaScript has one numeric type. `1.0` and `1` are the same IEEE-754 value, so
no amount of care in `String()` or a `toJSON` hook can make `JSON.stringify`
emit a trailing `.0` — the information that the bound was a float is gone
before serialization ever happens.

Reproducing it would mean hand-building the JSON string for validation error
bodies and injecting `.0` for float-typed bounds.

## Why it is not worth doing

The two forms are the same JSON value:

```
JSON.parse('{"le":1.0}').le === JSON.parse('{"le":1}').le   // true
typeof ... === "number"                                     // both
```

Every conforming JSON parser collapses them to the identical number. A client
that reads `ctx.le` cannot observe a difference. Only a textual byte-diff of
the raw body can, which is why our harness surfaced it.

## Consequence for the oracle-diff harness

The harness compares parsed JSON, so it does not flag this. The three byte-level
diffs the consolidation slice reported came from a separate raw-text probe, not
from the harness.

## Decision

Accepted as a documented wire-format divergence. The contract semantics —
which error type, which `loc`, which `msg`, and the numeric bound value — all
match. If a future client is found that depends on the textual `.0`, the honest
fix is a custom serializer for validation bodies, and this document is the
record of why it was not done by default.
