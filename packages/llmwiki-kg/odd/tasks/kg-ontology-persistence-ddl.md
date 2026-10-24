# Proposal: persist the ontology per Stack (DDL)

**Status:** awaiting ratification — no code written
**Owner of this analysis:** orchestrator-b (`kg-core-dimension`)
**File under change:** `packages/llmwiki-kg/db/schema.sql` — **shared, read-only for
every role.** This document proposes; it does not implement.

## Why this is a separate proposal from the barrel contract

Two different owners gate this feature:

| Piece | File | Owner |
| --- | --- | --- |
| Re-export the ontology surface | `ts/src/core-index.ts` | orchestrator-c |
| Add the column | `db/schema.sql` | **shared** (needs orchestrator-a) |
| Read the column at ingest | `ts/src/routes/ingest/**` | orchestrator-c |

`cp-2026-10-23-03` covers only the barrel. This covers only the schema. Mixing
them would put one ratification behind another owner's decision.

## Measured starting point

`stacks` today (`schema.sql:13-27`) has no ontology column and no `jsonb` at all —
the four existing `jsonb` columns live in `stack_documents.audit`,
`ontology_entities.properties`, `backfeed_queue.proposal`, and
`backfeed_queue.metadata`. So persistence cannot piggyback on an existing field.

## Proposed DDL

Idempotent, matching the file's existing convention (`create table if not exists`,
`add column if not exists`), so it is safe to re-apply against a live database:

```sql
alter table stacks
    add column if not exists ontology jsonb;

alter table stacks
    add constraint valid_ontology_is_object
    check (ontology is null or jsonb_typeof(ontology) = 'object');
```

### Why `jsonb` and not a relational taxonomy

The declaration is read and written as one document, versioned as a whole: an
entity type and the subtypes that reference it are only meaningful together, and a
half-applied edit would produce an ontology whose hierarchy points at types that no
longer exist. One column makes the write atomic; a `stack_entity_types` table
would spread that invariant across rows with no natural transaction boundary.

### Why `null` is legal and meaningful

`ontology is null` is not "empty ontology" — it is **the oracle's behaviour**:
advertise the default type hints, accept whatever the model emits. That is the
current behaviour of every existing Stack, so a nullable column means existing
rows keep working with no migration and no backfill. A non-null column with a
`{}` default would silently switch every existing Stack into enforcement mode,
rejecting triplets they currently accept.

### Why the check is only `object`

The database validates *shape*, not *semantics*. Cycle detection, undeclared
parents, and duplicate types are already enforced by `validateOntology` at load
time and produce a specific, actionable error. Duplicating those rules in SQL
would produce a constraint violation naming nothing useful, and the two
implementations would drift.

## What must NOT change

- `ontology_entities.type` and `ontology_relationships.type` stay `text`
  (`schema.sql:132`, `:181`). Enforcement happens before the insert, in
  `parseTripletsWithOntology`; a SQL enum or FK would reject rows the application
  already accepted and would make the ontology immutable once data exists.
- No backfill. Existing Stacks stay `null`.
- No change to `ontology_entities.properties`.

## Migration mechanics

This package has **no migration runner**: `schema.sql` is applied idempotently, and
`migration_synthesize_descriptions.sql` was applied by hand with
`docker compose exec db psql -f ...` and is *also* duplicated into `schema.sql`
(around line 247). Following that precedent, the change belongs in `schema.sql`
plus a matching `migration_stack_ontology.sql`.

## Definition of done for this slice

1. Column and constraint present; `schema.sql` re-applies cleanly twice.
2. `POST /stacks` and `PATCH /stacks/{id}` accept and return `ontology`
   (orchestrator-c; a contract change against
   `ts/oracle/contracts/openapi.json`, currently closed on the field set).
3. Ingest resolves the Stack row, validates the stored document with
   `validateOntology`, and passes it to `extractGraphFromChunks`.
4. `loadOntology` from a path remains supported, so a Stack with `null` can still
   be driven by a file without a schema write.

## Open question for orchestrator-a

Was the ontology column declared out of scope for the frozen product surface? The
contract marks the product surface frozen for every role, and this is a schema
addition to a product table. If it is out of scope, this slice should be deferred
rather than ratified — the mechanism already works from configuration, so the
feature is usable without it.
