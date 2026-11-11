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

S8. THE ACCEPTANCE CRITERION, AND THE AUDIT QUESTION IT ANSWERS. "changing a *type* exported by
`@repo/wiki` does not select those three on the selective path, so `turbo run test
--filter=@repo/wiki` can report green without running a test that a type change breaks."

Consequence: the three type-only dependents (`test/provenance-metadata-shape.test.ts`,
`test/query-candidate-id-absent.test.ts`, `test/sdk/published-dimensions-port.test.ts`) must stop
being an undocumented property of the graph and become a declared, named, rot-guarded fact, with the
tier that observes them stated beside them.

S9. THE STRING-URL CLASS DECIDES THE DESIGN, AND DECLARATION MUST FAIL CLOSED. "A closure over
static imports cannot see that" … "If declaration is the answer, it must fail closed: a new test that
reaches a package by a non-import route should be unattributable and refused, not silently orphaned —
that is the same discipline that made UNATTRIBUTABLE [] instead of a frozen exception list."

Consequence: the fail-closed edge is the union test's total comparison of the `orphan` bucket against
`FROZEN_ORPHANS`; a new unreachable-by-import test must fail the run rather than join a list.

S10. THE DOC'S STATED BOUNDARY. "the doc's stated boundary must say \"static import specifiers only\"
and name require(, computed import( and new URL( as invisible"

S11. THE REASON THE DECLARATION EXISTS, WRITTEN AS A REASON AND NOT A TO-DO. "test cannot observe a
type-only edge at all, because the import is elided; the tier that observes it is root
`typecheck:tests`, and per-package typecheck was declined by the owner, so a selective green does not
speak for it. Write that as the reason the declaration exists, so nobody reads it as a to-do."

S12. ONE LINE, AFFECTED FLOW ONLY. "keep the `package-tasks.ts` line to one printed line on the
affected flow only."

S13. PROVE THE PIN BITES. "prove the exhaustiveness assertion bites by introducing a throwaway
type-only dependent, watching it go red, removing it and confirming green."

S14. DERIVE, DO NOT FREEZE. "Add a derivation that computes, from the COLLECTED test set, every test
file that reaches a package surface through a TYPE-ONLY import — scanning ALL collected tests, not
just orphans, so both the `orphan` and the `meta` shapes are covered." … "THE DECLARATION BECOMES AN
ANNOTATION, NOT THE TRUTH. Keep `TYPE_ONLY_DEPENDENTS` for the `reason` strings, but the assertion
becomes EXACT SET EQUALITY between derived and declared, BOTH directions, so an undeclared type-only
dependent fails and an annotation describing a file that no longer has the edge also fails."

S15. GATING BECOMES BEHAVIOURAL. "export a pure predicate (e.g. `shouldReportTypeOnlyDependents(task)`)
and test it for all four tasks (`test`, `lint`, `typecheck`, `fallow`)" — because "the call-site pin is
a source-text filter with a hole … a staged second call path left it 4/4 green".

S16. THE DEFINITION, AND WHY IT IS THE WHOLE FIX. "a pair is a type-only dependent of package P if
and only if (a) the test has a type-only import edge into P's source, AND (b) the test is NOT in P's
selection, i.e. `partition` did not attribute it to P. Condition (b) is the whole fix — it is the
difference between \"has a type edge\" and \"cannot be observed\"." … "Implement it where the partition
result exists (the bound wrapper in `scripts/package-selection.ts`), not by re-approximating the
closure inside the scanner. The scanner's job becomes edges only; the caller subtracts what the
selection covers."

S17. THREE SCANNER BLIND SPOTS, EACH DETECTED. "JD-A2-002 — `import type * as W from …`" must
register the edge; "JD-A2-003 — `export { type A } from`" is a TYPE reach, not a runtime one;
"JD-A2-004 — specifier attribution … Support `@repo/<pkg>/<subpath>` … and type imports targeting
`packages/<dir>/dist/…`. A type-only subpath import must not escape."

S18. SOUND WIRING ON BOTH SIDES. "Restore a SOUND structural guard: assert the exact number of
`reportTypeOnlyDependents(` occurrences in `scripts/package-tasks.ts` is 2" — and "have `main` print
from the set DERIVED at run time off the same partition result that produced the selection, so the
notice is true by construction on every run."

S19. THE RECORD'S FRAMING. "a notice that misinforms is worse than the silence it replaced";
"Gate-green proved the code ran, not that the claim was true."; the fourth file is the headline as
"one test invisible in every bucket", explicitly not "three orphan tests".

## Tasks

- T1 | S3, S4, S5, S7 | gentle-ai-worker | the declared `TYPE_ONLY_DEPENDENTS` manifest (file → package → why) on the existing public surface of `scripts/package-selection.ts`, so `orphan` becomes declared-with-reason | `d4d500d141367f6cc3516f3eb3d8d53e30ba1740`
- T2 | S4, S7 | gentle-ai-worker | one printed line on the affected flow only, in `scripts/package-tasks.ts` | `d4d500d141367f6cc3516f3eb3d8d53e30ba1740`
- T3 | S3, S4, S7 | gentle-ai-worker | RED first: `test/package-selection-union.test.ts`, pinning that the declaration is exhaustive and cannot rot — each declared file still exists, still lands in `orphan`, and its `import type` target still resolves to the named package | `d4d500d141367f6cc3516f3eb3d8d53e30ba1740`
- T4 | S2, S4, S7 | gentle-ai-worker | the stated boundary and the pairing in `docs/turborepo.md`, census regenerated in the same commit | `d4d500d141367f6cc3516f3eb3d8d53e30ba1740`
- T5 | S1, S6, S7 | gentle-ai-worker | this document, recording the audit and its pending remedy | `d4d500d141367f6cc3516f3eb3d8d53e30ba1740`

- T6 | S8-S13 | worker `gentle-ai-worker` — this feature document | `d84400907bbc4a626b6c9c81dd09d5f683350de4`
- T7 | S8, S9, S11 | worker `gentle-ai-worker` — `scripts/package-selection.ts`: boundary header, `TypeOnlyDependent`, `TYPE_ONLY_DEPENDENTS`, `typeOnlyDependentsOf` | `d84400907bbc4a626b6c9c81dd09d5f683350de4`
- T8 | S12 | worker `gentle-ai-worker` — `scripts/package-tasks.ts`: one stderr line on the `test` flow, pinned by `test/package-task-boundary-notice.test.ts` | `d84400907bbc4a626b6c9c81dd09d5f683350de4`
- T9 | S8, S9, S13 | worker `gentle-ai-worker` — `test/package-selection-union.test.ts`: rot guard, owner derivation, fail-closed exhaustiveness | `d84400907bbc4a626b6c9c81dd09d5f683350de4`
- T10 | S10, S11 | worker `gentle-ai-worker` — `docs/turborepo.md`: stated boundary, type-only pairing, orphan bucket status, regenerated census | `d84400907bbc4a626b6c9c81dd09d5f683350de4`
- T11 | S14 | worker `gentle-ai-worker` — `scripts/type-only-dependents.ts` (new): TypeScript-parsed derivation of every type-only dependent across ALL collected tests, four elided forms | `5e6af0825ba8251a5101584405e1aa45efca39a1`
- T12 | S14 | worker `gentle-ai-worker` — `scripts/package-selection.ts`: declaration demoted to annotation, derivation re-exported for one import surface | `5e6af0825ba8251a5101584405e1aa45efca39a1`
- T13 | S15 | worker `gentle-ai-worker` — `scripts/package-tasks.ts`: `shouldReportTypeOnlyDependents` predicate replaces the source-text gate | `5e6af0825ba8251a5101584405e1aa45efca39a1`
- T14 | S14, S15 | worker `gentle-ai-worker` — union + notice tests (exact equality both directions, four forms, four-task gate), three probes, `docs/turborepo.md` overclaim correction | `5e6af0825ba8251a5101584405e1aa45efca39a1`
- T15 | S17 | worker `gentle-ai-worker` — `scripts/type-only-dependents.ts`: edges only, namespace/inline-export/subpath forms, limits documented | TBD
- T16 | S16 | worker `gentle-ai-worker` — `scripts/package-selection.ts`: subtract the partition, so a pair means "not selected" | TBD
- T17 | S18 | worker `gentle-ai-worker` — `scripts/package-tasks.ts`: notice prints from the run's own derived set; structural two-occurrence guard | TBD
- T18 | S16, S19 | worker `gentle-ai-worker` — soundness assertion, specifier table, probes RED-S/RED-N1/N2/G/G2, docs correction | TBD
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

L9 — the assignment, verbatim. The audit question and the acceptance criterion are S8 above; the
Manager's operating frame for this slice was:

```
The per-package test selection has a named correctness hole: it can miss tests that depend on a
package through an edge the import graph does not model.

**Consequence, and it is your acceptance criterion:** changing a *type* exported by `@repo/wiki`
does not select those three on the selective path, so `turbo run test --filter=@repo/wiki` can
report green without running a test that a type change breaks.
```

L10 — F1, measured in `test/package-selection-union.test.ts` (273 lines at the base). The frozen
orphan pin is declared at `:78` as `const FROZEN_ORPHANS: readonly string[] = [` and consumed at
`:272` by

```
expect(result.orphan).toEqual([...FROZEN_ORPHANS]);
```

which is a **`toEqual` total comparison** — not a subset match, not `toContain`, not a length check.
The `UNATTRIBUTABLE` declaration is at `:67`, `const UNATTRIBUTABLE: readonly string[] = [];`, and it
is consumed at `:196` by `expect(result.uncovered).toEqual([...UNATTRIBUTABLE]);`, also total, with
the filtered universe built at `:163`. **If a NEW test landed in the orphan bucket, the assertion
fails** — observed, not inferred: a throwaway type-only dependent produced `expected [ …(30) ] to
deeply equal [ …(29) ]` and exit 1 (L14). No strengthening of `toEqual` was needed or performed.

L11 — F2, measured in `scripts/package-selection.ts` (280 lines at the base). The refusal lives in
`assertCoverage` at `:272-280`:

```
export function assertCoverage(result: PartitionResult, collected: readonly string[]): void {
  const covered = coveredTests(result);
  const missing = collected.filter((file) => !covered.has(file)).sort();
  if (missing.length === 0) return;
  const named = missing.map((file) => `  - ${file}`).join("\n");
  throw new Error(
    `package selection covers no bucket for ${missing.length} collected test(s):\n${named}`,
  );
}
```

and the accepted-bucket set is `coveredTests` at `:247`:

```
function coveredTests(result: PartitionResult): Set<string> {
  return new Set([...[...result.packages.values()].flat(), ...result.meta, ...result.orphan]);
}
```

**`orphan` IS in the accepted set, so the guard fails open today.** Making the class fail closed is a
change to the bucket's STATUS, not a new refusal in `assertCoverage`. Exports of the file at the
base, with line numbers: `PackageSurface` `:58`, `PACKAGE_SURFACES` `:73`, `META_ROOTS` `:119`,
`PartitionInput` `:122`, `PartitionResult` `:137`, `partition` `:225`, `assertCoverage` `:272`. Line
counts at the base: `scripts/package-selection.ts` 280, `test/package-selection-union.test.ts` 273,
`scripts/package-tasks.ts` 224.

L12 — F3, measured in `docs/turborepo.md` (1014 lines at the base). The census pair occurs **once**,
at `:130-131`, and nowhere else; `:57` (`runs the wiki selection (565 files in the census below)`),
`:982` and `:986` reference `565`/`405` in prose about the removed `^test` edge and are not census
lines. The literal text:

```
selection buckets: @repo/foundation=405 @repo/wiki=565 @repo/kg=549 @repo/api=13
meta=67 orphan=29 uncovered=0 collected=824 distinct=824 multiPackage=409
```

L13 — the measured mutation table, at base `5260d423`. A temporary type-only mutation in
`packages/wiki/src/utils/types.ts` (`QueryResult` gains `candidateId?: string`) left the `@repo/wiki`
selection at **565 files, byte-identical** (`cmp` of the sorted lists IDENTICAL, symmetric difference
0), with `collected=826 orphan=29 uncovered=0` unchanged. The three type-only tests have
`closure_size_excluding_self=0` and `bucket=orphan`. **With the mutation applied,
`vitest run test/query-candidate-id-absent.test.ts` exits 0** — the `test` tier cannot observe a
type-only edge, because the import is elided. **With the mutation applied,
`corepack pnpm run typecheck:tests` exits 1** with `test/query-candidate-id-absent.test.ts: 1
diagnostics exceeds baseline 0`. Root-only tier; per-package `typecheck:tests` does not exist and was
declined by the owner. And `test/artifact/dist-specifiers.test.ts` reaches the built artefact via
`fileURLToPath(new URL("../..", import.meta.url))` at `:99`: `bucket=orphan`, closure 0, no package
and no module. `require(`, computed `import(` and `new URL(` are all invisible to the crawl.

L14 — S13 executed. `test/zz-throwaway-type-only-probe.test.ts` was created importing only
`type { QueryResult } from "../packages/wiki/src/utils/types.js"`;
`corepack pnpm exec vitest run test/package-selection-union.test.ts` exited **1** with
`expected [ …(30) ] to deeply equal [ …(29) ]`, the diff adding
`+ "test/zz-throwaway-type-only-probe.test.ts"` at `test/package-selection-union.test.ts:272`. The
file was deleted and the same command exited **0** with 6 tests passed. The fail-closed premise is
therefore true, and the throwing dependent's red is the *pin's* red, not a new guard's.

L15 — the bucket status, recorded in the Manager's own words: "`orphan` is an accepted bucket, so
fail-closed means changing the bucket's status, not adding a refusal. All 29 currently run in no
per-package selection and nothing complains."

L16 — two named gaps NOT absorbed by this slice. (i) The `ProvenanceMetadata` rename-through-`extends`
narrowing of `test/provenance-metadata-shape.test.ts`: a rename that survives structurally through an
`extends` is not caught by the declared rot guard, which asserts only that the declared type import
still exists from the declared module. (ii) There is no repository-side list mode for the selection;
the audit used a `/tmp` driver reproducing the census (`@repo/foundation=405 @repo/wiki=565
@repo/kg=549 @repo/api=13`, `orphan=29`, `uncovered=0`) rather than a committed command, and that
driver stays in `/tmp` by instruction.

L17 — the accidental escape, recorded because it is indistinguishable from coverage:
`test/artifact/entries-load.test.ts` stays out of `uncovered` only because it incidentally imports
`test/artifact/artifact-text.ts`, a `META_ROOTS` path. An escape by coincidence is indistinguishable
from coverage, which is why `meta` is a directory class and not a per-file allowance.

L18 — census decision (S10). This slice moves **no** count: the buckets stay
`@repo/foundation=405 @repo/wiki=565 @repo/kg=549 @repo/api=13`, `orphan=29`, `uncovered=0`, because
no collected test FILE is added — the new tests live inside `test/package-selection-union.test.ts`,
which the partition already collects. The printed line at this commit reads `meta=69 orphan=29
uncovered=0 collected=826 distinct=826`, two files above the frozen pair at `docs/turborepo.md:130`.
That delta is pre-existing drift at the base (two test files landed after the block was generated),
so the frozen numbers were left untouched and the drift was recorded in the page instead of silently
rewritten. The `package-tasks.ts` print was observed literally:
`package-tasks: @repo/wiki has 3 declared type-only dependent test(s) this selection cannot observe
(test/provenance-metadata-shape.test.ts, test/query-candidate-id-absent.test.ts,
test/sdk/published-dimensions-port.test.ts); root \`typecheck:tests\` is the covering tier`, and
`@repo/api` produced no such line and exited 0.

L19 — follow-up: the stderr notice is now pinned, which closes the first slice's `Risk: item 6`. L18's
observation stands as measurement, but a developer-flow notice that nothing can pin is not shippable, so
`reportTypeOnlyDependents` is an EXPORT of `scripts/package-tasks.ts` (the effect layer; it cannot live in
`package-selection.ts`, which is pure by contract and decides buckets rather than printing) and is driven
directly by `test/package-task-boundary-notice.test.ts` — the SIXTH path of this slice, a NEW file rather
than an addition to `test/package-task-selection.test.ts`, because importing `../scripts/package-tasks.js`
there would lift that file out of the frozen `orphan` pin (29 -> 28). Four cases: the exact line for
`@repo/wiki` byte for byte (`toBe` on the captured stderr), nothing at all for `@repo/api`, the pinned
sentence still agreeing with `TYPE_ONLY_DEPENDENTS`, and the call-site rot guard
`if (task === "test") reportTypeOnlyDependents(surface);`. RED observed first:
`TypeError: (0 , reportTypeOnlyDependents) is not a function` (2 failed | 2 passed, exit 1); GREEN after
the export (4 passed, exit 0). The notice is spawn-free, so per rule 3 of `scripts/output-contracts.ts`
("If a spawn-free assertion can pin the same contract, add it to the unit tier instead and do NOT list
the file here") it is a unit-tier assertion and is NOT added to `OUTPUT_CONTRACT_TESTS`.

L20 — census move caused by the new test file, recorded and deliberately NOT acted on. The new file
reaches `scripts/` and lands in `meta`, so the printed census is now
`@repo/foundation=405 @repo/wiki=565 @repo/kg=549 @repo/api=13 meta=70 orphan=29 uncovered=0
collected=827 distinct=827 multiPackage=409`: `meta` +1 and `collected`/`distinct` +1, with every package
bucket, `orphan=29` and `uncovered=0` unchanged. `docs/turborepo.md:130-131` was left untouched for the
Manager to decide. Re-derived membership for the three declared files, measured with a throwaway probe
test written, run and deleted inside one command: all three read
`closure=1 excluding_self=0 bucket=orphan`, so selection membership did NOT move.

L21 — the census block was REGENERATED in the commit that closes this slice, superseding L18's
decision to leave it frozen. Two corrections went in together and are recorded as two because only one
is ours. PRE-EXISTING drift, corrected: `docs/turborepo.md:130-131` read `meta=67 orphan=29 uncovered=0
collected=824 distinct=824`, while the base commit `5260d423` itself printed `meta=69 orphan=29
uncovered=0 collected=826 distinct=826` — two test files had landed after the block was generated.
THIS SLICE's delta: `test/package-task-boundary-notice.test.ts` reaches `scripts/` and lands in `meta`,
so `meta` +1 and `collected`/`distinct` +1. Before: `@repo/foundation=405 @repo/wiki=565 @repo/kg=549
@repo/api=13` / `meta=67 orphan=29 uncovered=0 collected=824 distinct=824 multiPackage=409`. After:
`@repo/foundation=405 @repo/wiki=565 @repo/kg=549 @repo/api=13` / `meta=70 orphan=29 uncovered=0
collected=827 distinct=827 multiPackage=409`. The rest of the page was audited rather than
re-synchronised: the two other census-sense numbers were stale and are now `142 of the 827` and `root
pnpm test collects 827 files`; line 57's "565 files in the census below", the 565-file and 405-file
references in the removed-`^test`-edge prose, `@repo/kg=549`, `orphan=29` and the `78`/`69`/`0` exit
codes were each verified to still be true and left alone.

L22 — the slice is committed as ONE work unit. Commit
`d84400907bbc4a626b6c9c81dd09d5f683350de4` (`feat(selection): declare type-only dependents and fail
closed on unreachable tests`) holds all six paths: `scripts/package-selection.ts`,
`scripts/package-tasks.ts`, `test/package-selection-union.test.ts`,
`test/package-task-boundary-notice.test.ts`, `docs/turborepo.md` and this document. The notice was NOT
split into its own commit: it is the developer-facing half of the same declaration, and a commit that
declared a gap without telling the developer about it would be the half-fix this slice exists to avoid.
The full pre-commit battery ran on that tree, hooks included and not bypassed: `tsc --noEmit` 0,
`typecheck:tests` 0 (1592 files), `build` 0, `lint` 0 (triple 558 / 396 / 423, unchanged), `fallow:ci` 0,
and the full suite `pnpm test` exit 0 with `Test Files 824 passed | 3 skipped (827)` and `Tests 6139
passed | 4 skipped (6143)` in 323.32 s, load 2.59 before and 6.61 after. The suite's own `827` collected
files is an independent confirmation of the regenerated census in L21.

L23 — JUDGE FINDINGS, and how each was closed. The root cause was design, not implementation:
`TYPE_ONLY_DEPENDENTS` was a FROZEN LIST, and this repository distrusts frozen lists because a
frozen list can only prove that what it names is real, never that it names everything. The list is
now an ANNOTATION over a DERIVED set (`scripts/type-only-dependents.ts`, TypeScript compiler API
over every collected test), and the assertion is exact set equality in both directions.

  - **JD-A-001 (CRITICAL) — CLOSED.** `test/viewer-sidebar.test.ts:18` imports
    `type { ViewerPage } from "../packages/wiki/src/viewer/types.js"` and every other repo import is
    `./fixtures/viewer-jsdom.js`, so it is `meta`, absent from the 565-file wiki selection, not in
    `orphan`, and was undeclared. The derivation finds it with no knowledge of it being special;
    RED-1 named it (`+ "test/viewer-sidebar.test.ts -> @repo/wiki"`) and it is now annotated. The
    notice for `@repo/wiki` reads 7, not 3 and not 4.
  - **JD-A-004 — CLOSED.** A non-import-route dependency that also imports a `META_ROOTS` path was
    accepted silently. The derivation scans ALL collected tests, not just orphans, so the bucket is
    irrelevant: RED-2b staged exactly that shape (`test/zz-meta-type-probe.test.ts`, `meta` 70 -> 71,
    suite otherwise green) and the run went red naming it. The doc overclaim is corrected: what is
    REFUSED is a type-only dependent in any bucket; what stays invisible is `require(`, computed
    `import(` and `new URL(` — undeclared-by-detection, not refused.
  - **JD-A-002 — CLOSED.** Deleting one entry used to leave all 9 union cases green. Deletion now
    fails: RED-2a dropped `test/mcp/query-sources-use-filesystem.test.ts` and the run named exactly
    that pair. The guard is bidirectional, so a stale annotation fails too.
  - **JD-A-003 / JD-A-005 / JD-A-006 — CLOSED.** The call-site source-text filter is DELETED and
    replaced by the exported pure predicate `shouldReportTypeOnlyDependents`, asserted for all four
    tasks (`[true, false, false, false]`). The tautological "fails closed" case is DELETED; its bite
    is now the exact-equality assertion, proven by the two probes above and by a committed case that
    drives the same diff helper with known inputs in both directions. The four fragile string checks
    are DELETED rather than patched: a derived entry is true by construction, only the `reason` is
    checked, and the scanner recognises `import type { X } from`, `import type X from`, inline
    `import { type X } from` and `export type { X } from`, each asserted as a literal row.

L24 — CORRECTION to L19 and to the census prose it carried. L19 stated the notice names three files
and that the declaration was complete; both were false, and the measurement that falsified them is
L23. The derived set is SEVENTEEN pairs across two packages — seven `@repo/wiki`, ten
`@repo/foundation` — so the first frozen list of three was short by FOURTEEN, not by one. Every
earlier entry stands as the record of what was believed at the time; this line is the correction.

L25 — cost and gates for this work unit. The derivation parses 827 collected files with
`ts.createSourceFile` behind a `text.includes("from")` gate, which no elided form can pass without:
wall time of `test/package-selection-union.test.ts` went from 7.48-7.77 s to 8.36 s, so the
derivation costs about 0.6-0.9 s, well inside the ~5 s budget, and nothing was traded for speed. The
census did NOT move: `@repo/foundation=405 @repo/wiki=565 @repo/kg=549 @repo/api=13 meta=70 orphan=29
uncovered=0 collected=827 distinct=827 multiPackage=409` before and after, because the derivation
adds no collected test file.

L26 — the judge fix is committed as ONE work unit: `5e6af0825ba8251a5101584405e1aa45efca39a1`
(`fix(selection): derive the type-only dependents instead of freezing a list`), seven paths —
`scripts/type-only-dependents.ts` (new), `scripts/package-selection.ts`, `scripts/package-tasks.ts`,
`test/package-selection-union.test.ts`, `test/package-task-boundary-notice.test.ts`,
`docs/turborepo.md` and this document. The probe/revert evidence, in order: RED-1 with the declaration
trimmed to the original three names → `2 failed | 8 passed`, `expected [ …(13) ] to deeply equal []`
naming `+ "test/viewer-sidebar.test.ts -> @repo/wiki"`; RED-2a with
`test/mcp/query-sources-use-filesystem.test.ts` dropped → `expected [ Array(1) ] to deeply equal []`
naming exactly that pair; RED-2b with `test/zz-meta-type-probe.test.ts` staged (type-only wiki import
plus a `test/fixtures` import, census `meta=70 -> 71`) → red naming that pair, then the file deleted and
`git status --short` showing no probe. GREEN: 14 focused tests across the two files.
The battery on the committed tree: `tsc --noEmit` 0, `typecheck:tests` 0 (1592 files), `lint` 0
(558 / 396 / 423, unchanged), `fallow:ci` 0 — after it FAILED the first draft with 4 findings (three
unused type re-exports and a `package-selection.ts <-> type-only-dependents.ts` cycle), fixed by
inverting the dependency and dropping the unused re-exports rather than suppressing them — `build` 0,
and the full suite `pnpm test` exit 0 with `Test Files 824 passed | 3 skipped (827)`, `Tests 6140
passed | 4 skipped (6144)` in 324.70 s, load 1.35 before and 6.67 after. The census did NOT move in this
work unit either: `meta=70 orphan=29 uncovered=0 collected=827` with the four package buckets unchanged,
so `docs/turborepo.md:130-131` needed no regeneration.

L27 — SECOND JUDGE PASS. The derivation was UNSOUND, not merely incomplete: it filtered with a
file's DIRECT runtime imports while `partition` attributes by the TRANSITIVE closure, so twelve of
its seventeen pairs were tests their own selection already runs. That is the worst kind of error for
a notice, because **"a notice that misinforms is worse than the silence it replaced"**. Each finding:

  - **JD-A2-001 (soundness) — CLOSED.** The scanner now reports EDGES only, and
    `deriveTypeOnlyDependents` subtracts `partition`'s attribution. RED-S: with the subtraction
    staged out, the soundness assertion named `+ "test/query-stale-warning.test.ts -> @repo/wiki"` as
    "claimed unobservable but IS in that package's selection", and the raw edge set was 125 pairs
    (the new attribution fixes below catch far more edges than the old scanner did). Measured sound
    set: FIVE pairs over FOUR files, all `selected=false` — see L28.
  - **JD-A2-002 (namespace binding) — CLOSED.** `import type * as W from "./w.js"` now registers the
    edge with `*` as the recorded specifier; asserted as a literal row `["./w.js", true, "*"]`.
  - **JD-A2-003 (inline type re-export) — CLOSED.** `export { type A } from` is a TYPE reach, decided
    element by element; rows `["./j.js", true, "J"]` and the control `["./k.js", false, "K,l"]`. This
    was wrong in the direction that HIDES findings: an elided reach read as runtime suppresses every
    other type-only edge to that package in the same file, which the scanner header now states.
  - **JD-A2-004 (specifier attribution) — CLOSED.** `packageOfSpecifier` matches the exact surface,
    its `@repo/<pkg>/<subpath>` form, relative paths under a source root, and the surface DIRECTORY
    so `packages/wiki/dist/…` cannot escape; pinned by an eight-row table including two controls.
  - **JD-A2-005 (lost wiring guard) — CLOSED, both directions.** The guard asserts the exact number of
    `reportTypeOnlyDependents(` occurrences is 2. RED-G (call site deleted): `expected 1 to be 2`.
    RED-G2 (the judge's mutant, an ungated second call): `expected 3 to be 2`. Reverted, 5/5 green.
  - **JD-A2-006 (notice printed from the annotation) — CLOSED.** `main` prints
    `selection.typeOnly`, derived in the same `deriveSelection` call that produced the selection, so
    the notice is true by construction on every run; a structural case asserts the CLI never mentions
    `typeOnlyDependentsOf` or `TYPE_ONLY_DEPENDENTS`. The annotation keeps only `reason` text and its
    job is the fail-closed ratchet.

L28 — the measured sound set, per pair, from a throwaway probe (written, run, deleted):
```
TRUTH collected=828 pairs=5 files=4
TRUTH PAIR test/provenance-metadata-shape.test.ts -> @repo/wiki bucket=orphan closure=0 selected=false
TRUTH PAIR test/query-candidate-id-absent.test.ts -> @repo/wiki bucket=orphan closure=0 selected=false
TRUTH PAIR test/sdk/published-dimensions-port.test.ts -> @repo/foundation bucket=orphan closure=0 selected=false
TRUTH PAIR test/sdk/published-dimensions-port.test.ts -> @repo/wiki bucket=orphan closure=0 selected=false
TRUTH PAIR test/viewer-sidebar.test.ts -> @repo/wiki bucket=meta closure=1 selected=false
```
Four `@repo/wiki`, one `@repo/foundation`, four files — the Manager's predicted 5/4 confirmed by
measurement rather than assumed. `collected=828` in that line includes the probe itself; the real
count is 827.

L29 — RED-N, both shapes, and the findings already closed. RED-N1 staged the `viewer-sidebar` shape
(type edge + `test/fixtures` only, unselected): red naming
`+ "test/zz-unselected-probe.test.ts -> @repo/wiki"`. RED-N2 staged the `query-stale-warning` shape
(type edge + `test/fixtures/typed-grounding.ts`, which imports wiki at runtime): the run stayed GREEN,
`12 passed`, the file appeared nowhere, and the census moved `@repo/wiki=565 -> 566`, proving the
probe joined the selection and that the sound derivation refuses to report it. Re-proved after the
change: JD-A-001 (viewer-sidebar is in the byte-exact notice pin and in the derived set);
JD-A-002 (deleting that annotation gives `expected [ Array(1) ] to deeply equal []` naming it);
JD-A-004 (`meta` bucket is covered — the probe above is `meta` and is caught); JD-A-005 (no
tautology; the non-vacuity case drives the real diff helper both ways).
