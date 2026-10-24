# Proposal: persist the ontology per Stack (DDL)

**Status:** BLOCKED — needs a human contract decision, not an agent one
**Owner of this analysis:** orchestrator-b (`kg-core-dimension`)
**File under change:** `packages/llmwiki-kg/db/schema.sql` — **writable by no role.**
This document proposes; it cannot implement.

## The blocker, measured

This document previously said the decision belonged to orchestrator-a. That was
wrong, and orchestrator-c was right to reject it. Evaluated against
`contract-cordination.json` with the hook's real precedence
(`/home/urgosxd/.agents/orchestration/src/scope.ts:isPathAllowed` — forbidden,
then shared, then owned, then deny):

| Role | `packages/llmwiki-kg/db/schema.sql` |
| --- | --- |
| orchestrator-a | **forbidden** — `packages/llmwiki-kg/**` is in its `forbiddenPaths` |
| orchestrator-b | shared-read-only |
| orchestrator-c | shared-read-only |

There is no role that can write this file. A shell write is possible (the hook
guards the `write`/`edit` tools) and would be a deliberate bypass of a ratified
control, so it is not an option to take unilaterally.

**Therefore Slice 2 needs a human decision**, in one of three forms:

1. a contract amendment widening one role's `ownedPaths` to cover
   `packages/llmwiki-kg/db/**` for this change, or
2. a human-run migration, with this document as the reviewed artifact, or
3. an explicit deferral, leaving the ontology configurable per run.

Option 3 is fully functional today: the mechanism works from
`KgDimensionOptions.ontology` or `loadOntology(path)`.

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

## Second question: is a column on a product table inside the freeze?

The contract's `_ratified` marker reads *"two-dimension split (A=wiki, B/C=KG),
product surface frozen for every role"*. Adding a column to `stacks` is a change
to a product table, so this may be out of scope even if a writer existed. If it
is out of scope, option 3 above is not a consolation prize — it is the correct
outcome, and this document becomes a record of why.

## Reachability, separately

`cp-2026-10-23-03` covers the barrel re-export, which is orchestrator-c's file.
When that lands, this adapter's `KgOntology` derivation
(`src/dimensions/kg/index.ts:61`) should be deleted and the type named directly —
it exists only because the barrel hides the type, as orchestrator-c observed.
