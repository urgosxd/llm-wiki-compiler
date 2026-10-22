# Not flakiness: deterministic cross-worktree collision on a shared database

**Corrected.** The first version of this document called the failures
"unreproduced". They are reproduced, and the cause is known.

## The cause

`ts/src/db.test.ts` creates rows with **fixed domains**:
`t04-route-commit`, `t04-route-404`, `t04-route-boom`.

Every Wave 1 worktree has an identical copy of that file, and every worktree
runs its suite against the **same Postgres instance**. So two suites running
concurrently interleave like this:

1. Suite A inserts `t04-route-commit`.
2. Suite B's cleanup, or its own insert/delete cycle, removes it.
3. Suite A asserts `countByDomain("t04-route-commit") === 1` and reads **0**.

Reproduced directly, two `db.test.ts` runs in parallel on the same DB:

```
A: Tests  15 passed (15)
B: Tests  1 failed | 14 passed (15)
   × commits when the handler resolves
```

## Why it looked like flakiness

Because solo runs always pass — 5 consecutive clean runs, plus a run under an
injected churn loop that also passed. The collision only fires when a sibling
suite happens to touch the same fixture domain inside the window between the
insert and the assertion, which is a narrow, timing-dependent window.

It is deterministic in mechanism and nondeterministic in scheduling, which is
exactly the shape that gets misfiled as flake.

## Why the per-slice prefixes did not prevent it

The slice workers were told to use unique prefixes (`w1doc-`, `w1bf-`) and did.
But `db.test.ts` is **pre-existing**, present in every worktree before the
slices started, and its domains were already fixed. The instruction covered new
tests, not the inherited ones.

## The three episodes

| # | Where | Symptom |
|---|---|---|
| 1 | Wave 0 close, main worktree | `2 failed \| 6 passed (8)` — names lost to `head -2` |
| 2 | Wave 1, documents worktree | `2 failed \| 303 passed (305)` — names lost to grep |
| 3 | Wave 1 final sweep | `1 failed \| 304 passed (305)`, **captured**: `db.test.ts > withRequestTransaction > commits a deliberate 404` |

Episode 3 is the one that made this diagnosable, because it was the first run
captured to a full log instead of a truncated pipe.

## Consequences

- Slice verification must be run **sequentially**, or against **separate
  databases**. Running three worktree suites at once against one Postgres
  produces false red.
- Any future parallel fan-out must namespace inherited fixtures too, not only
  new ones. Grep the whole `*.test.ts` set for hardcoded domains before
  splitting.
- The rule stands from the earlier version: never truncate a verification run's
  output. All three episodes cost extra cycles because of it, and this document
  only exists because the third run was captured properly.
