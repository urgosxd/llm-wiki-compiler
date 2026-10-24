# Feature: a Stack's ontology is declared at creation and enforced at ingest

**Status:** in progress
**Owner:** orchestrator-b (`kg-dimension`)
**Contract:** `contract-cordination.json` version 1

## Goal

A caller creates a Stack with `entityTypes`, `relationshipTypes` and `subtypes`,
and every subsequent ingest of that Stack respects the declaration. The
declaration must also be readable back, so "was my config actually stored" is a
question with an answer that does not require a psql prompt.

## What the human decided

1. **Expose `ontology` on the Stack response** rather than adding a sibling route.
   Chosen knowingly over `GET /stacks/{id}/ontology`: the response shape gains a
   key, and that is a deliberate departure from the oracle.
2. **Guarantee create -> ingest respects the declaration.** A Stack created with
   an ontology must be enforced from its first ingest, and a declaration that
   cannot be enforced must be refused at creation rather than at ingest.

## The three gaps this closes (measured, not assumed)

| Gap | Evidence before this change |
| --- | --- |
| Nothing echoes the declaration | `StackResponse` has nine keys; `stack_ontology.ts:7` records "The obvious place for a Stack's ontology is POST /stacks. It cannot go there." |
| No semantic validation at create/update | The route only checks the field is a `dict` via `OntologyInput`. A cycle or an undeclared subtype endpoint is stored, then `validateOntology` throws inside the ingest transaction -> uncaught -> 500 on every later ingest of that Stack. |
| The dimension never reads the column | `KgDimensionOptions.ontology` exists and `activation.ts:115` never passes it; `src/dimensions/kg/index.ts` contains no SQL. `test/dimensions/kg-core-ontology-read.test.ts` claims the dimension reads the stored ontology, but only asserts the option is threaded to `extractGraphFromChunks`. |

## Decisions taken while implementing

### Response key position: appended last

`StackResponse` gains `ontology` as its **tenth and final** key, which is also
where `STACK_COLUMNS` already selects it. Two reasons: the oracle's first eight
keys plus its two timestamps keep their exact order and positions, so a consumer
diffing against a Python response sees an addition rather than a reshuffle; and
one order (column order == schema order) is not two orders that can drift.

This is a real departure from `oracle/contracts/openapi.json`, which has no
`ontology` on `StackResponse`. It is recorded here rather than in code alone,
because the oracle server no longer exists to re-measure a divergence.

### The exposed value is the declaration as stored

`ontology` is echoed as the raw `jsonb` document, and is `null` when the Stack has
no declaration. Echoing the *normalised* form (`validateOntology` upper-cases and
underscore-joins type names) was rejected: the response would then disagree with
what the caller sent, and `StackResponse.parse` runs on read, so a Stack whose
stored declaration is malformed would make **every read of that Stack** throw.
The raw document keeps reads total and matches the write in both directions.

Semantic enforcement at write time is what guarantees the stored document is
valid, so the read path never has to be the validator.

### `null` still means the oracle's behaviour

Omitting `ontology` on create leaves the column NULL, `readStackOntology(null)`
returns `undefined`, and the extraction call keeps its original two-argument
arity. That is the existing invariant and this change does not touch it.

## Tasks

- [x] 1. Write the ODD task document and its Engram mirror
- [ ] 2. RED: tests for `StackResponse.ontology` exposure and the create-time 422
- [ ] 3. Expose `ontology` in `StackResponse` and update the response-key fixtures
- [ ] 4. Validate the declaration at `POST`/`PATCH /stacks`, refusing 422
- [ ] 5. RED: tests for the dimension reading `stacks.ontology` at `prepare`
- [ ] 6. Dimension reads the stored declaration and passes it to extraction
- [ ] 7. `tsc`, `build`, `test:affected`, `fallow`

## Scope boundary

Everything this change touches is inside this role's `ownedPaths`:
`packages/llmwiki-kg/ts/src/core/**`, `.../ts/src/*.ts` (the barrel),
`src/dimensions/kg/**`, `test/dimensions/kg-core-*`. Nothing here writes the
shared DDL: `stacks.ontology` already exists (`db/schema.sql:266`,
`db/migration_stack_ontology.sql:39`).

## Evidence log

- **Tasks document written** before the first source edit.
