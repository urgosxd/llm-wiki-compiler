# Stranded jobs are never evicted

Status: open, low urgency (bounded by `MAX_JOBS`), filed 2026-10-28.

## What was measured

Three durable rows in `wiki.ingest_job` hold a non-terminal compile status:

| ingest | compile | age at measurement |
| --- | --- | --- |
| succeeded | running | 16 min |
| succeeded | queued | 41 min |
| failed | queued | 44 min |

None of the three ever settled, and the host has been running continuously.

## Why this matters only a little, and why it still matters

`isSettled` (`src/services/ingest/jobs/registry.ts:67`) requires a terminal compile
status — `skipped`, `succeeded`, `failed`, or `busy`. Eviction skips anything that is not
settled, deliberately: dropping the record of work still in flight would erase a status a
caller is polling for.

So a job that never reaches a terminal compile is never evictable. With `MAX_JOBS = 200`
that is a slow leak rather than an outage, which is why this is filed rather than urgent.
It is still a leak: nothing can ever reclaim those rows, and they count against the cap
that exists to bound the table.

## What is NOT the cause

`e8762b6` fixed the case where an ingest failure left `compile: queued` forever. It is
applied and it works — verified by forcing a failed ingest (`/no/existe/esto.md`) against
the current build, which settled to `ingest: failed, compile: skipped`.

The three stranded rows predate that fix. They are residue, not a live reproduction.

## What is left to find

No live reproducer yet. The three shapes above are the only evidence, and two of them
(`succeeded/queued`, `failed/queued`) are exactly what `e8762b6` prevents, so they are
explained. The one worth chasing is `succeeded/running`: the ingest half completed and the
compile half started but never reported a terminal state. That is either a process that
died mid-compile (the host has been restarted several times today) or a compile path that
can throw outside the `try` that settles it.

Cheapest next step: reproduce `succeeded/running` by killing the host mid-compile and
checking whether the row settles on restart. If it does not, there is no recovery on boot
and the fix belongs there rather than in the compile path.
