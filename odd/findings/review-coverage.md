# Native review coverage — Wave 0

What the native review actually approved, what it did not, and why. Recorded so
a later reader does not mistake "Wave 0 closed" for "Wave 0 fully reviewed".

## Approved

| Candidate | Scope | Result |
|---|---|---|
| `.gitignore` (10 lines) | working-tree change | approved, burned (5 cycles: 3 approved, 1 declined, 2 consent expiries) |
| `be83455` — 405 / 500 / CORS | 5 files, 1,011 lines, medium tier, reliability lens | **approved, burned.** Two advisory WARNING findings, both non-blocking: R3-001 at `http-contract.ts:186-223`, R3-002 at `server.ts:139-140` |

The advisory findings are recorded here rather than fixed, because the native
review explicitly classified them as informational with no correction
transition offered. They are candidates for later work, not open defects.

## Not covered by native review

`8960986` — the harness silent-green guards and the code-point length fix,
49 real lines.

An attempt was made and it failed for structural reasons worth recording:

- The candidate was taken as `874e269..HEAD`, which re-included the already
  approved `be83455` and pulled the whole 1,123-line range.
- `oracle-diff.ts` spawns child processes, so the tier rose to `high` and four
  lenses became mandatory.
- The four-lens group stalled: `review-reliability` was aborted by the caller
  at 764,826 ms with a 953,271 ms timeout still remaining. The group reports
  `prepared_reviewers: 0`, `submitted_reviewers: 0`, `mutation_outcome: none`,
  so no authority was burned, but no lens was admitted either.

Note the review projection is `base-ref..HEAD`, not a single commit. Once later
commits land on top, an earlier commit cannot be isolated without moving HEAD,
so re-targeting it means re-reviewing everything above it.

## Why the gap is acceptable for `8960986`

Not a hand-wave; the specific evidence is:

- 253/253 tests pass across 8 files.
- The oracle-diff harness passes 18/18 with exit 0.
- The code-point fix was verified by hand against the live oracle on all six
  boundary cases: 100/101/150/200 emoji accepted on both sides, 201 emoji
  rejected on both, and 200/201 ASCII unchanged. Before the fix, 101 and 150
  emoji diverged (oracle 201, port 422).
- Both harness guards were verified by exit code: same-URL exits 2,
  unrecognized flag exits 2, valid flags exit 0 after a real comparison.

## What this does not claim

Wave 0 is closed as *verified*, not as *fully natively reviewed*. The unapproved
49 lines are small, mechanical, and covered by direct differential testing
against the oracle, but they have not had an adversarial lens over them. If
that matters later, the honest route is a slot-by-slot capture, which degrades
to partial success instead of all-or-nothing.
