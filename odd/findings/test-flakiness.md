# Two unreproduced test failures across Wave 0 and Wave 1

Both episodes are real: I saw the red output myself. Neither reproduced.

## Episode 1 — Wave 0 close

Single `npm test` in the main worktree: `Failed Tests 2`, `2 failed | 6 passed (8)`.

Followed by 4 clean runs including one under deliberate DB contention. Never
reproduced. The failing test names were lost because the output was piped
through `head -2` — my mistake.

## Episode 2 — Wave 1, documents worktree

```
Test Files  2 failed | 8 passed (10)
Tests       2 failed | 303 passed (305)
```

Reported by the slice worker as 305/305 green before and after. Followed by
five consecutive clean runs, plus a run under an injected concurrent DB churn
loop that also passed 305/305.

The first of those runs was `typecheck && build && test` in one command, while
the mcp and consolidation workers were still active. That timing is the only
distinguishing feature I have, and it is not a confirmed cause.

## What is established

- The failures are real, not misreads. Both printed a red summary.
- Both cleared on immediate retry with no code change.
- Both environments have exactly one shared resource that three parallel slices
  and their test suites all touch: the Postgres instance.

## What is NOT established

- Which tests failed, in either episode. Lost to output truncation both times.
- Whether it is DB contention, pool exhaustion, timing, or something else.
  Deliberate contention did not reproduce it.

## What to do next time

Never pipe test output through `head`, `tail`, or `grep` during a verification
run. Capture the whole thing:

```
npm test 2>&1 | tee /tmp/test-$(date +%s).log
```

Two episodes with no captured names is two episodes too many. If a third
occurs, that log is the only thing that will make it diagnosable.
