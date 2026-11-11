# selection-type-and-url-edges
Record: a completed audit, documentation only — no task below was implemented, and nothing the audit found was changed, fixed or "improved". Every figure in `L2`–`L8` is a measurement taken on `5260d423963bd84911c239bfa5e57d2eec02bffe`, and the measurements refute the obvious patch on evidence rather than on cost (`S5`).
Not: a proposal awaiting approval, and not work in progress. Its author session kept dying before the first source write, so the measurement survived and the five-file remedy (`S7`) is left pending.

## Specs

S1. The named correctness hole, quoted exactly (`L1`): *"The per-package test selection has a named correctness hole: it can miss tests that depend on a package through an edge the import graph does not model."* This sentence is the entire request. Nothing below narrows it, and no task below closed it.

S2. The blind-spot boundary is the recorded phrase **"static import specifiers only"** (`L5`). The graph is built only from Vite's `transformRequest(url, { ssr: true })` and walked over `importedModules`, the SSR transform **erases type-only imports**, and `require(`, computed `import(` and `new URL(` are **invisible** to the crawl. The anchor case is `test/artifact/dist-specifiers.test.ts:99` (`new URL("../..")`), measured `bucket=orphan` with closure **0**, depending on no package and no module at all. Acceptance for any future work on this class: it must state this boundary where a developer reads it, and must not claim the graph models an edge the graph cannot see.

S3. `orphan` is an **accepted** bucket today (`L6`), so all 29 run in no per-package selection and nothing complains. **Fail-closed therefore means changing the orphan bucket's status, not adding a new refusal.** Recorded alongside it, and not absorbed: `test/artifact/entries-load.test.ts` escapes `uncovered` only by incidentally importing `test/artifact/artifact-text.ts`, a `META_ROOTS` path — an escape by coincidence is indistinguishable from coverage. Acceptance: the orphan bucket becomes declared-with-reason rather than accepted wholesale, and the declaration is what a new orphan cannot pass silently.

S4. The tier that observes the type-only edge exists and names the file: root `typecheck:tests` (`L4`). It is root-only, and a per-package `typecheck:tests` was **declined by the owner**, so the remedy is to **declare the boundary where the developer flow reads it and make it fail closed instead of accepted.** Acceptance: no per-package `typecheck:tests` is introduced, and the boundary is stated on the flow a developer actually reads.

S5. The obvious patch is refuted **on evidence, not on cost** (`L4`). `import type` is elided, so a type-only dependent **cannot go red in the `test` tier even when the type contract is broken**. Adding the `import type` edge to the selection would move those files from OUT to IN while the selective run still reports green on a broken contract — *one vitest invocation slower, no more honest*. Acceptance: no work is justified by making the selective run slower; a change that cannot turn red is not a fix.

S6. No task was implemented (`L7`). **The author's session failed repeatedly before the first source write.** Every task row below carries commit `pending`. Acceptance: this document is the deliverable; it adds no source, test, docs or workflow change of its own.

S7. The remedy is recorded as pending and unimplemented, and it is exactly five files (`L7`): `scripts/package-selection.ts` (a declared `TYPE_ONLY_DEPENDENTS` manifest, file → package → why, exposed on the existing public surface, so `orphan` becomes declared-with-reason rather than accepted wholesale); `scripts/package-tasks.ts` (one printed line on the affected flow only); `test/package-selection-union.test.ts` (RED first: the declaration is exhaustive and cannot rot — each declared file still exists, still lands in `orphan`, and its `import type` target still resolves to the named package; a new type-only dependent must break the pin and force a declaration); `docs/turborepo.md` (the stated boundary and the pairing, census regenerated in the same commit); and this document. Acceptance: no sixth file, no widening of the boundary claim, and no implementation before a task is opened.

## Tasks

- T1 | S3, S4, S5, S7 | gentle-ai-worker | the declared `TYPE_ONLY_DEPENDENTS` manifest (file → package → why) on the existing public surface of `scripts/package-selection.ts`, so `orphan` becomes declared-with-reason | pending
- T2 | S4, S7 | gentle-ai-worker | one printed line on the affected flow only, in `scripts/package-tasks.ts` | pending
- T3 | S3, S4, S7 | gentle-ai-worker | RED first: `test/package-selection-union.test.ts`, pinning that the declaration is exhaustive and cannot rot — each declared file still exists, still lands in `orphan`, and its `import type` target still resolves to the named package | pending
- T4 | S2, S4, S7 | gentle-ai-worker | the stated boundary and the pairing in `docs/turborepo.md`, census regenerated in the same commit | pending
- T5 | S1, S6, S7 | gentle-ai-worker | this document, recording the audit and its pending remedy | pending

## Log

L1 — the original request, verbatim:

"The per-package test selection has a named correctness hole: it can miss tests that depend on a package through an edge the import graph does not model."

L2 — the mutation and its measurement, transcribed as measurement and not as proposal.

Mutation: one type-only line in `packages/wiki/src/utils/types.ts` — `QueryResult` gains `candidateId?: string` — reverted with `git checkout --`; `git status --short` and `git diff --stat` both empty before and after.

| measurement | result |
|---|---|
| selective set `@repo/wiki`, baseline | **565** files (`collected=826`, `orphan=29`, `uncovered=0`) |
| selective set, mutation applied | **565** files, `cmp` of sorted lists **IDENTICAL**, symmetric difference **0** |
| the three `import type` tests | **OUT** in both, closure size excluding self **= 0** for all three |
| `vitest run test/query-candidate-id-absent.test.ts` **with the mutation applied** | **exit 0** — 1 file / 1 test passed |
| `typecheck:tests` **with the mutation applied** | **exit 1** — `test/query-candidate-id-absent.test.ts: 1 diagnostics exceeds baseline 0` |

L3 — the three type-only dependents, with their sites: `test/provenance-metadata-shape.test.ts:24-28`, `test/query-candidate-id-absent.test.ts:14`, `test/sdk/published-dimensions-port.test.ts:60-70`.

L4 — the verdict: classification `(b)` facts, `(c)` remedy. `import type` is elided, so a type-only dependent **cannot go red in the `test` tier even when the type contract is broken**. Adding the `import type` edge to the selection would move those files from OUT to IN while the selective run still reports green on a broken contract — *one vitest invocation slower, no more honest*. Modelling the edge is therefore refuted **on evidence, not on cost**. The tier that observes the edge exists and names the file: root `typecheck:tests`. It is root-only, and a per-package `typecheck:tests` was **declined by the owner**, so the remedy is to declare the boundary where the developer flow reads it and make it fail closed instead of accepted.

L5 — why the class is not modellable. The graph is built only from Vite's `transformRequest(url, { ssr: true })` and walked over `importedModules`. The SSR transform **erases type-only imports**, so those edges are not recoverable from what the graph stores; and `require(`, computed `import(` and `new URL(` are **invisible** to the crawl. The blind spot is exactly *"static import specifiers only"*. The anchor case is `test/artifact/dist-specifiers.test.ts:99` (`new URL("../..")`), measured `bucket=orphan` with closure **0**, depending on no package and no module at all.

L6 — why it fails open today. `orphan` is an **accepted** bucket, so all 29 run in no per-package selection and nothing complains. Fail-closed therefore means **changing the orphan bucket's status**, not adding a new refusal. Related: `test/artifact/entries-load.test.ts` escapes `uncovered` only by incidentally importing `test/artifact/artifact-text.ts`, a `META_ROOTS` path — an escape by coincidence is indistinguishable from coverage.

L7 — the proposed fix, recorded as pending and unimplemented — five files: `scripts/package-selection.ts` (a declared `TYPE_ONLY_DEPENDENTS` manifest, file → package → why, exposed on the existing public surface, so `orphan` becomes declared-with-reason rather than accepted wholesale); `scripts/package-tasks.ts` (one printed line on the affected flow only); `test/package-selection-union.test.ts` (RED first: the declaration is exhaustive and cannot rot — each declared file still exists, still lands in `orphan`, and its `import type` target still resolves to the named package; a new type-only dependent must break the pin and force a declaration); `docs/turborepo.md` (the stated boundary and the pairing, census regenerated in the same commit); and this document.

State plainly that **no task was implemented** and why: the author's session failed repeatedly before the first source write.

L8 — side findings, recorded not absorbed: `ProvenanceMetadata` renames propagate through `extends` at `types.ts:80,165`, so `test/provenance-metadata-shape.test.ts` stays green on a rename and only fails on key loss — its guard is narrower than its name; and there is **no repo-side list mode** for the selection, so the measurement used a `/tmp` driver that reproduced the documented census `405/565/549/13` exactly.
