# Unreproduced test failure — Wave 0 close

Recorded because an unexplained red is worse than a documented one.

## Observation

A single `npm test` run reported:

```
Failed Tests 2
Test Files  2 failed | 6 passed (8)
```

Immediately afterwards, and on every subsequent attempt, the same suite reports
253 passed / 253 across 8 files.

## Attempts to reproduce

| Run | Condition | Result |
|---|---|---|
| 1 | plain | 253/253 |
| 2 | plain | 253/253 |
| 3 | plain | 253/253 |
| 4 | concurrent Docker psql loop against the same DB | 253/253 |

Also checked at the time: no leftover `dist/index.js` or harness process, and
`pg_stat_activity` showed a single active connection (the check itself).

## What is known and what is not

The failing run did happen; it is not a misread. The specific failing test names
were lost because the output was piped through `head -2`, which truncated the
report. That truncation is my mistake, not a property of the suite.

Because the assertion text is gone, the cause cannot be pinned. The plausible
candidates are integer-precision timing in the integration suites, or a
connection-pool race between the DB-backed test files that run as separate
vitest workers against one database. Neither is confirmed.

## Why this is not being closed as "flaky"

Calling it flaky would be a claim I cannot support. What is true is that it is
unreproduced across four runs including one under DB contention.

## What to do if it recurs

Run `npm test 2>&1 | tee /tmp/test.log` without truncation and keep the full
report, which will name the two failing files. Without those names this cannot
be diagnosed further.
