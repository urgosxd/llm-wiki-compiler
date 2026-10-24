# W3.4 retire split — what happens to the two tests, and why T3 cannot land in this order

## Context

`wq-2026-10-24-04` asks this role to delete `src/dimensions/wiki/index.ts` and
migrate or delete `test/dimensions/wiki-dimension.test.ts` and
`test/dimensions/cross-dimension-rollback.test.ts`, while the integration role
wires `activation.ts` and `dimensions/index.ts` afterwards.

Status: **BLOCKED on ordering, plus one finding that changes T3's definition.**

## Blocker 1 — deleting the file first cannot compile

Measured, not predicted. With `src/dimensions/wiki/index.ts` removed and nothing
else changed:

```
src/dimensions/activation.ts(19,37): error TS2307: Cannot find module './wiki/index.js'
src/dimensions/index.ts(34,37):      error TS2307: Cannot find module './wiki/index.js'
```

Both files are `sharedPaths` — main's to write, forbidden to me — and both import
`createWikiDimension` from the file I am asked to delete:

- `src/dimensions/activation.ts:19` imports it, `:102` calls `createWikiDimension(options.root)`.
- `src/dimensions/index.ts:34` re-exports it from the public barrel.

So the split as written produces a red `tsc` that only main can fix, in a
different commit, on a different branch. That is not a reviewable sequence: it is
a broken tree held open across two owners.

**The order that works:** main wires `activation.ts` and `index.ts` to
`createWikiStoreDimension` FIRST (it already has the Stack id and the pool, so
this is the real content of T3 anyway), and only then does `index.ts` become
unreferenced and safe to delete. Deleting it first is the only step that requires
a red build in between.

Awaiting main's confirmation of that order. Nothing is deleted here.

## Blocker 2 — the DB `discard` is a no-op, so one of these tests cannot be migrated

This is the finding worth reading before T3 or T4 is scheduled.

The filesystem dimension implements `discard` as a real revert: it replays the
journal's recorded pre-state (`index.ts`, `revertEntry` per batch entry). The
database dimension implements it as **nothing**:

```ts
// store-dimension.ts
async discard(): Promise<void> {
  // Nothing to undo: `prepare` only reads and computes.
}
```

That comment is true of `prepare`, and false about what the coordinator uses
`discard` FOR. `rollbackCommitted` (`coordinator.ts:97-109`) calls
`run.dimension.discard(run.prepared)` on dimensions that have **already
committed** — it is the compensation path, not a prepare-abort path. Against the
filesystem dimension that reverts bytes. Against the database dimension it
returns `undefined` and the row stays.

**Consequence:** once the wiki dimension is database-backed, a `kg` commit failure
leaves the wiki page committed, and `cross-dimension-rollback.test.ts` — the suite
whose whole subject is "a failure in one dimension leaves the other unwritten" —
would fail. It cannot be "migrated onto `createWikiStoreDimension`" while also
asserting its current property, because the property does not hold on that path.

This is not a test problem. It is the same inversion `multi-tenant-storage.md`
predicted in `## The ordering assumption this breaks`: with both dimensions
remote, `discard` stops being "local, reliable" and becomes a compensating action
that has to be designed. W3.1 exists for exactly this and is still open.

### The honest options for that suite

1. **Keep the rollback property, move it out of the wiki path (recommended).**
   Rewrite the suite to pair a *stub* wiki dimension that reverts with the
   exploding second dimension, asserting the coordinator's compensation protocol
   in isolation. `coordinator.test.ts` already covers ordering and compensation
   with mocks on both sides, so this would duplicate it unless framed as the
   protocol under a REAL revert implementation. Alternatively point the suite at
   the KG dimension's own `forget`/compensation seam.
2. **Assert the new, weaker truth explicitly.** Rewrite the suite to assert that
   after a `kg` failure the wiki row REMAINS and the outbox is left `pending` for
   the reconciler, with the comment saying plainly that cross-store atomicity is
   not provided and W3.1 is why. This trades a guarantee for honesty, which is
   better than a green suite over a property nobody has.
3. **Delete it** and let W3.1 own the replacement. Cheapest, but it removes the
   only test that ever measured cross-dimension rollback and leaves a gap until
   W3.1 lands.

Recommendation: option 2, then option 1 as the W3.1 design lands. Option 2 keeps
a test where the suite is, states the real behaviour, and does not pretend a
guarantee that the database path cannot keep.

## The two test files are not the same kind

`wiki-dimension.test.ts` (7 tests) asserts the filesystem dimension
specifically: it writes `sources/`, discards a journal batch, restores bytes,
leaves no journal behind. Every assertion is about FILES AND THE JOURNAL. When the
file-backed path is deleted, its subject is deleted with it, and migrating it onto
the database calls would produce a different suite wearing the same name.

What survives from it and is already covered elsewhere, against real Postgres:

| Property asserted | Where it already lives |
| --- | --- |
| writes and reports `created` | `wiki-store-dimension.test.ts` |
| reports `unchanged` on identical content | same |
| content-derived idempotency key | `wiki-store-dimension.test.ts` (key format) |
| update in place, no fork | same |
| empty-slug and collision guards | same |

What does NOT survive migration and has no database equivalent: journal
revert-on-discard, restored previous bytes, "leaves no journal behind". Those die
with `trust/journal.ts` (T5), not with this file.

So for `wiki-dimension.test.ts` the honest answer is **delete, not migrate**, and
say which properties moved to which suite. Migrating it would create a second
copy of `wiki-store-dimension.test.ts` under a misleading name.

## What this role can do now, without the blocker

Nothing destructive. The analysis above is the deliverable; the file deletion and
both test rewrites wait on main's wiring order. Deliberately did not delete the
file to "make progress": a red build shared across two branches is worse than a
blocked task.

## Evidence log

- Simulation performed and reverted: `cp index.ts /tmp`, `rm`, `npx tsc --noEmit`,
  restore. Errors quoted verbatim above; tree restored, `tsc` exit 0 afterwards,
  `git status` clean apart from untracked `.codegraph/`.
- Read rather than assumed: `coordinator.ts:97-109` (rollback calls `discard` on
  COMMITTED dimensions), `store-dimension.ts` `discard` body (empty),
  `index.ts` `discard` body (real revert), both test files in full, and every
  importer of `wiki/index.js` (only `activation.ts:19` and `index.ts:34`, plus the
  two tests).
