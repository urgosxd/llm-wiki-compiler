# Feature: declarative KG ontology from JSON

**Status:** in progress
**Owner:** orchestrator-b (`kg-core-dimension`)
**Contract:** `contract-cordination.json` version 1

## Goal

Let a caller declare, in one JSON file, which entity types and which
relationship types a Stack's knowledge graph may contain — plus a subtype
hierarchy — and make the extraction pipeline *enforce* that declaration instead
of merely suggesting it to the model.

## Why it is not a one-line change

Today the type lists are a **prompt decoration, not a contract**:

- `core/graph-prompt.ts:54,58` interpolate `DEFAULT_ENTITIES` / `DEFAULT_RELATIONS`
  into the tool-schema description text.
- `core/graph-parse.ts` normalizes types but validates nothing; every triplet
  reaches `out`.
- `db/schema.sql:132,181` store `type` as free text with no constraint.

So a declared ontology that is not enforced would be a lie in JSON form.

## Decisions taken by the human

1. **Scope of the JSON:** entity types, relationship types, and a subtype
   (`IS_A`) hierarchy.
2. **Enforcement:** *hard with reporting*. Out-of-ontology triplets are dropped
   and the ingest result explains which ones and why. Silence would make a
   thin extraction indistinguishable from a tight ontology.
3. **Persistence:** per Stack, in the database.

## Scope boundary (why this is two slices)

Decision 3 crosses the ownership split. The mechanism can be built inside this
role's surface; the persistence cannot.

| Piece | File | Owner | This role's access |
| --- | --- | --- | --- |
| Ontology load, validate, enforce | `ts/src/core/**` | orchestrator-b | owned |
| Flow wiring | `src/dimensions/kg/**` | orchestrator-b | owned |
| Barrel re-export | `ts/src/core-index.ts` | orchestrator-c | forbidden (`ts/src/*.ts`) |
| DDL | `db/schema.sql` | shared | read-only |
| Stack create/update | `ts/src/routes/stacks.ts` | orchestrator-c | forbidden |
| Ingest wiring | `ts/src/routes/ingest/**` | orchestrator-c | forbidden |

### Slice 1 (this document)

`JSON -> load -> validate -> chunk -> extract with constrained types -> reject
out-of-ontology with a report -> consolidate`, entirely within
`ts/src/core/**` and `src/dimensions/kg/**`.

### Slice 2 (follow-up, needs a contract)

Persist the ontology per Stack and read it at ingest time. Requires
`contract_proposal` to orchestrator-c plus a shared-DDL decision by
orchestrator-a. Tracked here, not blocked on here.

## Hard constraint: oracle parity is opt-in

`core/graph-prompt.ts` documents that both the prompt text and the tool schema
were copied from the Python oracle because *the model's output shape is a
function of them*. Any change to the default rendering silently changes what
gets extracted and breaks the port.

Therefore: **the ontology is an additive, opt-in parameter.** With no ontology,
`buildExtractionPrompt` and `KG_TOOL` render byte-identical to today. The
existing parity tests must pass untouched — that is the regression gate for
this whole feature.

## Rejection report shape

```ts
interface RejectedTriplet {
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
  readonly reason: "UNKNOWN_ENTITY_TYPE" | "UNKNOWN_RELATIONSHIP_TYPE";
  readonly offendingType: string;
}
```

`ExtractionResult.rejected` is **optional**, so existing constructors in
orchestrator-c's ingest route keep compiling. It is populated only when an
ontology was supplied.

Rejecting a triplet rejects the triplet, not its endpoints: an endpoint whose
type is unknown drops that triplet, but an endpoint that survives another valid
triplet is still an entity. Reason codes are checked cheapest-first, entity
types before relationship type, so the report names the most specific cause.

## Tasks

- [ ] 1. Write ODD feature tasks doc and Engram mirror
- [ ] 2. TDD: failing tests for ontology load/validate (cycles, unknown parent, empty)
- [ ] 3. TDD: failing tests for allowlist rejection and reason codes
- [ ] 4. TDD: failing tests for subtype-aware allowlist
- [ ] 5. Implement `core/ontology.ts`
- [ ] 6. Thread ontology through prompt, parse, and extraction (opt-in)
- [ ] 7. Wire ontology into `KgDimensionOptions`
- [ ] 8. Run `tsc`, `test:affected`, `fallow`
- [ ] 9. Open `contract_proposal` to orchestrator-c for Slice 2

## Non-goals

- Attributes or properties per entity type. The human chose types + hierarchy.
- Transitive hierarchy expansion in the read port. `graph_read.ts` is not
  touched; a `Company` is still returned as `COMPANY` unless the caller asks
  for its parents, which is a separate surface.
- Migrating existing Stacks or back-filling ontologies.
- Changing the `strict=False` behaviour when no ontology is supplied. The
  oracle accepts any type; so do we, in default mode.

## Evidence log

Recorded as each task closes. A task is not closed without an observed result.
