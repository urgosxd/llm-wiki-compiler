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

- [x] 1. Write ODD feature tasks doc and Engram mirror
- [x] 2. TDD: failing tests for ontology load/validate (cycles, unknown parent, empty)
- [x] 3. TDD: failing tests for allowlist rejection and reason codes
- [x] 4. TDD: failing tests for subtype-aware allowlist
- [x] 5. Implement `core/ontology.ts`
- [x] 6. Thread ontology through prompt, parse, and extraction (opt-in)
- [x] 7. Wire ontology into `KgDimensionOptions`
- [x] 8. Run `tsc`, `test:affected`, `fallow`
- [x] 9. Open `contract_proposal` to orchestrator-c for Slice 2

## Evidence log

- **Tasks 2-4 (RED).** `npx vitest run` over the three new suites failed with
  `Cannot find module './ontology.js'` — a real red, not a shape error.
- **Tasks 2-5 (GREEN).** 21 passed across `ontology.test.ts` (9),
  `ontology-enforcement.test.ts` (5), `ontology-hierarchy.test.ts` (7).
- **Task 6.** `ontology-prompt.test.ts` (8) pins the default against the oracle's
  literal prompt string and both `typing.Literal[...]` descriptions;
  `extraction-graph.test.ts` (15) still passes untouched.
- **Task 7.** `test/dimensions/kg-core-ontology-flow.test.ts` (4) drives
  `createKgDimension` end to end and asserts the ontology reaches extraction and
  that a run without one keeps the original two-argument call.
- **Task 8.** `npx tsc --noEmit` exit 0; `npm run build` exit 0;
  `npx fallow` — no dead code, no duplication, 0 issues. Targeted suites plus the
  product-boundary control: 164 passed, 0 failed.
- **Regression found and fixed while verifying.** `extractGraphFromChunks` gained
  an optional third parameter, which widened an existing call to
  `(chunks, name, undefined)` and broke `kg-dimension.test.ts`. Passing `undefined`
  explicitly is not the same observable call as omitting it, so
  `ontologyArgs()` now spreads the argument only when an ontology exists.
- **Boundary violation found and fixed.** The first wiring imported
  `Ontology` by relative path into `packages/`, which the ratified
  `test/product-boundary-genericity.test.ts` forbids for any `src/` module. The
  type is now derived from the barrel: `Parameters<typeof extractGraphFromChunks>[2]`.
- **Commit.** `7664e24` — `feat(kg): enforce a declared ontology during graph extraction`.
- **Slice 2.** `contract_proposal` `cp-2026-10-23-01` sent to orchestrator-c for
  `packages/llmwiki-kg/ts/src/core/ontology.ts@1`. Acceptance is pending; the
  envelope was enqueued, which is not a read receipt.

## Known pre-existing failures (not caused by this change)

`test/connectors/legacy-capacity-parity.test.ts` fails intermittently under full
parallel load (two cases exceed their timeout at ~34s). Verified pre-existing: the
file passes in isolation both with and without this change, and the base tree
without this change failed MORE files (5 files, 6 tests) than the tree with it.
Recorded rather than fixed — it is outside this role's surface.

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
