# ingest-dimension-reporting

Per-dimension reporting for a settled ingest: a compile result must say which dimensions ran, which were skipped and why, and which failed. Branch `fix/ingest-dimension-reporting`.

## Specs

S1. The compile success message may not be a constant. The operator reported:

```
cuando se ingesta solo aparece que compilo wiki y no aparece de KG Compile — `Compile ✅ succeeded (etapa embeddings) "Wiki compiled." — 276 chunks en 84 peticiones, terminó a las 03:25:41Z`
```

Production `.env` has `LLMWIKI_DIMENSIONS=wiki,kg`, so both dimensions are enabled and the message must be derived from the dimensions that actually ran.

S2. The reported defect is not a dropped value but a value that cannot answer the question. `IngestOutcome.summaries` (`packages/wiki/src/dimensions/coordinator.ts:419`; declared `readonly summaries: ReadonlyMap<string, string>` at `:117`) is a bare string per dimension and holds only COMMITTED runs (`summariesOf`, `:376-382`), so "ran and succeeded" is a string while "ran and failed" and "did not run" are both simply absent. `packages/wiki/src/services/ingest/service.ts:280` returns only `{ savedPath, writeStatus }` and never reads it. A value that cannot distinguish absent from failed cannot be the report: the coordinator must record per-run state and the report must be derived from that state. `summaries` stays exactly as it is for compatibility and becomes one field inside the richer record.

S3. One shape, on three read surfaces: the job record, the HTTP job read, and the MCP job tool. Not three shapes. The view builder both readers already share is `withStatusReason` (`packages/wiki/src/services/ingest/jobs/status.ts:257`), called from `packages/wiki/src/viewer/api-ingest-jobs.ts:343` and `packages/wiki/src/mcp/job-tools.ts:88`.

S4. These three states must be distinguishable, and the third must say so:

  - a) "did not run because this route does not include that dimension"
  - b) "ran and succeeded"
  - c) "ran and failed"

Silence is what made the reported defect possible. A route that legitimately excludes a dimension must SAY so.

S5. `POST /api/compile` (`packages/api/src/host/api.ts:538-579`) is compile-only: it calls `compileAndReport` with no dimensions port, so `kg` never runs there by design. A run of it must report `kg: not part of this route`, not silence. This is the acceptance case that proves the fix. The report reaches that route as an additive, optional key on the response body, following the repository's existing precedent for appended structure in `runSyncIngest` (`api.ts:481` `writeJson(res, 200, { ...ingested, compiled: null })`, `:486` `writeJson(res, 200, { ...ingested, compiled, compileBusy: compiled.busy === true })`): nothing existing is renamed, removed or re-typed, and a consumer that ignores unknown keys keeps working. That compatibility must be OBSERVED in this worktree and cited as evidence, not assumed.

S6. `docs/ingest-dimension-observability.md` carries four stale citations, measured in this worktree: `:36` cites `api.ts:389` (real `:269` and `:462`), `:37` cites `service.ts:78` (real `:90`), `:50` cites `activation.ts:311-313` (real `:337`), `:67` and `:85` cite `compiler/index.ts:1994-2001` (real call site `:1225-1227`, definition `:2173-2178`). Correct them in the same change as the behaviour, and keep the document's thesis with its qualification: the FAILURE path emits one stderr JSON naming `dimensions` (`coordinator.ts:260-267`, written at `:269`), while the SKIP paths (`activation.ts:337`, `coordinator.ts:186`) emit nothing.

S7. Halves are not dimensions. `api.ts:481` spreads `IngestResult` and `CompileResult` — the ingest and compile halves, not the `wiki` and `kg` dimensions. The new report is over the dimensions and must not be modeled on that halves union.

S8. Route composition is out of scope and the question is closed, not deferred: the KG dimension already runs on every ingest, inside the transaction, before the compile phase, so "compose KG in /api/compile" would have duplicated work the pipeline already does. The wiki has a compile PHASE and the KG does not, and "compile" means two different things in the two dimensions. In this branch `POST /api/compile` reports `kg` as `not part of this route`, which is truthful because that route performs no ingest. Any future change to it is a new decision, recorded at L7.

S9. The one shape, a discriminated union:

```ts
export type DimensionOutcome =
  | { readonly name: DimensionName; readonly status: "succeeded"; readonly summary: string }
  | { readonly name: DimensionName; readonly status: "failed"; readonly error: string }
  | { readonly name: DimensionName; readonly status: "skipped"; readonly reason: "not-in-route" | "disabled" | "declined" };
```

  - `succeeded` — the dimension committed; `summary` is the string it returned, the bare-value side of `ReadonlyMap<string, string>`.
  - `failed` — the dimension ran and threw; `error` carries the failure text.
  - `skipped` + `not-in-route` — this route does not compose the dimension (S4a).
  - `skipped` + `disabled` — the route composes it but `LLMWIKI_DIMENSIONS` excludes it.
  - `skipped` + `declined` — it ran `prepare` and returned `null` (`coordinator.ts:186`), so it had nothing to commit.

Every known dimension (`KNOWN_DIMENSIONS`, `activation.ts:67`) appears on every settling path; a missing entry is a bug. `IngestJob` (`packages/wiki/src/services/ingest/jobs/types.ts:226-282`) gains `readonly dimensions?: readonly DimensionOutcome[]`, optional because `job-store.ts:103` persists the whole record as JSON in `payload jsonb` and payloads written before this change lack the key.

S10. Compile message derived from the report, exactly:

  - succeeded names joined with ` and `, framed as `Compiled wiki.`, `Compiled kg.` or `Compiled wiki and kg.`
  - if no dimension succeeded: `Nothing compiled.`
  - then, for each non-succeeded dimension in `KNOWN_DIMENSIONS` order, append ` <name>: not part of this route.`, ` <name>: disabled by LLMWIKI_DIMENSIONS.`, ` <name>: no changes.` or ` <name>: failed.`

So wiki succeeded with kg outside the route reads exactly `Compiled wiki. kg: not part of this route.`

S11. Adding a field to the exported `IngestJob` type is a wire-contract change and the commit's `Risk:` line must declare it.

S12. The coordinator records, per dimension and per run, one of: attempted, skipped with a reason, failed with an error, or committed with a summary. The report derives from that state. Five labelled non-success reasons stay distinct because an operator would act differently on each: `not-in-route` (this route does not compose the dimension), `disabled` (the route composes it but `LLMWIKI_DIMENSIONS` excludes it), `declined` (it ran `prepare` and returned `null`, `coordinator.ts:186` — nothing to commit), `not-attempted` (the run failed before this dimension was reached; the failure is upstream of it), and failure (it ran and threw, error carried).

A settling path that never reaches the coordinator — an unreadable source, a `LockBusyError` — reports every composed and enabled dimension as `not-attempted`, because the union has no truthful arm for a run that died before any dimension was resolved: `not-in-route`, `disabled` and `declined` would each be a false claim about it, and an operator's conclusion differs from all three. Route and switch are read from the configuration on that path, not from run records — there are none. The compile line renders the fifth reason as `not attempted`, in the same `<name>: <text>.` shape, so such a run with both dimensions enabled reads exactly `Nothing compiled. wiki: not attempted. kg: not attempted.`

S13. Compatibility is a claim that must be observed: `test/services/ingest-job-status-old-shape.test.ts:91` and `:108` deep-equal a legacy stored payload against `OLD_SHAPE` and must stay green UNCHANGED, and that green must be cited as observed evidence in the task that changes the job record.

S14. `wiki` runs before `kg`, as a property the coordinator guarantees and a test pins, not as an accident of array order. It applies to every route that composes both dimensions, and a caller passing the dimensions in any other order must not be able to invert the sequence.

## Tasks

T1 — Feature document. S1-S11. route: gentle-ai-worker. commit: 4e57085f582210a11a8fc19cf0e2edeb74000aea.
T2 — Core report, test-first: per-run coordinator state, `DimensionOutcome`, the producer, carrying the report out of `service.ts` (with `summaries` preserved), the job-record field, the derived compile message. S1,S2,S3,S4,S7,S9,S10,S12,S13. route: gentle-ai-worker. commit: 43cdf771a70e344d308d8ac54cc692662fc0797c and 09231e303eae48ed13a1c05f0c158a05ec7bc046.
T3 — `POST /api/compile` reports `kg: not part of this route` via an additive optional response key on the `runSyncIngest` precedent, with observed back-compatibility. S5. route: gentle-ai-worker. commit: df39b7a1be482fcf1a7ae5bc10847136f499d4b6.
T4 — Correct the four stale citations in `docs/ingest-dimension-observability.md`. S6. route: gentle-ai-worker. commit: c0f151a8cbcee9dc4e02f0e4d03075083f2e3e29.
T5 — Independent verification against every S# (S1-S14), read-only, never in the same turn as an editing writer. route: gentle-ai-verify. commit: none — verification only, recorded at L9.

## Log

L1 — the operator's request, verbatim:

```
cuando se ingesta solo aparece que compilo wiki y no aparece de KG Compile — `Compile ✅ succeeded (etapa embeddings) "Wiki compiled." — 276 chunks en 84 peticiones, terminó a las 03:25:41Z`
```

L2 — diagnosis verified in this worktree, with corrections to the reported line numbers: the `kg` dimension is constructed at `activation.ts:347` (not `:346`); `coordinator.ts:325` prepare and `:187` commit confirmed; `coordinator.ts:419` returns `summaries: summariesOf(runs)` confirmed, and the map value is a bare `string` carrying no status, holding only committed runs (`summariesOf`, `:376-382`); `service.ts:280` drops it confirmed, with zero `summaries` occurrences in that file; the `"Wiki compiled."` constant at `run.ts:227` confirmed; the failure path `coordinator.ts:357-361` into `run.ts:278-289` confirmed. `IngestJob` is declared once, at `jobs/types.ts:226-282`, and has no field able to carry per-dimension facts. `summaries` reaches no job record, no HTTP response and no MCP tool, confirmed. `POST /api/compile` creates no job at all (`api.ts:538-579`); only the async ingest path creates one (`api.ts:276`).

L3 — toolchain on this branch: `corepack pnpm install --frozen-lockfile` run to completion, `pnpm exec tsc --noEmit` clean at baseline, bare `pnpm` works (11.5.0), Docker daemon reachable, no `LLMWIKI_TEST_DATABASE_URL`, `.llmwiki/build-stamp.json` cold. The gate of record must be run with `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"` because Node 24 is not on the session PATH.

L4 — the Manager's correction, accepted in full: "A value that cannot distinguish 'absent' from 'failed' cannot be the report. My brief said 'carry `outcome.summaries` out' and that was wrong: it can carry the success and nothing else. So the coordinator has to record per-run state — attempted, skipped-with-reason, failed-with-error, committed-with-summary — and the report is derived from that, not from `summaries`. Keep `summaries` as it is for compatibility; it becomes one field inside a richer record rather than the whole answer." Also accepted: the compile-response field is authorised as additive only, modelled on the repository's one precedent for appended structure, with back-compatibility checked rather than assumed, and declared in the commit as an additive HTTP contract change; `skipped` + `declined` stays distinct from `not-in-route` and `disabled`; the legacy old-shape test stays green and that green is cited; route composition is not touched and S8 is recorded as a one-word open question for the human.

L5 — T2 split at the carrier seam: T2a is the dimensions layer (the producer, the coordinator's per-run state, unit tests); T2b threads the report from `ingestIntoStack` to the job record. `IngestResult` is not widened (S7); the job runner gets a sibling loader instead. File-authority mode (`ingestAsFiles`, `service.ts:264`) produces no dimension commits at all, so it yields no `dimensions` key rather than an invented reason — recorded here as a qualification, not silently omitted.

L6 — requirement change, decided by the human and relayed by the Manager, overriding the earlier scope: the required flow is "el flujo debe ser, ingest -> compile wiki -> compile KG", so `POST /api/compile` must compose the KG dimension and no longer merely report it as outside the route; the order wiki-then-kg is now a requirement the code must guarantee and a test must pin, not an incidental property; and the cost consequence must be stated in those terms, because a compile that performs KG extraction spends provider tokens where it previously did not and a human must not be surprised by a provider bill nobody documented. Composition is its own unit with its own commit and its own Risk line; the reporting work stays as specified. The Manager then scoped the composition OUT of this branch — decision "B" — so this requirement opens the next feature (`odd/tasks/kg-compile-composition.md`) instead of being implemented here; this branch delivers the report and the ordered guarantee, and `kg`'s entry stays `not part of this route` until that feature lands.

L7 — the composition requirement is retired because its premise is refuted. The human's words: "yo pense que el compile de KG era automatico como el de wiki" — they assumed the KG compile was automatic, saw no evidence of it, and asked for a feature to build what was already running. They were right the first time: `ingestSource` commits BOTH dimensions, KG extraction included, inside the transaction, before `runCompileHalf` (`run.ts:263` then `:272`), so the KG work happens on every ingest, per document, and always has. An operator who cannot see a dimension concluded it does not exist, and asked for a feature to build what was already running. That is what "a dimension that never runs leaves no trace" costs when the dimension does run.

The asymmetry that produced the wrong belief, stated once so the next reader does not repeat it: the wiki has a compile PHASE and the KG does not. `compileAndReport` (`packages/wiki/src/compiler/index.ts:342`, detectChanges then generation then embeddings) generates pages, links and embeddings over what ingest stored, while the KG dimension writes its graph during ingest, per document, inside the same transaction. "Compile KG" is therefore not a missing stage but a stage that does not exist by design, and the word "compile" means two different things in the two dimensions.

Retired with the feature, the six measured facts that would have shaped it, kept because they outlive the question. 1) No batch KG compile exists anywhere: only two callers of `extractGraphFromChunks` (`packages/wiki/src/dimensions/kg/index.ts:677`, `packages/llmwiki-kg/ts/src/routes/ingest/pipeline.ts:213`), no backfill, reindex or extract-all route or tool. 2) The `kg` dimension's unit of work is ONE document (`kg/index.ts:639`), so a stack-wide compile would have been new machinery, not a toggle. 3) Extraction is one sequential chat request PER CHUNK (`packages/wiki/src/core/graph-extraction.ts:543-546`) with no budget and no cap. 4) A `dryRun` option exists (`kg/index.ts:177`) and has NO consumer: `activation.ts:351` declares a path nothing reads, so wiring it is the cheapest way to measure any future KG work. 5) `/api/compile` answers 200 on a file-backed stack with no database (`packages/api/src/host/api-endpoints.test.ts:329-348`), and any dimension-composing compile there would fail through `MissingDimensionsPortError` (`packages/foundation/src/dimensions-port.ts:163-180`). 6) `/api/compile` had no test pinning its 200 body, so nothing would have caught a contract change; this branch adds that pin, and it is the guard any future change needs.

L8 — independent verification found S9 unmet on a settling path that never reaches the coordinator: an ingest whose source cannot be read settled `failed` with no `dimensions` key, the very silence S4 and S9 forbid (reproduced: `ingest.error` `ENOENT ... '/nonexistent/source.txt'`, `dimensions` absent). The union had no truthful arm for "the run died before any dimension was resolved", so it gained a fifth labelled reason, `not-attempted`, rather than relabelling the case as `not-in-route`, `disabled` or `declined`, each of which would have been a false claim. Nothing about which dimensions run changed. Everything else in the verification was green: all gates on Node 24, the gate of record 905 files / 6683 tests / 1 successful / not cached, and the 20-file pre-committed population all PASS.

L9 — independent verification, twice, in its own lane with no writer in the tree. All six static gates green, `build` green, `test:affected` green at 407 files / 2451 tests, and the gate of record on Node 24 with `TESTCONTAINERS_REUSE_ENABLE=false` at 908 files / 6693 tests / 1 successful / not cached, against a 23-file population pre-committed before the run. The first pass found S9 unmet on a path that had never been exercised: a job whose source could not be read settled `failed` with no `dimensions` key at all. That was fixed by adding the fifth label, `not-attempted`, and by making the job runner's remaining failure path record a report; the second pass proved it closed, proved a malformed `LLMWIKI_DIMENSIONS` settles the job instead of wedging it in `running`, and proved every pre-existing message rendering byte-identical across 112 differential cases. The work is committed as five slices: 4e57085 (this document), 43cdf77 (the dimensions layer and the ordering guarantee), 09231e3 (the ingest service, the job record and the derived message), df39b7a (the compile response key), c0f151a (the docs). Nothing is pushed: the branch has no upstream, and publishing stays the human's decision.
