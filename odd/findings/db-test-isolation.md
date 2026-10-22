# `db.test.ts` failures were DB contamination, not test isolation

> **CORRECTED.** An earlier version of this document concluded the test was
> order-sensitive. That was wrong. The failures were caused by fixture rows my
> own manual verification left in the shared database. With a clean database
> the suite passes 575/575 three consecutive times, including the specific test
> I had traced.
>
> The ruled-out list below is still accurate and worth keeping. The conclusion
> is not.

## Symptom

`npm test` reports 3–7 failures across DB-backed suites. The one I traced:

```
src/db.test.ts > withRequestTransaction > commits a deliberate 404
AssertionError: expected +0 to be 1
  expect(await countByDomain("t04-route-404")).toBe(1);
```

The count reads 0 where the insert should have committed.

## What is NOT the cause

Verified and ruled out one at a time:

- **Not the transaction wrapper.** A standalone probe against the built
  `dist/` performed the identical insert-then-404 and the row persisted
  (`status: 404`, `filas: [{"domain":"probe404"}]`). Production behaviour is
  correct.
- **Not a stale build.** `rm -rf dist && npm run build` and the failure
  persisted.
- **Not the oracle.** Stopping the Python `api` container made it fail 3/3;
  starting it again also failed 3/3. No dependency either way.
- **Not cross-worktree contention.** Run with `--no-file-parallelism` and it
  still failed.

## What it is

`npx vitest run src/db.test.ts -t "commits a deliberate 404"` → **passes**.

Run the whole file and it fails. So the test is order- or cleanup-sensitive
within its own file: the `t04-route-*` domains are shared by three tests in
that block, and the cleanup deletes by `like 't04-route-%'`, which can remove
another test's row before its assertion runs.

This is the same family as the cross-worktree collision documented in
`test-flakiness.md`, one level down: fixture isolation inside a single file
rather than across worktrees.

## Why it is not fixed here

The fix belongs in the test (unique per-test domains, or cleanup scoped per
test), not in production code. It is recorded as debt rather than patched
silently, because a red suite that hides behind an explanation is worse than a
red suite with a named cause.

## Consequence for CI

This must be fixed before CI can gate on `npm test`, or CI will be red for a
reason unrelated to the code under test. The related cross-worktree collision
is already documented and has the same remedy.
