# Feature: KG extraction hardening

Three extraction-quality defects in the KG extraction pipeline, on branch
`feat/kg-extraction-hardening`. Test infrastructure is excluded by S2.

## Specs

### S1 — the accepted recommendation (verbatim)

> Los dos arreglos baratos y con efecto real hoy son el **`trim()` en `normalizeEntityType`** y el **texto del prompt** ("Given", y el `paths.s` con el placeholder sin interpolar). Y el de fondo: `strict: true` donde se pueda, más validación de cliente con fallos **contados**, para que "0 triplets" deje de ser ambiguo.

S1 decomposes into four clauses, one per task:

- **S1a** — `trim()` in `normalizeEntityType`.
- **S1b** — the prompt text: `"Given"`, and the `paths.s` / placeholder defect.
- **S1c** — counted failures, so "0 triplets" stops being ambiguous.
- **S1d** — `strict: true` where possible, plus client-side validation with counted failures.

### S2 — scope, in the human's own words (verbatim)

> si agrega tambien la infra con tescontainer para que sea mas rapido y limipo los tests

**The testcontainers half of S2 is NOT a task in this feature.** Test infrastructure —
`vitest.config.ts`, `package.json` dependencies, CI workflows, `test/fixtures/**`,
`testing/**` — belongs to the separate branch `chore/testcontainers-test-infra`.

## Tasks

| ID | Spec | Route  | Commit               |
| -- | ---- | ------ | -------------------- |
| T0 | —    | worker | `3906478`            |
| T1 | S1a  | worker | `ef1e09d`            |
| T2 | S1b  | worker | `ba86a4c`            |
| T3 | S1c  | worker | `059e120`            |
| T4 | S1d  | worker | `059e120` (with T3)  |

Final commit SHAs are recorded by the closing consolidation task, not by each task.
T4 shares C3's commit because its changes live in C3's paths; the row says so
rather than claiming a slice of its own.

## Log

### L1 — the request (verbatim)

> Implement three extraction-quality fixes in llmwiki. Read `AGENTS.md` first and obey it (files <400 lines, functions <40 lines, tests <40 lines, JSDoc headers, pre-commit checks).

### L2 — coverage gaps this feature must close

- A leading-space entity type is untested. `packages/llmwiki-kg/ts/src/core/ontology-flat.test.ts:110` pins only the trailing-space variant.
- The same-name/different-type absorb collision is untested. `absorbEndpoint` (`packages/llmwiki-kg/ts/src/core/graph-extraction.ts:149-173`) rewrites an entity's type only when confidence strictly increases, which never happens because every extraction carries the same `EXTRACTED_CONFIDENCE`. The first-seen type therefore wins silently, and nothing asserts it.

**Both gaps above are now closed** — padded `subtypes` declarations and the absorb
collision are pinned by tests added in T5. See L7.

### L3 — evidence correction, after re-opening the exact lines

- `packages/llmwiki-kg/ts/src/core/graph-prompt.ts:317-320` **does** interpolate `{max_triplets_per_chunk}` via `String(MAX_TRIPLETS_PER_CHUNK)`. The placeholder is not shipped raw and the constant is not unused. The model actually receives `...output 20 extracted paths.s`. The real defects are `Give` (line 280) and `paths.s` (line 281).
- `graph-prompt.ts:269-277` asserted that the typo "is contractual". That claim now describes the opposite of the code and must be rewritten.
- Declaration side: `ontology.ts:130-131` lacked `.trim()`, but the allowlist callers already passed pre-trimmed input (`:160`, `:213`, `:234`). Only `readSubtypes` (`:185`) was genuinely untrimmed.
- `ontology-flat.test.ts:110` pins the OLD behaviour (trailing space rejected). It is a behaviour change to invert, not a gap to extend.

### L4 — Manager decisions

- Rewriting the `graph-prompt.ts:269-277` header is mandatory: a comment claiming the typo is contractual must not survive next to code that fixed it.
- Register the oracle divergence in `odd/findings/aks-spec-conformance.md`. Do not delete or weaken the existing oracle-parity framing.
- Rewrite the byte-pin tests to the NEW bytes, keeping their "pinned on purpose" framing. A removed pin and an updated pin are different things.
- T1: trim inside `normalizeType` (`ontology.ts:130`). Do NOT remove the now-redundant `.trim()` at `:160`, `:213`, `:234` — redundant-but-harmless beats an unrequested refactor, and those call sites are shared with the validation path.
- Add a `CHANGELOG.md` entry. The prompt is the model's input, so T2 changes extraction output for every user.

### L5 — Lead design decisions for T3 and T4

- A chunk is **shape-mangled** when the provider answered (no throw) and the response is non-blank but its parsed form exposes neither a `triplets` array nor an `entities` array. `{"triplets": [], "entities": []}` is legitimately empty, not mangled. Individually malformed triplet entries stay dropped per oracle parity.
- The existing `, N triplets rejected by ontology` fragment keeps its exact wording AND its position. New counters are appended after it; that fragment is never mutated.
- T4 uses `zod`, already a dependency of the `aks-reference-server` package and imported throughout its source. `ajv` is NOT declared in that package and adding it would change `package.json`, which is out of scope.

### L6 — the task commits, and how the slice boundaries fell

1. `ef1e09d` — `fix(kg): trim padded type labels in entity and relation normalization` (T1/S1a).
2. `ba86a4c` — `fix(kg): correct the extraction prompt text and register the oracle divergence` (T2/S1b).
3. `059e120` — `feat(kg): count degraded chunks and advisory-schema violations` (T3/S1c + T4/S1d).
4. `docs(odd): record the task commits in the kg extraction hardening document` —
   this commit. Its own SHA cannot appear inside itself; it is `git log -1` on
   `feat/kg-extraction-hardening`.

**The slices are split by path, not by task.** Three workers edited this tree
sequentially, so single files hold two tasks' changes and no honest one-to-one
mapping exists:

- `ts/src/core/graph-parse.ts` holds both T1's `.trim()` in the normalisers and
  T3's new `isShapeMangled` predicate, so the predicate landed in C1 while its
  only consumer (`graph-extraction.ts`) landed in C3. C1 says so in its body.
- `ts/src/core/extraction-graph.test.ts` holds both T2's prompt byte-pin update
  and T4's drift fix plus the new counting tests, so T2's pin update landed in
  C3. C3 says so in its body.
- `ts/src/core/graph-extraction.ts`, `ts/src/core/extraction-types.ts` and
  `src/dimensions/kg/index.ts` interleave T3's and T4's counters, so both tasks
  share C3 and the T4 row records `C3 (with T3)`.

No `git add -p` or hunk surgery was used. Each commit lists its paths explicitly
and its body states the real composition.

**DB-backed suites do NOT silently skip here, and their status must be reported.**
`packages/llmwiki-kg/ts/src/routes/aks-harness.ts:38` falls back to
`postgresql://aks:aks@localhost:5434/aks` when neither `AKS_TEST_DATABASE_URL` nor
`LLMWIKI_TEST_DATABASE_URL` is set, and a PostgreSQL server is listening on port
5434 in this environment, so the aks routes suites connect and run for real rather
than reporting green from an empty skip. The one exit from actually running is the
`describe.skipIf` gate at `aks-harness.ts:180-181`, which prints
`[aks.test] skipping integration tests — <reason>` to stderr; if that line appears,
the suite did not run and must be reported as skipped, not as passing.

### L7 — T5: independent verification verdict, and the three gaps it raised

Independent verification returned **S1a, S1b, S1c and S1d all MET** at
`aed35b1`. It raised three findings against the implemented feature:

1. `src/core/llm/schema-validation.ts` re-implemented `parseJsonLoosely`
   (`looseParse` / `parseOne`) because the original was private to
   `graph-parse.ts`. The two agreed at that moment, but drift would be silent and
   one-directional: with a polled tolerance the counter would report `0` for a
   payload the parser accepted — a visibility counter that lies low.
2. The padded `subtypes` declaration path had no test. It is the one declaration
   behaviour T1 genuinely changed (`readSubtypes` was untrimmed at baseline), and
   Log L2's leading/trailing-space gap covered only the model-facing label.
3. Log L2's second gap — the same-name/different-type absorb collision — was
   still untested, and so was the `entities` half of `isShapeMangled`.

Closed in T5, in one commit (`git log -1` on `feat/kg-extraction-hardening`; a
commit cannot contain its own SHA):

- **`parseJsonLoosely` is now the single tolerant parse.** It is exported from
  `graph-parse.ts` with the contract stated on it, and `schema-validation.ts`
  imports and uses it; the duplicate `looseParse`/`parseOne` pair is deleted. The
  export is module-level only: neither `core/extraction.ts` nor `core-index.ts`
  re-exports it, so no barrel changed. Behaviour-preserving — the pre-existing
  tests stayed green unchanged, and a new parity test pins the doubly-encoded
  payload both readers must agree on.
- **Coverage pins added (behaviour delivered by T1–T4, no RED available):**
  padded `subtypes` resolves (`" company "` / `" ORGANIZATION"` → `COMPANY` /
  `ORGANIZATION`, link formed, triplet admitted); the no-collapsing boundary
  (declaration `ORGANIC ORGANIZATION`, emission `organic  organization` →
  `UNKNOWN_ENTITY_TYPE` / `ORGANIC__ORGANIZATION`); the absorb collision (one
  "acme" entity, type `COMPANY` from the triplet, chunk indices recorded); an
  entities-only answer is not mangled; validator/parser parity on a doubly-encoded
  payload.

Both Log L2 gaps are therefore closed. No behaviour changed in T5 beyond the
duplicate's removal, and no S# requirement moved.

### L8 — the summary composition, and a measurement correction

`createKgDimension`'s two ingest summaries were two hand-duplicated template
literals: the detect-only head (`kg:dry-run(<n> chunks, <m> entities)…`) and the
persist head (`kg:<n> chunks, <m> entities…`), each appending the same four
fragments. They now come from one function, `summaryFor(kind, handle)`
(`src/dimensions/kg/index.ts`), and both call sites pass through it.

**What it composes, in this fixed order:** `rejectionNote` →
`extractionNote` → `mangledNote` → `schemaViolationNote`. `rejectionNote` stays
FIRST — its wording and position are pinned by callers and predate the other
three — and none of the four note helpers was edited.

**Why the helper exists:** not to shorten the factory. The summary is the only
per-document signal a caller sees without querying the graph, and it has two
producers that must agree. While the fragments lived in two template literals,
appending a note to one and not the other made a dry run describe a run the real
commit does not perform, and no assertion would catch it, because both strings
stay well-formed. One composition point means a new note is added once and both
paths report it. That is the whole justification, and it is a readability and
drift one.

**Byte-identical, proven by the suites that assert the strings exactly.**
`npx vitest run test/dimensions/kg-dimension.test.ts
test/dimensions/kg-core-ontology-flow.test.ts` — 2 files, 17 tests, green BEFORE
the edit and green AFTER it, unchanged. The assertions that pin the bytes and
passed both times:

- `expect(committed.summary).toBe("kg:1 chunks, 1 entities")` —
  `test/dimensions/kg-dimension.test.ts:160`, the exact-equality pin on the
  persist head with no fragments.
- `expect(committed.summary).toBe("kg:dry-run(1 chunks, 1 entities)")` —
  `test/dimensions/kg-dimension.test.ts:252`, the exact-equality pin on the
  detect-only head, parentheses included.
- `expect(committed.summary).toContain("1 triplets rejected by ontology")` —
  `test/dimensions/kg-core-ontology-flow.test.ts:123`, the pin on
  `rejectionNote`'s wording.
- `test/dimensions/kg-dimension.test.ts:188` also still contains
  `2 chunks failed extraction`, so the appended-fragment position is covered too.

No test file was modified. No behaviour changed: this slice moves composition only.

**Measurement correction — AGENTS.md was never violated here.** The earlier
report of "54 non-comment lines, pushed from 52 by this feature" was a
measurement error, and it is recorded here rather than papered over as a fixed
violation, because there was no violation. That figure counts the WHOLE SPAN of
`createKgDimension`, which is a 5-line factory returning an object literal of four
async methods: the span attributes each method's body to the factory that declares
it. The language and every line-counting tool treat each method as its own
function. Measured per function (non-comment, non-blank, from the TS AST) after
this slice:

| Function          | Own lines |
| ----------------- | --------- |
| `createKgDimension` | 5       |
| `prepare`           | 22      |
| `commit`            | 12      |
| `summaryFor`        | 5       |
| `writeGraphRows`    | 24      |

Every one is comfortably under 40. The whole-span figure is 52 at the
pre-feature base `8203862`, 54 at `2c158eb`, and 51 after this slice; it rose by
two at `2c158eb` because `prepare`'s handle literal gained `mangledChunks` and
`schemaViolations` (T3/T4), not because of the summary templates, which added no
lines. `npx fallow health` reports zero complexity findings for this file either
side of the change.

**`prepare` and `commit` were deliberately NOT extracted.** Dissolving either
body into a module-level helper would move the artefactual whole-span number and
nothing else: no behaviour, no readability, no risk reduction — pure
overengineering bought by touching the two functions this slice had to leave
alone. Refused, and recorded as refused.

**Checks run for this slice:**

- `npx tsc --noEmit` — exits 0, no diagnostics.
- `npx vitest run test/dimensions/kg-dimension.test.ts
  test/dimensions/kg-core-ontology-flow.test.ts` — 2 files / 17 tests passed,
  before and after the edit.
- `npm run test:affected` — 626 files / 4599 tests passed, 382.83s, exit 0.

This entry is carried by the commit `refactor(kg): split the kg dimension summary
composition` on `feat/kg-extraction-hardening`; its SHA is `git log -1
--format=%h` on that branch, since a commit cannot contain its own SHA.

### L9 — T6: the counters reach the audit payload

**The gap.** T3 and T4 made the extraction run count two degradation facts —
`mangledChunks` (chunks whose response envelope was unusable) and
`schemaViolations` (type positions outside the schema's `enum`s). Both were
visible in the `kg` dimension's summary string and in `KgHandle`, and **both were
discarded by the API**. `IngestionResult` is nine fixed oracle keys, so the
counters could not ride the ingest response, and the document's `audit` blob
carried only the ontology report. An API consumer therefore saw a 200 with
`entities_extracted: 2` and had no way to tell a thin document from an impaired
run — the exact ambiguity S1c exists to close, one layer above where it was
closed.

**Where they died, re-opened and confirmed.**

- `OntologyAuditSchema` (`packages/llmwiki-kg/ts/src/routes/ingest/audit.ts`,
  `enforced`/`declared`/`rejected`/`reason_codes`/`samples`) had no field for
  either counter, and `buildOntologyAudit` received only `rejected`.
- `chunkAndExtract` (`routes/ingest/pipeline.ts`) held the whole `ExtractionResult`
  — counters included — and passed only `extraction.rejected` to the builder.
- `buildIngestionResult` (`routes/ingest/pipeline.ts`) read only
  `facts.extraction.entities.length` and `facts.extraction.relationships.length`.

**The threading path chosen: no change to `IngestionResult`.** The counters were
already in `chunkAndExtract`'s scope, so the minimal path never widens the
response model. `buildExtractionAudit(extraction)` (new, `audit.ts`) turns the two
optional counts into a section or into `undefined`; `ProcessedIngest` gained an
optional `extractionAudit`; `writeIngestAudit` writes the ingest's sections in one
statement. Constraint 1 is intact: nine keys in, nine keys out, key order
untouched, and the existing nine-key pin still asserts `Object.keys` is 9 while
additionally pinning that `mangledChunks`/`schemaViolations` are NOT on the wire.

**The payload shape.** A new `extraction` section beside `ontology` in
`stack_documents.audit`, which `GET /stacks/:stackId/documents/:doc_id` returns:

```json
{ "ontology": { ... }, "extraction": { "mangledChunks": 1, "schemaViolations": 2 } }
```

- Names are the same words `ExtractionResult`, `KgHandle` and the summary string
  already use. One concept, one name.
- **Units, and why they are not comparable:** `mangledChunks` counts CHUNKS (one
  per response with neither a `triplets` nor an `entities` array);
  `schemaViolations` counts TYPE POSITIONS (subject/relation/object `type`), so one
  triplet can contribute up to three and one chunk many. Stated in the JSDoc where
  the fields are declared, together with "never sum, divide, or read one as a share
  of the other".
- **Optional and omitted when zero**, modelling `ExtractionResult.failedChunks` /
  `mangledChunks` / `schemaViolations`. A healthy ingest writes
  `{"ontology":{...}}` — byte-identical to before this slice, pinned both at the
  unit level (`JSON.stringify` of the exact bytes) and end to end (`toEqual` on the
  whole stored blob, plus `not.toHaveProperty("extraction")`).
- Placement is semantic, not convenient: these are extraction-degradation facts,
  so they are not inside the ontology section, where a reader would blame the
  declaration — and a mangled chunk produces no triplet for the declaration to
  judge in the first place.
- **Stale sections are deleted, not preserved.** An ingest with nothing degraded
  removes a previous run's `extraction` key in the same `jsonb_set` statement
  (`jsonb - 'extraction'`). Without it, a document that degraded once would keep
  reporting those counters forever, describing a graph it no longer matches.

**A defect caught while wiring it.** The single-statement `case` bound
`JSON.stringify(undefined)` in its unreachable `else` branch; drizzle drops an
`undefined` parameter, which left a dangling `::jsonb` cast and failed every
healthy update with a 500. The absent case now binds `{}` and the flag alone
decides the branch. Observed in RED (four healthy-path 500s), fixed, then green.

**Tests** (`routes/ingest/audit.test.ts` unit, `routes/ingest-ontology.test.ts`
DB-backed): the value when nonzero (`mangledChunks` equals the chunk count on an
all-mangled document, `schemaViolations` counts positions); absence when zero, on
the whole blob; independence in both directions (a mangled run reports only
`mangledChunks`, a violating run only `schemaViolations`, and a mixed document
reports `{mangledChunks: 1, schemaViolations: 2}` with distinct values); a clean
re-ingest clearing a previous run's counters; the schema refusing a stored `0`;
each section read only under its own key; and the pre-existing audit pins extended
— never rewritten — with the one sibling key their runs now produce, plus the
nine-key response pin extended to prove the counters did not leak onto the wire.

**Gates (serial, exact):**

- `npx tsc --noEmit` — exit 0, no diagnostics.
- `npm run typecheck:kg` — 230 files, 0 diagnostics, no regression, exit 0.
- `npm run build` — exit 0 (ESM + DTS success).
- Focused route suites, explicit paths, `--fileParallelism=false`: the two above
  plus `ingest-ontology-e2e`, `ingest-contract`, `ingest-failures`,
  `ingest-formation`, `ingest-gateway`, `ingest-truncation`, `documents-read`,
  `documents-upload`. `ingest-gateway.test.ts` reports **1 test SKIPPED** (no live
  gateway credential) — reported as skipped, never as green. The other suites
  passed; two DB assertions (`ingest-formation` provenance, `ingest-ontology`
  PATCH) failed intermittently in one order and passed in another, and the same
  class of order-dependent failure reproduces on the BASE sources with these
  changes reverted, so it is environment flakiness in the shared fixture
  database, not a regression from this slice.
- `npm run test:affected` — 626 files / 4599 tests passed, 358.46s, exit 0.
- `fallow` — run by the pre-commit hook (see the commit).

This entry is carried by `feat(kg): report degraded-chunk and schema-violation
counters in the ingest audit payload` on `feat/kg-extraction-hardening`; its SHA is
`git log -1 --format=%h` on that branch, since a commit cannot contain its own SHA.
