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

## Tasks

- T1 | S3, S4, S5, S7 | gentle-ai-worker | the declared `TYPE_ONLY_DEPENDENTS` manifest (file → package → why) on the existing public surface of `scripts/package-selection.ts`, so `orphan` becomes declared-with-reason | `d84400907bbc4a626b6c9c81dd09d5f683350de4`
- T2 | S4, S7 | gentle-ai-worker | one printed line on the affected flow only, in `scripts/package-tasks.ts` | `d84400907bbc4a626b6c9c81dd09d5f683350de4`
- T3 | S3, S4, S7 | gentle-ai-worker | RED first: `test/package-selection-union.test.ts`, pinning that the declaration is exhaustive and cannot rot — each declared file still exists, still lands in `orphan`, and its `import type` target still resolves to the named package | `d84400907bbc4a626b6c9c81dd09d5f683350de4`
- T4 | S2, S4, S7 | gentle-ai-worker | the stated boundary and the pairing in `docs/turborepo.md`, census regenerated in the same commit | `d84400907bbc4a626b6c9c81dd09d5f683350de4`
- T5 | S1, S6, S7 | gentle-ai-worker | this document, recording the audit and its pending remedy | `d84400907bbc4a626b6c9c81dd09d5f683350de4`

- T6 | S8-S13 | worker `gentle-ai-worker` — this feature document | TBD
- T7 | S8, S9, S11 | worker `gentle-ai-worker` — `scripts/package-selection.ts`: boundary header, `TypeOnlyDependent`, `TYPE_ONLY_DEPENDENTS`, `typeOnlyDependentsOf` | TBD
- T8 | S12 | worker `gentle-ai-worker` — `scripts/package-tasks.ts`: one stderr line on the `test` flow | TBD
- T9 | S8, S9, S13 | worker `gentle-ai-worker` — `test/package-selection-union.test.ts`: rot guard, owner derivation, fail-closed exhaustiveness | TBD
- T10 | S10, S11 | worker `gentle-ai-worker` — `docs/turborepo.md`: stated boundary, type-only pairing, orphan bucket status | TBD
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
