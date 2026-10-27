-- ------------------------------------------------------------
-- ingest_outbox: allow a 'failed' status
-- ------------------------------------------------------------
-- ## Why this status exists
--
-- Before atomic ingest, a `pending` record was a DEBT: a process had stopped
-- between two dimension commits, and `reconcileOutbox` finished the work by
-- replaying the idempotent commits. `pending` meant "work to be done".
--
-- With atomic ingest (dimension port v3) the coordinator runs both dimensions in
-- ONE transaction and retries that transaction up to two attempts. Both attempts
-- failing rolls the transaction back, which erases the `pending` record along with
-- everything else: there is no debt, because nothing landed.
--
-- That leaves no trail at all, and an operator asking "why did this ingest not
-- appear?" would have nothing to look at. So a `failed` record is written AFTER
-- the rollback, outside the transaction, purely as diagnosis. It is never replayed
-- and never repaired: it describes an attempt that left nothing behind.
--
-- ## Why a new value rather than a new table
--
-- The payload shape (source, title, document, body, dimensions) is exactly what a
-- failed attempt needs to describe itself, and it already carries the RLS policy
-- and the grant. A second table would duplicate both and let them drift.
--
-- `pending` is NOT dropped from the constraint. Old rows mean what they always
-- meant, and the reconciler still has to sweep them.

alter table ingest_outbox
    drop constraint if exists ingest_outbox_status_check;

alter table ingest_outbox
    add constraint ingest_outbox_status_check
    check (status in ('pending', 'committed', 'failed'));

comment on column ingest_outbox.status is
    'pending: work the reconciler should finish (pre-v3 rows). committed: done, swept. failed: both transaction attempts failed; kept as diagnosis only, never replayed.';
