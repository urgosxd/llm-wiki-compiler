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

| ID | Spec | Route  | Commit  |
| -- | ---- | ------ | ------- |
| T0 | —    | worker | pending |
| T1 | S1a  | worker | pending |
| T2 | S1b  | worker | pending |
| T3 | S1c  | worker | pending |
| T4 | S1d  | worker | pending |

Final commit SHAs are recorded by the closing consolidation task, not by each task.

## Log

### L1 — the request (verbatim)

> Implement three extraction-quality fixes in llmwiki. Read `AGENTS.md` first and obey it (files <400 lines, functions <40 lines, tests <40 lines, JSDoc headers, pre-commit checks).

### L2 — coverage gaps this feature must close

- A leading-space entity type is untested. `packages/llmwiki-kg/ts/src/core/ontology-flat.test.ts:110` pins only the trailing-space variant.
- The same-name/different-type absorb collision is untested. `absorbEndpoint` (`packages/llmwiki-kg/ts/src/core/graph-extraction.ts:149-173`) rewrites an entity's type only when confidence strictly increases, which never happens because every extraction carries the same `EXTRACTED_CONFIDENCE`. The first-seen type therefore wins silently, and nothing asserts it.

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
