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

### S7 — Every KG tool states its position on the class distinction
**The human's requirement, verbatim: "todas las tools de KG deben recuperarlos pero tambien deben tener el parametro de solo mostrar los aceptados".** Every KG tool must either carry `accepted_only` (included by default, `true` narrows to accepted only) or state, with the projection that decides it, why the tool legitimately excludes the distinction. **A tool that legitimately excludes the distinction and stays silent about it is the defect: silence is what makes a reader believe the distinction does not exist.** If a KG tool that returns graph content lacks the parameter, adding it is in scope for this task.

### S8 — A recompile may flip a verdict, and the row must follow
**The human's requirement, verbatim: "en el caso de re-compilacion podrian cambiar pero siempre habra rechazados".** The same edge identity can flip verdict between compiles. **Pin the minimum: recompile a document whose triplet was rejected and is now accepted, and assert there is exactly ONE row for that identity and its verdict is the new one. Not two rows, and not the old verdict.** This is the accepted-wins collision rule applied to a flip.

### Named follow-up — not this branch
**Out of scope, and deliberately not loaded onto this branch.** The full reconciliation answers: **when a recompile produces a graph in which a previously-rejected triplet no longer appears at all, what removes the row?** Two facts, both established by source read, are the starting evidence: **nothing deletes from `ontology_relationships`**, and **`ontology_relationships` carries no `document_id`**, so a vanished triplet cannot even be attributed to the document that stopped producing it. The next branch starts from those two facts, not from the requirement sentence.

## Tasks

| ID | Spec | Task | Commit |
|----|------|------|--------|
| T1 | — | Create this feature document | (this write) |
| T2 | S1 | Add the `persist` mode: `ExtractionContract` union, `INGEST_CONTRACTS` list, and every doc block that enumerates the values | f9239d2f2411cf797db57a3064ae4cf49e21d310 |
| T3 | S1, S3 | `persist` stores a rejected triplet with its own class, reason and offending type; pin that both entry points yield identical class counts for one document and one ontology | 29fe358a2648610ce59afd0dc71a5369e9e487fc |
| T4 | S4 | Audit count equals rejected-row count for one concrete ingest; enumerate and pin every legitimate divergence | a088e0fe72a9340718075f527a2aa0914a2f619b |
| T5 | S5 | accepted_only — same name, polarity, default and handler-level refusal on every surface that gained the rows; subsumed by T10's inventory | satisfied by T10; no commit (nothing lacked the parameter) |
| T6 | S6 | AKS conformance: an all-accepted bundle still validates and the class marker key is absent | 6200fa3575a4b4b7493c17c04e0fdaaf94c451b9 |
| T7 | S2 | Differential against `b999756f`: `open`, `strict`, and neither-passed each unchanged | evidence only; no commit (differential) |
| T8 | S1 | Correct the two sentences that deny the option exists — docs/configuration/stack-ontology.mdx:194-197 and docs/configuration/kg-classification.mdx:152-156 — then document the three values; a three-value list under a paragraph that says there is one is still wrong; also CHANGELOG.md | 508de9e0ce217df7d2798d903e2c729b26cc2b74 |
| T9 | S8 | Pin the recompile verdict flip: one row for the identity, carrying the new verdict | f07a5e3df341b0ea3767eb85d1136165f1bb9d4b |
| T10 | S7 | Inventory every KG tool with its `accepted_only` position and the projection that decides it; add the parameter to any graph-content tool that lacks it | 1d2b3d2339cd4c4ab374cf85fd12ee445febd9e6 |
| T11 | S7 | Publish the KG graph tools' class position on the Mintlify surface (`docs/guides/mcp-agent-integration.mdx` documents only the wiki's tools) | 4727b81ccf3dfb369d893aabfe610d535c47016d |
| T12 | S6 | Correct the false `accepted_only` comment at `routes/aks/export.ts:157`, which states the opposite of `query-params.ts:160` | 991b03e381bb9a3cd62c9a87161f7511dcd258f7 |
| T13 | S8 | Reduce the flip pin's complexity below the `fallow:kg` CRAP gate; every assertion preserved | 04ecf5def0ed904155e111faf714b348b9e4727c |
| T14 | S1 | Pin the unknown-contract refusal text (`ctx.expected`) that nothing asserted | fa9e821aa40d4f6a7032a7a9b3b22e75a2de9491 |

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

### L6
Human restated the requirement, verbatim: "los 83 ya olvidalos, todo es en base a lo nuevo los admitidos y rechazados tienen que seguir conectados a un solo grapho, y todas las tools de KG deben recuperarlos pero tambien deben tener el parametro de solo mostrar los aceptados, y en el caso de re-compilacion podrian cambiar pero siempre habra rechazados". Three requirements in that sentence: one graph containing both classes; every KG tool retrieves them with an accepted-only parameter; recompilation can change the class. S7 and S8 record the first and third. The full reconciliation — what removes a row when a recompiled graph no longer produces the triplet at all — is a separate branch and is recorded above as a named follow-up with its two establishing facts. Management direction: "The 83 are closed. Do not spend a line on recovering them. Everything is about new ingests from here."

### L7
T4 measured the audit-to-row relation instead of asserting it, commit `a088e0fe72a9340718075f527a2aa0914a2f619b`. For the reference document ("Acme employs Ada. Globex acquired Nobody. Zorp employs Beacon." with `{entityTypes:["COMPANY","PERSON"], relationshipTypes:["EMPLOYS"]}`) the quadruple `(rejected, reason_codes.length, entity rejected rows, relationship rejected rows)` is `(2, 2, 1, 2)` → 3 refused rows under `persist`, and `(2, 2, 0, 0)` → 0 refused rows under `strict`. The audit blob is IDENTICAL across the two modes while the row sets are 3 and 0: the audit counts classifier rejections, not rows. Six divergences are pinned, one per test: (1) equality holds only where one refused triplet yields one row; (2) `strict` counts what it dropped; (3) `reason_codes` is a deduplicated SET, so three refusals gave one code; (4) `samples` caps at `MAX_AUDIT_SAMPLES = 5`, pinned at both the 5 and 6 boundaries; (5) one refused triplet yields THREE rows when the reason is `UNKNOWN_ENTITY_TYPE` and both endpoint types are undeclared — one refused edge plus one refused entity per refused endpoint; (6) the audit has no per-table split, its keys being exactly `declared`, `enforced`, `reason_codes`, `rejected`, `samples`, so `rejected` is a triplet count and both per-table row counts are needed to derive the total. **This supersedes L4's ratio:** L4 said "1:2 when both endpoints carry the offending type"; the measured factor is one refused triplet to THREE refused rows under that condition. L4's underlying point stands and is strengthened — the invariant is derivable, not equal. Not pinned, and recorded as a limit of the formula rather than a claim: the relationship between the count and the rows can break when two refused triplets share one edge identity through `mergeRelationships`, or when an admitted triplet claims that identity first. The formula is `refused rows = L + E`, equal to `R + E` whenever `L = R`, where `R` is `rejected`, `L` is rejected relationship rows and `E` is rejected entity rows.

### L8
T7 differential against base `b999756f5ba1ec217e03249ff15e80cc204408df`: verdict IDENTICAL. Four runs (base twice, candidate twice) canonicalised to a single hash, `sha256=69205c653e16c35a574330c243f9cbefa816652984b4a60d74656a4c48a67d0a` over 7294 bytes; `diff` of base against candidate was empty, and each tree was deterministic against itself. The three caller shapes were `none`, `open` and `strict`; status, full response body, every `ontology_*` column per row, and the complete `stack_documents.audit` were compared, not just counts. The probe is not vacuous: the same probe run with a fourth shape, `persist`, returns `422 literal_error` (`ctx.expected: "'open' or 'strict'"`) at base and `200` with a persisted rejected row at the candidate. Two premise corrections from this task: `POST /ingest` alone writes no graph rows — the rows and audit come from `POST /compile`, which reads the same contract, so a probe calling only `/ingest` proves nothing about rows; and `strict` already contradicted its own audit at BASE, dropping one edge while `audit.ontology.rejected` reports 1 with zero rejected rows, so "audit equals rows" was never true under `strict` and S2's requirement is precisely that this divergence survive. One observable changed, as the requested change's own consequence: the 422 for an unknown value now reads `Input should be 'open', 'strict' or 'persist'` instead of `Input should be 'open' or 'strict'`. No test in either tree pinned the old string.

### L9
T10's inventory found that NOTHING lacks the parameter. Every KG surface returning graph content already carries `accepted_only`; the defect the repository kept naming was silence, not omission, so the code change is zero and the work was documentation (commit `1d2b3d2339cd4c4ab374cf85fd12ee445febd9e6`). MCP `query_stack`, `traverse_stack` and `get_entities` declare `default: false` as JSON-Schema advice only and the handler refuses a non-boolean itself; the HTTP routes declare `false` at `routes/aks/query-params.ts:109`, `:124`, `:136` and `packages/llmwiki-kg/ts/src/dto.ts:551`, and `GET /domain/kg/stacks/:id/graph` at `routes/stack_graph.ts:119`. **`GET /aks/v1/export` is the ONLY surface defaulting to `true`** (`query-params.ts:160`), a deliberate decision not reopened. `list_stacks` has no such argument and legitimately needs none: both of its implementations list from the `stacks` table (`routes/stacks.ts:66-67`, `:390-396`), whose rows carry no ontology verdict, so there is no class to narrow — stated with that projection rather than assumed. There are FIVE independent private copies of `verdictClause`, none exported and none imported (`core/graph_read.ts:363`, `core/page/context-read.ts:48`, `core/stack_graph.ts:180`, `routes/aks/export.ts:65`, `routes/aks/context.ts:337`); a surface needing the parameter lands in its own module, and a future reader expecting one shared helper will find five. Queued, not closed: `docs/kg-mcp.md` is repo-facing rather than published, and `docs/guides/mcp-agent-integration.mdx` documents only the wiki's tools, so the PUBLISHED surface still never states the KG tools' position on the two classes.

### L10
T9 pinned the verdict flip, commit `f07a5e3df341b0ea3767eb85d1136165f1bb9d4b`. The mechanism is `PATCH /stacks/:stackId` writing `stacks.ontology` (`routes/stacks.ts:709`, `:579`, `:124`), re-read by the next compile through `routes/ingest/request.ts:228` and `compile-chunks.ts:310`. Same document bytes, same scripted model answer, declaration before `{entityTypes:["COMPANY","PERSON"], relationshipTypes:["WORKS_AT"]}` and after the same plus `"EMPLOYS"`. After the flip the identity `Acme —EMPLOYS→ Ada` holds exactly ONE row, `accepted`, the SAME row id, `identity_key = 'employs'`, with `ontology_rejection_reason` and `ontology_offending_type` both null, and zero rejected rows for that identity. The control pins it: recompiling without the declaration change keeps the old verdict and the old reason. "Two rows" was structurally impossible — `unique_edge_per_stack` (`db/schema.sql:203`) admits one row per identity, so the only way the pin could fail was "the old verdict survives". **Product asymmetry found and NOT pinned, recorded as a decision for the follow-up branch:** the reverse direction cannot flip. `ACCEPTED_WINS_SET` (`core/document-consolidation.ts:542-558`) keeps `accepted` whenever either side is accepted, so a recompile that turns an accepted edge into a refused one silently keeps the old verdict and leaves the reason null. The requirement "podrian cambiar" reads bidirectional; the product follows one direction only. Also recorded: three distinct identity keys are in play and none is shared — `mergeRelationships` merges on a lowercased `subject|type|object` key within one extraction (`core/graph-extraction.ts:520-525`, `:552`), the database collides on `(from_entity_id, to_entity_id, type)`, and `identity_key` participates in neither, being written by the `fill_identity_key` trigger (`db/schema.sql:561-578`).

### L11
T6 closed S6, commit `6200fa3575a4b4b7493c17c04e0fdaaf94c451b9`, one test file, +64 lines, no production change. Clause by clause: the class marker's absence was ALREADY fully pinned (`aks-export-class-marker.test.ts:133`, `:138`, `:139`, `:154`, `:174` and `aks/export-conformance.test.ts:140-153`, `:154-169`, `:171-186`, `:193-203`), so nothing was added for it. The two real gaps were both on the EDGE side, not the entity side. For "omit rather than emit null": the unpinned row was the refused RELATIONSHIP inside an `accepted_only=false` bundle — nothing exercised it, and it is exactly where absence is the only conformant answer. For the `true` default: the existing default case rejects an edge whose TARGET is refused, so endpoint survival alone explained the exclusion and the verdict clause could have been removed from the relationship read with the suite still green, proved by mutation; the new test refuses an edge whose BOTH ends are accepted. Correction to the brief's own wording, worth keeping: "omit the key rather than emit null" is literally true only for RELATIONSHIPS — a refused ENTITY must present the block inside `properties`, and `:151`'s `toEqual(REFUSED_ENTITY)` already distinguishes that from a null. Also recorded: `routes/aks/export.ts:157` claimed a refused entity is exported by default and omitted only when the caller asks for accepted items alone, the exact opposite of `query-params.ts:160`; the code follows `query-params.ts`, and T12 corrects the comment.

### L12
Two repairs after the first full gate run. (1) `pnpm run gates:static` exited 1 because `fallow:kg` failed: a CRAP score of 31.6 against a threshold of 30 on `pinOneRowWithTheNewVerdict` in `recompile-verdict-flip.test.ts:320`, cyclomatic complexity 10, introduced by T9's commit and reproduced three times. A test file can breach that gate with production code clean, and no task in this branch had been instructed to run `fallow:kg` — the same omission that let T2 ship a red `typecheck:tests`. Repaired in `04ecf5def0ed904155e111faf714b348b9e4727c` by extracting named helpers; cyclomatic 10 to 1, no complexity finding, and all 19 assertions preserved with identical meaning (12 in the flip pin, 7 in the control, both `toBe(1)` counts intact). The post-repair verdict reads `warn` at exit 0 rather than `pass`, because duplication findings are warn-severity: 18 introduced clone groups remain and the gate still counts ok. Reaching a literal `pass` would need a shared ingest test harness, a new file outside that task's surfaces. (2) `fa9e821aa40d4f6a7032a7a9b3b22e75a2de9491` pins the one observable that extending the enum changed and nothing asserted: the unknown-value 422 now reports `'open', 'strict' or 'persist'`, and no test read `ctx.expected`, so the text could have drifted silently. S7's published face closed in `4727b81ccf3dfb369d893aabfe610d535c47016d`. **A premise of the brief was wrong:** readers of the published site COULD already learn the class model, because `docs/concepts/kg-open-classification.mdx` is published (`docs/docs.json:40`) and carried it since `1d2b3d23`. The narrower and worse defect was that the MCP integration guide said the server exposes **fourteen** tools while the union advertises **seventeen**, and never mentioned the graph tools — the page a reader lands on while wiring a client described a different server. That sentence is corrected. Two claims were qualified rather than repeated: a refused row carries its class, reason and offending type in STORAGE, but `AKSRelationship` is closed with no `properties` map, so a refused edge has no channel on any AKS JSON surface; and refused rows exist only for writers that classify, so the published section says their existence depends on the writer's contract.

### L13
Final gate, run on HEAD after all repairs. `pnpm run gates:static` → **all 6 passed in 35.2 s** (tsc, typecheck:kg, typecheck:tests, fallow:ci, fallow:kg, lint). `pnpm run build` → exit 0, `dist/` produced. `pnpm run test:affected` → exit 0, not declined: 592 test files passed, 4 skipped (596); 3793 tests passed, 5 skipped (3798). The gate of record, `turbo run test --filter=//` → exit 0, from its own summary: **943 test files passed, 5 skipped (948); 6870 tests passed, 12 skipped (6882); `1 successful, 1 total`; no failed file; 8m30s.** Five files and twelve tests SKIPPED, and `packages/llmwiki-kg/ts/src/core/jev/vendor-contract.test.ts` (7 tests) is one of them: it skips loudly because `TYPESAFE_API_KEY` is absent, so **the vendor contract is UNVERIFIED in this run** — reported as skipped, never as passed, and the key was not set. The branch is 14 commits since `b999756f`, over 18 files. Forbidden surfaces verified untouched by `git diff --name-only` over the whole range: no `LICENSE.md`, nothing under `ts/oracle/`, no migration or `db/` file, and `core/ontology.ts` — the four checks and their order — is not in the diff at all. Nothing was pushed; no pull request; no merge.
