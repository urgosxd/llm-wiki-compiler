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

### ~~`null` still means the oracle's behaviour~~ — REVERSED

Originally: omitting `ontology` on create left the column NULL,
`readStackOntology(null)` returned `undefined`, and the extraction call kept its
two-argument arity. That was recorded as an invariant this change did not touch.

**It has since been reversed deliberately.** See "Decision: an unconfigured Stack
is enforced against a default" below. The paragraph is kept, struck through,
because the reversal is the point: `null` never meant "the vocabulary is absent",
it meant "nobody is checking", and `type text not null` with no CHECK accepted
`COMPANY` and `FIRM` as different things forever.

## Tasks

- [x] 1. Write the ODD task document and its Engram mirror
- [x] 2. RED: tests for `StackResponse.ontology` exposure and the create-time 422
- [x] 3. Expose `ontology` in `StackResponse` and update the response-key fixtures
- [x] 4. Validate the declaration at `POST`/`PATCH /stacks`, refusing 422
- [x] 5. RED: tests for the dimension reading `stacks.ontology` at `prepare`
- [x] 6. Dimension reads the stored declaration and passes it to extraction
- [x] 7. `tsc`, `build`, `test:affected`, `fallow`
- [x] 8. RED: tests that the default admits COMPANY and EMPLOYS, not llama_index's list
- [x] 9. `default_ontology.ts` with the domain vocabulary, exported through core-index
- [x] 10. Wire the default into ingest, backfeed approval and the KG dimension
- [x] 11. Add `declared` to the audit and rewrite the tests pinning "null = free field"
- [x] 12. RED: tests that the audit names the dropped triplets, bounded and ordered
- [x] 13. `samples` in `OntologyAudit`: name, relation, object, reason, offending type
- [x] 14. RED: domain/range tests — `PERSON EMPLOYS PERSON` must be refused
- [x] 15. Additive `relationships` field with `domains`/`ranges`, validated at load
- [x] 16. Enforce pairs after the allowlists; hierarchy now decides admission
- [x] 17. RED: standalone-entity tests, then `entities` in `KG_TOOL` and the flow

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

## The model is told about entities AND relations — and why both come from one triplet

`ontology-prompt-wiring.test.ts` pins this, because enforcement is two-sided and
one side is easy to lose silently: the parser drops out-of-ontology triplets, so
every enforcement test would still pass while the model was being shown the
default hints. An operator whose declaration stopped reaching the prompt would see
a graph full of rejections instead of the types they asked for, with no error.

The subtle failure worth a dedicated assertion is *which* description carries
*which* list. Writing `entityTypes` into the relation description — or the
reverse — leaves every asserted string present, so a containment test passes.
Swapping the two was measured to turn 2 of the 10 tests red; a containment test
would have stayed green.

### Entities and relations cannot be created independently

The tool schema's only property is `triplets`, so there is no place for a
standalone entity, and every kept triplet yields both endpoints plus the edge in
one step (`absorbEndpoints` then `tripletRelationship`, same loop iteration).

That is also the ceiling: **an isolated entity is unextractable.** Measured with
three attempts — a triplet with no relation, a self-reference, and a top-level
`entities` array outside the schema — all yield `0` kept. A document that only
says "Acme exists" contributes no node. This is inherited path-based design, not a
consequence of the ontology.

## End-to-end integration: ingest to query

`ts/src/routes/ingest-ontology-e2e.test.ts` (8 tests) closes the gap the unit and
route suites left. Every other suite stops at its own boundary: the `aks-*`
suites seed `ontology_entities` with direct `insert` statements, so they prove the
query layer works on rows a test placed there, and the `ingest-*` suites prove
rows are written but never ask the query surface what it can see. **No test in
this package mounted the ingest router and the AKS router together.**

The file writes no graph rows itself. All three routers are mounted over one
transaction wrapper, and every assertion is an HTTP read:

| Test | What it proves |
| --- | --- |
| only declared types via AKS | `GET /aks/v1/entities` returns Acme/Ada/Grace, never Globex/Initech |
| declared edge is traversable | `GET /aks/v1/traverse` returns both `Acme -[EMPLOYS]-> …` edges and no `ACQUIRED` |
| single-entity read | `GET /aks/v1/entities/Acme` agrees with the list |
| no declaration stores everything | the same document yields all four entities (control) |
| Stack totals count admitted knowledge | `entities_extracted` 3 / `entities_in_stack` 3, not what the model produced |
| rejection survives the request | `GET /documents/{id}` audit reports 1 `UNKNOWN_RELATIONSHIP_TYPE` |
| re-ingest is idempotent | a second ingest of the same content does not grow the graph |
| all-rejected writes nothing | 200 with an empty graph, not an error |

Falsifiability measured by bypassing `ontologyArgument`: **4 of 8 turn red**, and
the four that stay green are the controls that must not depend on enforcement.
Stable across three consecutive runs, because an integration test that flickers is
not evidence.

### Two mistakes the file caught in itself

- Missing the documents router and an error handler made a Stack create return a
  bare 500. Without the handler the assertion reads "expected 201, got 500" and
  names the symptom while hiding the cause; the handler turns it into the actual
  message. Both are now in the harness of this file.
- The first traverse assertion pinned the order of two edges at the same depth.
  The endpoint promises BFS depth order, not an order between siblings, so the
  comparison is now a set plus an explicit length.

## Decision: an unconfigured Stack is enforced against a default

**Decided by the human:** option (b), with our own vocabulary — not
llama_index's. Recorded here because it changes the contract for every consumer.

### The problem it closes

`stacks.ontology` is nullable and `null` meant "the oracle's behaviour":
`graph-prompt.ts` advertises ten entity types in the tool-schema *description*
and nothing validates against them, because the extractor is `strict=False`. The
`type` column is `text not null` with no CHECK. Measured consequence: nothing
stopped `organisation` / `organization` / `ORGANIZATION` from becoming three
distinct types in one Stack's graph.

### Why not llama_index's list

The cheap default was `DEFAULT_ENTITIES` / `DEFAULT_RELATIONS`, which would leave
the tool schema byte-identical and risk nothing. Measured and rejected:

| type | in llama_index's default |
| --- | --- |
| `COMPANY` | **no** |
| `EMPLOYS` | **no** |
| `ACQUIRES` | **no** |
| `MISCELLANEOUS` | yes |

Enforcing it would reject `Acme EMPLOYS Ada` — the most natural sentence in this
domain — while admitting `MISCELLANEOUS`. A default that refuses real input is
worse than no default, because it fails silently into a thin graph.

### Why this does not contradict the vendored spec

`SCHEMA.json:499` documents `AKSEntity.type` as *"Domain-defined category. No
global enum."* The spec governs the **format** of an export, and a Stack still
stores and emits whatever types it was given. `default_ontology.ts` supplies a
**starting declaration** for the caller who wrote none — a convenience layered on
a format that permits any value, not an enum carved into the schema.

### Where the default is applied

Three points already answered "the column is null"; all three now call
`defaultOntology()`, so they cannot drift:

| point | file | before | after |
| --- | --- | --- | --- |
| ingest | `routes/ingest/pipeline.ts` | `[]` | `[defaultOntology()]` |
| backfeed approval | `routes/backfeed/ontology-gate.ts` | `undefined` | `defaultOntology()` |
| KG dimension | `src/dimensions/kg/index.ts` | `undefined` | `defaultOntology()` |

Deliberately NOT baked into `buildToolSchema()` or `extractGraphFromChunks`:
those keep the oracle's bytes on purpose, because the parity tests and the
Python-parity harness must keep observing the measured behaviour. A Stack's
policy belongs at the boundary that knows a Stack exists.

### `enforced` changed meaning, so the audit gained `declared`

`enforced` was `false` for an undeclared Stack and `true` otherwise. It is now
always `true`, which would make the field useless. The fact that still matters is
*whose* vocabulary dropped the triplet:

```jsonc
// the caller wrote this Stack's ontology and it rejected 2 triplets
{ "enforced": true, "declared": true,  "rejected": 2, "reason_codes": [...] }
// the DEFAULT rejected 1 triplet on a Stack that never declared one
{ "enforced": true, "declared": false, "rejected": 1, "reason_codes": [...] }
```

Only the second is our policy being wrong rather than their config being wrong,
and a consumer cannot tell them apart without this field.

### Measured blast radius

Before touching any test, `ontologyArgument` was patched to return llama_index's
lists and the suite run: **3 failures** (`ingest-ontology` ×2,
`ingest-ontology-e2e` ×1). The real blast radius of the wiring was larger — 13
tests — because three backfeed suites build Stacks with no ontology and propose
`Thing` / `T` / `links`, and the KG dimension asserted a two-argument call arity.
All were fixture- or arity-level, none was a behavioural disagreement.

### Falsifiability

Swapping `default_ontology.ts` back to llama_index's lists turns **3 of 8**
default-ontology tests red, including "admits the canonical
company-employs-person triplet". The swap leaves the tool schema byte-identical,
which is exactly why it looks safe and is not.

### A mistake this slice made and caught

The first version of the e2e positive test asserted that `ACQUIRED` was admitted
by the default. It failed with an empty graph, and the real reason was that the
default declares `ACQUIRES` — present tense, verb phrase, per `SCHEMA.json:582` —
not the fixture's past-tense `ACQUIRED`. The test now uses its own
`GLOBEX_INITECH_ACQUIRES` fixture and says so. A test that had been written to
pass would have hidden this.

## Follow-up 3: what a rejection cost is now named, not just counted

`rejected: 2` could not answer the question an operator actually asks: *which*
triplets went missing, and therefore whether they forgot a type or the model
invented a relationship. The audit blob now carries `samples`.

### The measured cost this makes visible

A rejected triplet takes its endpoints with it. Entities exist only as triplet
endpoints (`absorbEndpoint`), so dropping a relation drops both nodes:

```
in:   [Acme EMPLOYS Ada]   [Globex BOGUS_REL Bob]
out:  admitted 1, rejected 1, survivors [["Acme","Ada"]]
```

`Globex` and `Bob` never become rows. A document with three companies and one
bad relation can leave two companies. That is now diagnosable from
`GET /documents/:id` instead of only countable.

### Shape

```jsonc
"ontology": {
  "enforced": true, "declared": true, "rejected": 2,
  "reason_codes": ["UNKNOWN_ENTITY_TYPE", "UNKNOWN_RELATIONSHIP_TYPE"],
  "samples": [
    { "subject": "Globex", "relation": "ACQUIRED", "object": "Nobody",
      "reason": "UNKNOWN_RELATIONSHIP_TYPE", "offending_type": "ACQUIRED" }
  ]
}
```

### Why it is bounded

`audit` is a `jsonb` column read on every `GET /documents/:id`, and
`MAX_TRIPLETS_PER_CHUNK` is 20, so a many-chunk document can reject hundreds.
Samples are capped at 5 and each name at 120 characters (elided with `…`).
`rejected` stays the true total, so a truncated report reads as truncated rather
than as complete.

Order is the model's emission order, not sorted: the first rejections are the
representative ones, and sorting by name would bury them.

### Falsifiability

- Cap removed (`rejected.map` instead of `rejected.slice(0, 5)`) -> 1 test red.
- Samples emptied (`samples: []`) -> 4 tests red.

### What this does NOT fix

It reports the loss; it does not prevent it. Keeping the endpoints of a dropped
triplet would create standalone entities, which is the change that has to come
before entity types like `DECISION` or `REQUIREMENT` — things that usually exist
without a relationship — can survive extraction at all.

## Follow-up 4: relationships declare a domain and a range

Measured before this existed: all four combinations of `COMPANY`/`PERSON` with
`EMPLOYS` were admitted, including `PERSON EMPLOYS PERSON`, because
`rejectTriplet` checked subject type, object type and relation type as three
independent allowlist lookups and never as a pair.

### Shape, and why it is additive

```jsonc
{
  "entityTypes": ["COMPANY", "PERSON"],
  "relationshipTypes": ["EMPLOYS"],
  "relationships": [
    { "type": "EMPLOYS", "domains": ["COMPANY"], "ranges": ["PERSON"] }
  ]
}
```

A relationship left out of `relationships` keeps exactly the behaviour it had.
An empty `domains` or `ranges` means "any declared type", not "permit nothing" —
the latter would silently drop every triplet of that relationship and read as a
thin extraction. An ontology written before the field existed loads unchanged.

New reason codes: `SUBJECT_TYPE_NOT_IN_DOMAIN`, `OBJECT_TYPE_NOT_IN_RANGE`.
Checked after the allowlists so the reported reason is the more specific cause.

A constraint that could never fire is refused at load: a constraint on an
undeclared relationship, or a domain/range naming an undeclared entity type.

### The hierarchy finally does work

`isEntityTypeAllowed` was decorative before this: `rejectTriplet` passed the full
allowlist as the required set, so every declared type matched by identity and the
ancestor walk never decided anything. A domain of `ORGANIZATION` now admits
`COMPANY` when `COMPANY IS_A ORGANIZATION` is declared, and that is pinned.

### Falsifiability

Neutralising the constraint lookup turns **5 of 14** domain/range tests red.

## Follow-up 5: the tool schema asks for standalone entities

**This breaks oracle parity deliberately** — see `aks-spec-conformance.md`
section 2b.

`KG_TOOL` gained an `entities` array of `{type, name}`. `triplets` stays the only
required property, so a model that ignores `entities` returns a valid payload.

### The measurement that forced it

A document saying *"we decided to use Postgres"* contributed **no rows**. Entities
existed only as triplet endpoints (`absorbEndpoint`, called from the triplet
loop), so `DECISION`, `REQUIREMENT` and `TEAM` — most of what this compiler is fed
— were unrepresentable.

### Admission

Standalone entities go through the same allowlist as triplet endpoints, so the
addition cannot smuggle an undeclared type into the graph. A node reported in both
shapes stays one row, and the triplet's type wins because that is the one a
relationship already constrains.

### Falsifiability

Removing the standalone absorption turns **2** of the 12 formation tests red.
Emptying `samples` earlier turned 4. Removing the domain/range lookup turns 5.

### What this does NOT do

It does not give the model an explicit slot for standalone entity *properties*;
`ontology_entities.properties` is still always `{}`. And a standalone entity is
still dropped silently rather than reported: it carries no pair information, so
filtering it is not a rejection the caller needs a record of.

## Follow-up 6: the declared types are an `enum`, not a description

**Reversal of what an earlier section of this document claimed.**

Measured, then corrected against llama_index's source. `get_entity_class` does:

```python
type=(possible_entities if strict else str, ...)
```

`SchemaLLMPathExtractor`'s own default is `strict=True`. With it, a
`Literal[...]` of allowed types becomes the field's *type* and Pydantic renders a
real `enum`. The oracle ran `strict=False`, so its schema carried the list in the
field's `description` and left the type a bare `string`.

That distinction is the difference between **guiding** the model and **cleaning
up after it**:

| | `enum` (strict=True) | description only (strict=False) |
| --- | --- | --- |
| model can emit an unlisted type | no; validation fails | yes, freely |
| what happens to it | retried by the model | silently dropped here |

`buildToolSchema(ontology)` now emits `enum` **and** keeps the description. The
description is not redundant: the `enum` says which values are legal, the
sentence says why, and the wording is llama_index's so the model reads what it
always did.

`buildToolSchema()` with no argument still returns `KG_TOOL` untouched, with no
`enum`, because `strict=False` is what that object embodies and the parity harness
observes it.

The post-hoc filter stays. It is the net for providers that ignore the schema —
nothing forces OpenAI to honour an `enum` without `strict: true` in the request,
and the request does not send it.

### Vocabulary now follows the project's roadmap

`README.md` names four types: *"domain-specific types (Process, Role, System,
Document), pass `possible_entities` and `possible_relations`"*. Those are now the
spine of the default list, replacing types invented here. `ROLE`, `SYSTEM` and
`DOCUMENT` were missing entirely; `GOVERNS`, `DOCUMENTS` and `OWNS` were added so
the new entity types have something to connect them.

The roadmap also warns that *"a small number of constrained types usually
produces a more useful ontology than fully unconstrained extraction"*, which is an
argument against a 16-type default. That tension is unresolved and recorded in
the follow-ups rather than silently ignored.

### A false claim removed

The `KG_TOOL` docstring asserted *"The top-level `additionalProperties: false` is
what LlamaIndex adds"*. Measured: `grep -c additionalProperties` over the schema
source returns **0**. The object never had it, and `tool-call.ts` forwards
`parameters` verbatim. In a file whose premise is that the wire shapes are
measurements rather than guesses, that sentence was the one guess.

### Falsifiability

Removing `enum: allowed` from `constrainedTypeField` turns the `enum` test red
while every description assertion stays green — which is exactly the failure mode
this change exists to make impossible to reintroduce silently.

## Open follow-ups (not in this change)

- `GET /stacks/{id}/ontology` was not added: the declaration is on the response,
  so a sibling route would be a second way to read one field.
- `subtypes` remains accepted and validated (endpoints declared, no cycles) but
  does not affect admission. It is decoration with a validation cost. Removing it
  from the accepted shape is a contract change, and leaving it documented-but-inert
  is the smaller lie only because this file now says so.
- The hierarchy is validated and stored but a read still does not rewrite types
  through it; `ontology.ts` documents hierarchy-aware reads as out of scope.
- An entity that appears in no relation never reaches the graph. Adding an
  `entities` array to the tool schema would allow it, but it changes what the
  model is asked to emit and therefore what it extracts — a fidelity break with
  the oracle, and a decision, not a fix.
- Backfeed `flag` still accepts a proposal naming undeclared types; only
  `approve` refuses it. Validating at flag time would tell the human sooner, but
  it also freezes the ontology at flag time, and the decision taken was that
  approval is when it must hold.
