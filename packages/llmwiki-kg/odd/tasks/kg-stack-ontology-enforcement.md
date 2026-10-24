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
- [x] 2. RED: tests for `StackResponse.ontology` exposure and the create-time 422
- [x] 3. Expose `ontology` in `StackResponse` and update the response-key fixtures
- [x] 4. Validate the declaration at `POST`/`PATCH /stacks`, refusing 422
- [x] 5. RED: tests for the dimension reading `stacks.ontology` at `prepare`
- [x] 6. Dimension reads the stored declaration and passes it to extraction
- [x] 7. `tsc`, `build`, `test:affected`, `fallow`

## Scope boundary

Everything this change touches is inside this role's `ownedPaths`:
`packages/llmwiki-kg/ts/src/core/**`, `.../ts/src/*.ts` (the barrel),
`src/dimensions/kg/**`, `test/dimensions/kg-core-*`. Nothing here writes the
shared DDL: `stacks.ontology` already exists (`db/schema.sql:266`,
`db/migration_stack_ontology.sql:39`).

## How the compiler path was wired, and why not in `activation.ts`

The obvious insertion point was `src/dimensions/activation.ts`, which builds the
dimension from the environment. It is `shared-read-only` for this role, and the
enforcement hook refused the edit — correctly, and the refusal is what forced a
better design rather than a workaround.

`createKgDimension` now **defaults** `loadOntology` to `loadStoredOntology`
instead. That is stronger than injecting at one call site: every consumer of the
dimension — the compiler, the host server, the ingest service, and any future
one — reads the Stack's declaration without having to know the column exists.
Injection is still honoured, which is how tests state "this Stack has no
declaration" without a database.

An intermediate attempt wired it only when a caller passed `loadOntology`, and
`fallow` caught the consequence immediately: `ontology-store.ts` was reported as
an unused file. A dead reader was the honest signal that the guarantee was not
actually closed.

## Evidence log

- **Tasks document written** before the first source edit.
- **Task 2 (RED).** `dto-stack-ontology.test.ts` — 8 of 10 failed before
  `dto.ts` changed, for the right reasons (`ontology` absent from the parsed
  response and no rejection of an empty type list).
- **Task 4 caught a real bug in the DTO.** Returning `validateOntology`'s output
  put `parentsOf: Map` into the value that `stacks.ts` persists with
  `JSON.stringify`, which would have written `parentsOf: {}` into the column —
  exactly what `stack_ontology.ts` says must never be persisted. The fix is
  `toStoredOntology`, the function that module exists for and that until now was
  called only from tests.
- **Task 6 found a 500 nobody had tested.** Adding a required field to
  `StackResponse` without adding it to `STACK_COLUMNS` made every Stack read fail
  its schema parse inside the transaction: 13 live-database tests went red with
  `500`. Verified as mine, not pre-existing, by stashing and re-running.
- **Suite scope and result.** `npx vitest run packages/llmwiki-kg/ts/src`:
  64 files, 628 passed, 0 failed, 3 skipped (gateway suites, opt-in).
  `test/dimensions/kg-*` + `activation.test.ts`: 27 passed.
  `npm run test:affected`: 1195 files / 10197 tests passed, 2 failed in
  `test/connectors/legacy-capacity-parity.test.ts` under parallel load — that
  file passes 3/3 in isolation both with and without this change, so it is
  load-sensitivity, not a regression, and it is reported rather than hidden.
- **`npx tsc --noEmit`** exit 0. **`npm run build`** exit 0.
  **`npx fallow`** — no dead code, no duplication, 0 issues.
- **Commit.** `d04fcc5` — `feat(kg): expose a Stack's ontology and enforce it at ingest`.

## The end-to-end ingest test, and the two things it caught

`ts/src/routes/ingest-ontology.test.ts` creates a Stack through `POST /stacks`
with a declaration, ingests a document through
`POST /stacks/:id/documents/:doc/ingest`, and asserts against the graph tables
which types actually reached them.

It had to be written because **no existing suite executed this path**. The
contract suites ingest a whitespace-only document so no provider call happens,
and the gateway suite creates its Stack with a direct `insert` that carries no
declaration. The property the feature exists for had unit coverage at both ends
and no test across the middle.

### The provider config trap

The first run passed structurally but wrote nothing: `installFetchStub` recorded
calls to `api.openai.com` and `api.anthropic.com` instead of the stub. The cause
is that `config` parses `process.env` once at module load, and the pipeline
reaches it through `../config.js` — so the `vi.hoisted` block in
`ingest-harness.ts` runs too late, because a helper module is imported after the
test file's own imports begin resolving. The block has to live in the test file
itself; `core/extraction-graph.test.ts` documents the same constraint.

What makes this worth recording is the failure mode: no error, no exception, a
200 with `entities_extracted: 0`. A test asserting only the response envelope
would have passed while never exercising enforcement at all.

### The test is falsifiable

Bypassing `ontologyArgument` to always return `[]` turns 3 of the 4 tests red;
the survivor is the "no declaration" case, which correctly must not enforce.
That is the check that the suite measures enforcement rather than the shape of a
successful response.

## Decision: the supported ontology shape is FLAT

The human settled the hierarchy question by choosing the flat shape —
`entityTypes` plus `relationshipTypes`, no `subtypes` — "para no complicarnos".

This is not a reduction: it is what the code already does. `readSubtypes` returns
`[]` when the field is absent, so a flat declaration and an absent hierarchy are
the same ontology, and `ontology-flat.test.ts` pins that equivalence.

### What was measured before deciding

With no hierarchy the feature rests entirely on **one** thing: the declaration and
the model agreeing on a spelling. Both sides normalise with
`replaceAll(" ", "_").toUpperCase()`, one in `ontology.ts` and one in
`graph-parse.ts`. `ontology-flat.test.ts` states that agreement from both
directions — a model emitting `company`, a declaration written
`ORGANIC ORGANIZATION` — because breaking either side rejects every triplet while
the declaration still looks correct.

### Why the hierarchy was not the answer

Measured, not assumed: with a hierarchy declared and the same model output, the
admission result is identical to the flat shape, in all six cases tried. Two
independent reasons, each sufficient:

1. `graph-prompt.ts` interpolates only `entityTypes` and `relationshipTypes` into
   the tool schema. The model is never told the hierarchy exists.
2. `rejectTriplet` calls `isEntityTypeAllowed(ontology, endpointType,
   ontology.entityTypes)` — passing the declared type list as the *required* set.
   `validateOntology` already forces every subtype endpoint into that list, so the
   question reduces to "is this declared type in the declared types".

`isEntityTypeAllowed` is correct and tested in isolation; it simply cannot change
an admission decision on the path that matters. Making it matter would require
allowing a child to be declared by its ancestor only, which is a semantic change —
and one that would retroactively reject triplets for Stacks already storing a
hierarchy.

### Falsifiability check

Removing entity normalisation from `graph-parse.ts` turns 2 of the 12 flat tests
red and leaves the other 10 green, which is the correct split: only the
spelling-agreement cases depend on it.

## Follow-up 1: what the ontology rejected is now recorded

Decided by the human: record it in `stack_documents.audit`, not on the response.

That column was already reserved for exactly this — `db/schema.sql` calls it
"Placeholder for the Group 3 quality audit. Stored as JSONB so we can put
structured audit results here later without a schema change" — and nothing wrote
it, so `GET /documents/:id` reported `null` for every ingested document.

```json
"audit": { "ontology": { "enforced": true, "rejected": 2,
                         "reason_codes": ["UNKNOWN_ENTITY_TYPE", "UNKNOWN_RELATIONSHIP_TYPE"] } }
```

Three properties that are decisions, not consequences:

- **`enforced` is explicit.** "No declaration, so nothing could be rejected" and
  "a declaration rejected nothing" are different facts with the same count.
  Collapsing them would make a misconfigured Stack look like a clean run.
- **Written in the ingest transaction.** A separate transaction could land the
  graph rows and lose the audit, leaving an ingested document nobody can explain.
- **`jsonb_set(..., create_missing => true)`** merges rather than replaces, so a
  later audit producer can add its own keys without erasing this one.

`IngestionResult` is still the oracle's nine keys — a test pins that the audit did
not leak onto the wire.

## Follow-up 2: approval now refuses out-of-ontology proposals

Decided by the human: refuse with 422, do not filter.

Approval was the one path into the graph that ignored the declaration. A human
could approve an item naming `ALIEN_CONSTRUCT` and it landed beside the declared
types, silently, which made the ontology a promise about extraction while reading
like a promise about the Stack's graph.

Refusing rather than filtering is the deliberate choice: a partial approval
reports `entities_absorbed: 2` for three contained items, which reads as success.
The refusal leaves the item `pending`, so a human can fix the ontology, edit the
item, or reject it — the gate must not consume it.

The declaration is read at approval time, not carried on the queue row: it can
change between flagging and approving, and approval is when the write happens.
A Stack with no declaration stays total, the same `null` rule ingest uses.

## Falsifiability checks

Both follow-ups verified by breaking the implementation and watching the right
tests fail: removing the audit write turns 3 of 8 ingest-ontology tests red;
disabling the gate turns 2 of 5 backfeed-ontology tests red, leaving the
no-declaration control green in both cases.

## Open follow-ups (not in this change)

- `GET /stacks/{id}/ontology` was not added: the declaration is on the response,
  so a sibling route would be a second way to read one field.
- `subtypes` remains accepted and validated (endpoints declared, no cycles) but
  does not affect admission. It is decoration with a validation cost. Removing it
  from the accepted shape is a contract change, and leaving it documented-but-inert
  is the smaller lie only because this file now says so.
- The hierarchy is validated and stored but a read still does not rewrite types
  through it; `ontology.ts` documents hierarchy-aware reads as out of scope.
- Backfeed `flag` still accepts a proposal naming undeclared types; only
  `approve` refuses it. Validating at flag time would tell the human sooner, but
  it also freezes the ontology at flag time, and the decision taken was that
  approval is when it must hold.
