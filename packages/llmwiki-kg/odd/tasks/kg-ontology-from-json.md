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
  `packages/llmwiki-kg/ts/src/core/ontology.ts@1`. Answer: `cd-2026-10-23-01`,
  `status: changes`. A `contract_decision` may not carry `reason` (the spec
  forbids it on that type), so the decision arrived without its rationale.
- **Root cause of the rejection, verified not assumed.** A consumer cannot reach
  the `Ontology` type: `import type { Ontology } from "llmwiki-kg"` fails with
  `TS2305: Module '"llmwiki-kg"' has no exported member 'Ontology'`, and a
  relative import into `packages/` is forbidden by the ratified product-boundary
  control. The interface was published at a path only its own package can reach.
  Version `@2` adds the barrel re-export that closes that gap.
- **A probe defect worth recording.** A first probe written as `__probe.test.ts`
  reported success because `tsc` does not include test files; only the `.ts`
  probe surfaced TS2305. A verification that cannot fail is not a verification.
- **A false `work_result`, caught by the receiver and then by the hook.** Two
  separate defects in one report:
  1. `wr-2026-10-23-01` listed 6 of the 12 paths `7664e24` actually touches.
     orchestrator-c rejected it on shape alone and was right: the four omitted
     test files are precisely what substantiates the `tests` claim, so a receiver
     auditing only the listed set would pass the commit while never learning that
     half of it changed. Verified: `git show --name-only 7664e24` returns 12.
  2. The correction then cited `e06e972` — a docs commit — against code paths, and
     the enforcement hook refused it with `evidence-missing-changed-files`.
     Evidence must be the revision that touched the listed files, which is
     `7664e24`; the tip only matters for saying where the tests were run.
  Both are the same root cause: quoting a number or a revision from memory instead
  of re-deriving it. The corrected envelope is `wr-2026-10-23-03`, all 12 paths,
  evidence `7664e24`.

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

## Agreed contract

Recorded verbatim, as the protocol requires. The version string is the one both
sides exchanged, not a paraphrase.

| Field | Value |
| --- | --- |
| `contract` | `packages/llmwiki-kg/ts/src/core-index.ts@1` |
| Proposed by | `orchestrator-b` — `cp-2026-10-23-03` |
| Accepted by | `orchestrator-c` — `cd-2026-10-23-03`, `status: accepted` |
| Implemented by | `orchestrator-c` (owner of `ts/src/core-index.ts`) |
| Consumed by | `orchestrator-b` (`src/dimensions/kg/index.ts`) and `orchestrator-c` (ingest) |
| Integrated by | `orchestrator-a` |

What the agreed version requires `ts/src/core-index.ts` to re-export:

- **values** — `validateOntology`, `isEntityTypeAllowed`, `ancestorsOf`,
  `parseTripletsWithOntology`, `OntologyError`
- **types** — `Ontology`, `RejectedTriplet`, `OntologyParseResult`, `SubtypeEdge`,
  `RejectionReason`

Values are the substance of v3. Re-exporting only the three interfaces was the
`changes` verdict on `@1`: an ingest route handed a stored JSON document needs
`validateOntology` as a callable, and a hierarchy check needs
`isEntityTypeAllowed`. Names without the callables would have compiled and done
nothing.

**Ordering is part of the agreement.** The re-export may only land after `7664e24`
is reachable from `feat/orchestrator-c`, because `ts/src/core/ontology.ts` does
not exist there yet and a re-export would break `npx tsc --noEmit` on that
branch.

**Superseded versions:** `ontology.ts@1` and `ontology.ts@2` were answered
`changes`. `@2` was correct in diagnosis (the barrel hid the type) but incomplete
in prescription (types only). `core-index.ts@1` is the agreed successor and is a
different interface, which is why it carries its own version rather than `@3`.

### Amendment: `core-index.ts@2` adds `Triplet`

`core-index.ts@1` shipped a half-nameable return type, and orchestrator-c caught
it before implementing. `OntologyParseResult.triplets` is `readonly Triplet[]`
(`core/ontology.ts:72`), and `Triplet` is exported only from
`core/graph-parse.ts:27`, which the barrel does not re-export. Verified by probe:

```
import type { Triplet } from "llmwiki-kg";
-> TS2305: Module '"llmwiki-kg"' has no exported member 'Triplet'.
```

So a consumer could call `parseTripletsWithOntology` but could not name what it
returns element-wise. `@2` adds exactly one line to the type list:

```ts
export type { Triplet } from "./core/graph-parse.js";
```

Proposed as `cp-2026-10-23-04`.

### Why the ordering clause is satisfiable now

Measured, not assumed: `git merge-base --is-ancestor feat/orchestrator-c HEAD`
returns true with merge-base `2e418ad`. The consumer branch is fully contained in
this one, so it can fast-forward without conflict and `7664e24` becomes reachable
immediately. No rebase, no cherry-pick, no conflict resolution is needed — the
"land it after 7664e24 reaches me" condition is a single fast-forward.

Exactly 7 commits sit between `feat/orchestrator-c` and this tip: the feature
commit and six documentation commits recording the negotiation. Nothing in them
touches a file orchestrator-c owns, so the fast-forward carries no surprise for
the barrel work.

## Follow-up owned by orchestrator-b once the re-export lands

Delete the `KgOntology` derivation at `src/dimensions/kg/index.ts:61` and name
`Ontology` directly. The alias exists only because the barrel hid the type;
leaving it after the contract lands would keep a workaround for a problem that no
longer exists.

**This cleanup is deliberately NOT done yet.** orchestrator-c suggested it as an
optional carry-over. It cannot be done before the re-export lands: naming
`Ontology` from the barrel today fails with `TS2305`, so the cleanup would trade a
visible workaround for a broken build. The order is: c lands the re-export, then
this alias is deleted, then `tsc` is re-run.
