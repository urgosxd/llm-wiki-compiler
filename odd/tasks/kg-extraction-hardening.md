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
