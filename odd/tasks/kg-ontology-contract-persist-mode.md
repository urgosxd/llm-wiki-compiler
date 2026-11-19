# kg-ontology-contract-persist-mode

Branch: `feat/kg-ontology-contract-persist-mode` — Base commit: `b999756f5ba1ec217e03249ff15e80cc204408df`

## Specs

### S1 — A named mode, not a change to `strict`
**Do not silently make `strict` persist.** Existing callers chose `strict` under the documented behaviour that it drops; changing it under them is the unrequested-break shape this campaign has rejected repeatedly. **Add a third value to `ontology_contract` that names the behaviour: refuse nothing, enforce the ontology, and persist both classes with their reasons.** **Name it for what it does. Read the existing values and their docs first and propose the name in your report before writing code, if the choice is not obvious.**

### S2 — `open` and `strict` keep their exact current behaviour
**Both are pinned by a differential against `b999756f5ba1ec217e03249ff15e80cc204408df`.** **`open` must still refuse nothing; `strict` must still drop.** **A caller that passes neither must see no change in any observable: same rows, same counts, same response body.**

### S3 — The rows carry what the dimension's rows carry
**Class and reason and offending type, in the same columns, with the same values.** **A reader must not be able to tell which entry point wrote a row — and if anything does differ, say what and why.**

### S4 — The audit and the rows must agree
**The HTTP route already writes `stack_documents.audit` with `rejected`, `reason_codes` and up to five samples (`audit.ts:428-437`, `MAX_AUDIT_SAMPLES=5`).** **After this change the count in the audit and the number of rejected rows must be the same number.** **If they can legitimately diverge, enumerate every divergence and pin each one.** **A count and a row set that disagree is what made the original `83` unreadable.**

### S5 — The `accepted_only` argument on every graph-reading surface
**It already exists on the MCP tools.** **Any surface that can now return rows from both classes respects it, with the same name, polarity and default — included by default, `accepted_only: true` narrows, a non-boolean is refused by the handler and not by the schema (see L38 in `odd/tasks/kg-rejected-edges-in-graph.md`: the `inputSchema` is advice).**

### S6 — AKS contract surfaces stay conformant
**The vendored AKS 0.1.0 schema has `additionalProperties: false`.** **The class marker must not appear on any payload validated against it, and the serializer must omit the key rather than emit null.** **`/aks/v1/export` keeps `accepted_only` defaulting to `true`.** **Do not reopen that decision.**

## Tasks

| ID | Spec | Task | Commit |
|----|------|------|--------|
| T1 | — | Create this feature document | (this write) |
| T2 | S1 | Add the `persist` mode: `ExtractionContract` union, `INGEST_CONTRACTS` list, and every doc block that enumerates the values | f9239d2f2411cf797db57a3064ae4cf49e21d310 |
| T3 | S1, S3 | `persist` stores a rejected triplet with its own class, reason and offending type; pin that both entry points yield identical class counts for one document and one ontology | 29fe358a2648610ce59afd0dc71a5369e9e487fc |
| T4 | S4 | Audit count equals rejected-row count for one concrete ingest; enumerate and pin every legitimate divergence | pending |
| T5 | S5 | `accepted_only` — same name, polarity, default and handler-level refusal on every surface that gained the rows | pending |
| T6 | S6 | AKS conformance: an all-accepted bundle still validates and the class marker key is absent | pending |
| T7 | S2 | Differential against `b999756f`: `open`, `strict`, and neither-passed each unchanged | pending |
| T8 | S1 | Correct the two sentences that deny the option exists — docs/configuration/stack-ontology.mdx:194-197 and docs/configuration/kg-classification.mdx:152-156 — then document the three values; a three-value list under a paragraph that says there is one is still wrong; also CHANGELOG.md | own commit |

Mode name: `persist`.

**R4 invariant, amended by the Manager: not "equal" but "derivable" — from (`rejected`, `reason_codes`) plus the endpoints, a reader must be able to reach the row count. Equality holds 1:1 for one reason class and 1:2 when both endpoints carry the offending type, so T4 pins each divergence and never asserts equality unconditionally.**

## Log

### L1

````
Close follow-up F-1: the HTTP ingest route under `strict` drops ontology-rejected triplets while the wiki kg dimension now persists them. Make the rejected rows reachable from both entry points, as an explicit mode rather than a silent change.

## The state to fix, stated as two behaviours for one word
- **Wiki kg dimension** (`packages/wiki/src/dimensions/kg/index.ts`): no contract passed → strict classifier → **persists** rejected relationships and entities with their class and reason. This landed in `b0055e87`.
- **HTTP route** (`packages/llmwiki-kg/ts/src/routes/ingest/`): `ontology_contract` defaults to **`open`**, where nothing is refused (`rejected: []`); under **`strict`** it **drops** the triplet instead of persisting it.
- **So the same document through the two entry points produces different graphs.** That is the defect: not that one drops, but that the difference is invisible.

**The rule this must satisfy: the two entry points, given the same document and the same ontology, must produce the same class counts.** Pin that as a test. It is the whole point of the change.

## Requirements
### R1 — A named mode, not a change to `strict`
**Do not silently make `strict` persist.** Existing callers chose `strict` under the documented behaviour that it drops; changing it under them is the unrequested-break shape this campaign has rejected repeatedly. **Add a third value to `ontology_contract` that names the behaviour: refuse nothing, enforce the ontology, and persist both classes with their reasons.** **Name it for what it does. Read the existing values and their docs first and propose the name in your report before writing code, if the choice is not obvious.**

### R2 — `open` and `strict` keep their exact current behaviour
**Both are pinned by a differential against `b999756f5ba1ec217e03249ff15e80cc204408df`.** **`open` must still refuse nothing; `strict` must still drop.** **A caller that passes neither must see no change in any observable: same rows, same counts, same response body.**

### R3 — The rows carry what the dimension's rows carry
**Class and reason and offending type, in the same columns, with the same values.** **A reader must not be able to tell which entry point wrote a row — and if anything does differ, say what and why.**

### R4 — The audit and the rows must agree
**The HTTP route already writes `stack_documents.audit` with `rejected`, `reason_codes` and up to five samples (`audit.ts:428-437`, `MAX_AUDIT_SAMPLES=5`).** **After this change the count in the audit and the number of rejected rows must be the same number.** **If they can legitimately diverge, enumerate every divergence and pin each one.** **A count and a row set that disagree is what made the original `83` unreadable.**

### R5 — The `accepted_only` argument on every graph-reading surface
**It already exists on the MCP tools.** **Any surface that can now return rows from both classes respects it, with the same name, polarity and default — included by default, `accepted_only: true` narrows, a non-boolean is refused by the handler and not by the schema (see L38 in `odd/tasks/kg-rejected-edges-in-graph.md`: the `inputSchema` is advice).**

### R6 — AKS contract surfaces stay conformant
**The vendored AKS 0.1.0 schema has `additionalProperties: false`.** **The class marker must not appear on any payload validated against it, and the serializer must omit the key rather than emit null.** **`/aks/v1/export` keeps `accepted_only` defaulting to `true`.** **Do not reopen that decision.**

## Step 0 — verify these before writing anything
**Every path and claim above came from a report, not from your own read.** **Confirm each with `path:line`, and log a correction for any that does not survive.** **Specifically: that the HTTP route under `strict` currently drops rather than persists, that the dimension persists with class and reason, and the exact columns both would write to.**
**Nine passes in this campaign were rejected for invented identifiers, paths or line numbers. A premise is a hypothesis until a command returns a line.**

## Test-first, and the tests are the deliverable
RED first, observed failing for the right reason:
1. **Same document, same ontology, both entry points → identical class counts.** The pin that kills the divergence.
2. **The new mode persists a rejected triplet with its specific reason**, not a boolean and not the string `"rejected"`.
3. **`open` unchanged** — differential, no verdict taken, zero rejected rows.
4. **`strict` unchanged** — differential, still drops, still no rejected rows.
5. **The audit count equals the rejected-row count** for one concrete ingest.
6. **`accepted_only` behaves identically on any surface that gained the rows.**
7. **A payload validated against the AKS schema still validates** with an all-accepted bundle, and the marker key is absent.

## Standing constraints
- **Node 24 on PATH for `git commit`**: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`. Never `--no-verify`, never `HUSKY=0`.
- **No `.env`, no keys, no tokens, no provider spend. No live database you did not create.**
- **Do not touch** `packages/llmwiki-kg/LICENSE.md`, `packages/llmwiki-kg/ts/oracle/**`, or the vendored AKS specification.
- **Respect the boundary**: `wiki ↔ kg` forbidden both ways; `{wiki,kg,api} → foundation` allowed.
- **Do not change the classifier.** The four checks and their order stay. This moves what happens after the verdict.
- **Nothing pushed, no PR, no merge.**

## Deliverables
- **`odd/tasks/kg-ontology-contract-persist-mode.md`**: header, `## Specs` R1–R6 quoting this brief, `## Tasks`, `## Log` with L1 = this task verbatim.
- **Work-unit commits with `Risk:` lines.** **The mode addition is `Risk: item 3`** (it changes a documented contract's surface) **and gets its own slice.**
- **Full 40-character SHAs.**
- **Report: the new contract value's name and why, the class counts from one concrete ingest through both entry points, the accepted/rejected row counts versus the audit count, and the scope you ran the gate at with its file and test counts.**
- **Report what you disagree with. The last two briefs had seven wrong premises between them and the corrections were worth more than the code.**
````

### L2

- `b0055e87` is docs-only (`odd/tasks/kg-graph-hash-identity-only.md`, `odd/tasks/kg-rejected-edges-in-graph.md`, +78/−0). It did NOT land the wiki kg dimension's rejected-row persistence. That behaviour landed in `d1e8de68e20a75c423eece35681e30de21744cec` and `074fd56ac1c6783f057221b176a8435bd82172ae`.
- `b999756f5ba1ec217e03249ff15e80cc204408df` is HEAD and local `main` at the time this work started; it exists and is a valid differential baseline, but the tree equals it until the first feature commit.
- `MAX_AUDIT_SAMPLES = 5` is defined at `audit.ts:101`; the `audit.ts:428-437` window in the brief is approximately the write site, not the constant's definition.
- The HTTP route under `strict` drops rejected triplets by filtering at `compile-chunks.ts:318-328` (`admittedExtraction`: `if (contract !== "strict") return extraction;` then `.filter(x => x.ontologyVerdict !== "rejected")`). Confirmed by source read, not inferred.
- `docs/configuration/stack-ontology.mdx:194-197` and `docs/configuration/kg-classification.mdx:152-156` state that the HTTP ingest endpoint exposes no contract option at all. Both are stale and are contradicted by `models.ts:168` and `request.ts:181`. Task T8 corrects them.

### L3

Mode name: `persist`. The three values sit on one axis — what happens to a triplet the ontology turns away. `open` takes no verdict; `strict` takes a verdict and refuses; `persist` takes a verdict and keeps it. It is the repository's own verb rather than a coinage: `rejected-triplet-persistence.test.ts`, `RejectedTripletDetail` ("what a writer must persist for it", `core/ontology.ts:149-151`), `storedRejectedRows` (`packages/wiki/src/dimensions/kg/index.ts:204-213`), `routes/ingest/persist-classification.ts`. Rejected alternatives and why: `enforced` (already an always-true boolean at `audit.ts:118-119`, so it would claim a distinction that does not exist); `audit` (collides with `stack_documents.audit` and would make S4 self-referential); `retain`/`retained` (already used for record-retention windows); `recorded` (equally true of `open`, which writes rows too). The value is added to BOTH `ExtractionContract` (`core/graph-extraction.ts:113`) and `INGEST_CONTRACTS` (`routes/ingest/models.ts:140`) because `models.ts:147-150` documents those as deliberately shared vocabulary; adding it to the route alone would fork that documented equivalence.

### L4
Manager accepted all three premise corrections, approved the mode name `persist`, and kept T8. Manager's own correction, recorded because it is the same mechanism that produced the earlier wrong commits: `b0055e87` is docs-only and the dimension's persistence is in `d1e8de68` + `074fd56a`; the attribution named the merge that is remembered rather than the commit that landed it. R4 was too strong: "the count and the row set must be the same number" is true 1:1 for one reason class and 1:2 when both endpoints carry the offending type, so the invariant is `derivable`, not `equal`. T8 is more serious than a stale doc: two pages deny a capability that exists (`stack-ontology.mdx:194-197` says the endpoint "exposes no option to switch"; `kg-classification.mdx:152-156` says "no flag exists to request it"), both contradicted by `models.ts:168` + `request.ts:181`, and a reader who believed them would conclude the behaviour was unreachable. T8 therefore corrects the sentences, not only the value list, and gets its own commit.

### L5
T2 commit `f9239d2f` left `pnpm run typecheck:tests` red: `persist-contract-mode.test.ts` had 5 diagnostics against a baseline of 0 (TS2740/TS2339, a helper declared to return `Response` but returning supertest's `Test`). The T2 handoff listed `tsc --noEmit` and `lint` but omitted `typecheck:tests`, so T2 was reported green while a required Pre-Commit gate was failing. Repaired in its own commit. Recorded because the omission was the Lead's, not the worker's.
