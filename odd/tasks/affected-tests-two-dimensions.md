# affected-tests-two-dimensions

Feature: make the affected-test selector and its escalation tier cover both the root `test/**` tree and the `packages/llmwiki-kg/**` tree.
Branch: fix/affected-tests-two-dimensions. Led by the ODD Lead; writers execute T3-T8.

## Specs

### S1 — both dimensions are candidates
"The selector must enumerate candidates from both trees, not just `test/**`."
Concretely: the unit and integration tiers of `scripts/test-partition.ts`, and therefore the escalation tier of `scripts/run-affected-tests.ts`, must enumerate test files from the root `test/**` tree AND from the `packages/llmwiki-kg/**` tree. Acceptance: no test file that `vitest run` collects may fall outside both tiers, and the unit tier must contain at least one `packages/llmwiki-kg/` entry.

### S2 — the alias bridge
"It must bridge the `llmwiki-kg` alias in the import graph, so a change in `packages/llmwiki-kg/ts/src/x.ts` selects (a) the kg package tests that import it and (b) any root test that reaches it transitively through `src/dimensions/**` or `src/**`."
"(a)" and "(b)" are already satisfied by vitest's own resolver through the alias at `vitest.config.ts:38`; the requirement is therefore to PIN that behaviour with a test, not to rebuild an import graph. Acceptance: a committed test observes that a kg source change selects at least one `packages/**` test AND at least one root `test/dimensions/**` test.

### S3 — escalation stays intact and becomes complete
"Keep the existing escalation rule intact: `package.json`, `package-lock.json`, `vitest.config.ts`, `tsconfig*.json`, and `scripts/**` still escalate to the full unit tier. Something that touches both trees must escalate rather than guess."
Acceptance: `GLOBAL_SCOPE_PATHS` and `GLOBAL_SCOPE_DIRS` in `scripts/test-affected.ts:31-40` remain exactly those five paths and that one directory; `isGlobalScope` still returns true for each of them and false for a `packages/llmwiki-kg/ts/src/**` file; and the escalated tier now runs the kg tests too.

### S4 — no assertion weakened
"Do not change any test file's content, do not weaken any assertion, and do not touch `package.json` test scripts beyond what is strictly required."
Acceptance: the only files whose content changes are `scripts/test-partition.ts` plus new test files plus documentation; no existing test body is modified, and no `package.json` script string changes.

### S5 — proof discipline
"Demonstrate the blind spot before the fix and its absence after, with actual runs" covering: (a) a no-op touch of `packages/llmwiki-kg/ts/src/core/ontology.ts` selecting zero or the wrong files BEFORE the fix; (b) after the fix, the kg tests that import it plus the root tests that reach it through the alias, with the selected file names in each case; (c) the root->kg direction; (d) `package-lock.json` still escalating to the full unit tier. "Revert every probe edit afterwards; the tree must end clean."
Honest limit, recorded as a finding rather than faked: no kg test imports root code, so direction (c) has no import edge and selects zero by correctness, not by defect.

### S6 — tests for the selector itself
Add tests that pin the selection rules: "a kg source change selects the importing kg test, the alias bridge is exercised, and the escalation paths still escalate." "The selector is currently trusted without tests, which is how it silently covered half the repo."

### S7 — delivery
Commit in reviewable slices (~400 authored changed lines) with conventional messages on `fix/affected-tests-two-dimensions`, tests alongside. Gates with exact scope run: `npx tsc --noEmit`, `npm run build`, `npm run test:affected`, `npx fallow 2.82.0`. "Do not push."

### S8 — repository constraints (AGENTS.md)
Code and test files stay under 400 lines excluding comments; functions and tests under 40 lines excluding comments and try/catch catch/finally blocks. Every file gets a substantial top-of-file JSDoc comment. Comments say why, not what. `.md` files are exempt from the line limits, so this document may grow.

## Tasks
- T1 env readiness: pinned dependency install in this worktree; no tracked writes. S7. worker. no commit: gitignored dependency install only
- [x] T2 feature document (this file). S1-S8. worker. this commit
- T3 RED: selector tests that fail before the fix — unit tier enumerates the kg tree; unit + integration cover every collected test file; escalation inputs still escalate; kg source is not global scope. S1, S3, S6. worker. bf12016 (RED observation is that slice's evidence; not re-observed here)
- T4 GREEN: widen enumeration roots in `scripts/test-partition.ts` to every tree `vitest run` collects, skipping `node_modules`, `dist`, `.worktrees`, `.claude`, keeping the existing unit/integration classification rule unchanged. S1, S3, S4. worker. bf12016 (re-observed here: unit tier 723 files, 86 of them under `packages/`)
- [x] T5 alias-bridge pin: one test proving a kg source change selects kg tests and root dimension tests. S2, S6. worker. 18da507 (`test/affected-escalation-wiring.test.ts`)
- [x] T6 docs: update any prose that describes what the unit tier covers, if such prose exists. S7. worker. this commit
- T7 gates: tsc, build, test:affected, fallow 2.82.0 with exact scope run. S7. worker. bf12016 recorded the gates for the enumeration slice; this slice's own gates are reported in L5 below
- T8 independent verification: verdict per `S#`, fresh eyes, never the implementer. S1-S6. gentle-ai-verify. pending — not started, and an implementer cannot satisfy it

## Log

### L1 — original request (verbatim)
Project assignment for branch fix/affected-tests-two-dimensions:

Fix the affected-test selector in llmwiki so it covers BOTH dimensions: the root `test/**` tree AND the `packages/llmwiki-kg/**` tree. Read `AGENTS.md` first and obey it.

=== THE DEFECT ===
`npm run test:affected` (`scripts/run-affected-tests.ts`, which `package.json:32` wires; reports also name `scripts/test-affected.ts` -- reconcile which file is real and say so) diffs against the merge-base and runs `vitest related` over the changed files. But `scripts/test-partition.ts` carries `TEST_DIR = "test"`, so the entire `packages/llmwiki-kg/**` half of the suite is never a candidate: 83 test files and ~900 tests are invisible to the selector.

This matters concretely because the product HAS two dimensions. `src/dimensions/activation.ts:45` imports the bare specifier `llmwiki-kg`, which resolves only through the vitest alias at `vitest.config.ts:38` -> `packages/llmwiki-kg/ts/src/core-index.ts`. So a change inside `packages/llmwiki-kg/ts/src/**` can break root dimension tests, and a change in shared root code can break kg tests -- in both directions, and today the selector sees neither crossing.

Verify all of the above before changing anything and report what is actually true, with `path:line`. If `vitest related` already crosses the alias in one direction, say which direction and prove it.

=== WHAT TO FIX ===
1. The selector must enumerate candidates from both trees, not just `test/**`.
2. It must bridge the `llmwiki-kg` alias in the import graph, so a change in `packages/llmwiki-kg/ts/src/x.ts` selects (a) the kg package tests that import it and (b) any root test that reaches it transitively through `src/dimensions/**` or `src/**`.
3. Keep the existing escalation rule intact: `package.json`, `package-lock.json`, `vitest.config.ts`, `tsconfig*.json`, and `scripts/**` still escalate to the full unit tier. Something that touches both trees must escalate rather than guess.
4. Do not change any test file's content, do not weaken any assertion, and do not touch `package.json` test scripts beyond what is strictly required.

=== PROOF -- RED FIRST, AND IT MUST BE REAL ===
Demonstrate the blind spot before the fix and its absence after, with actual runs:
a. Touch a real source file under `packages/llmwiki-kg/ts/src/core/` (e.g. `ontology.ts`) with a no-op change, run the selector BEFORE the fix, and show that it selects zero or the wrong files for it.
b. After the fix, the same change must select the kg package tests that import it, AND the root tests that reach it through the alias. Name the files selected in each case.
c. Repeat for a shared root file that kg tests consume, to prove the other direction.
d. Prove the escalation still fires: a `package-lock.json` touch still goes to the full unit tier.
Revert every probe edit afterwards; the tree must end clean.

=== TESTS FOR THE SELECTOR ITSELF ===
Add tests that pin the selection rules: a kg source change selects the importing kg test, the alias bridge is exercised, and the escalation paths still escalate. The selector is currently trusted without tests, which is how it silently covered half the repo.

=== DELIVERY ===
Commit in reviewable slices (~400 authored changed lines) with conventional messages on `fix/affected-tests-two-dimensions`, tests alongside. Gates with exact scope run: `npx tsc --noEmit`, `npm run build`, `npm run test:affected`, `npx fallow`. Note that `fallow` is not on PATH in this environment; `npx fallow 2.82.0` is what has passed elsewhere in this repo.

Report per-item: what the defect actually was, what the selection is now, the RED and GREEN evidence with file names, and every selected-file count before and after. Say plainly if any direction of the alias bridge cannot be made to work, rather than approximating it. Close with `Risk: item N (reason)` or `Risk: none` -- this changes a test-selection path, so consider item 5 and item 6 honestly. Do not push.

### L2 — measured baseline before any change
Measured on branch fix/affected-tests-two-dimensions at HEAD 1ca9dc0, tree clean, vitest 3.2.7, node v22.23.2.

Wiring, reconciled: `package.json:32` "test:affected": "node scripts/run-affected-tests.ts". BOTH files are real and both are needed: `run-affected-tests.ts` is the entry point and `scripts/test-affected.ts` is the scope resolver it imports at `run-affected-tests.ts:31`. The reports naming `scripts/test-affected.ts` as the entry were imprecise.

Collected test files: `vitest list --filesOnly` returns 802 files. 712 under `test/`, 86 under `packages/llmwiki-kg/ts/src/`, 3 under `src/dimensions/kg/`, 1 at `scripts/output-contracts.test.ts`. `vitest.config.ts` has NO `include` key, so `configDefaults.include` applies and matches kg tests; `exclude` adds `.claude/**`, `.worktrees/**`, `test/sdk/packaging.test.ts`.

The claim that kg tests are invisible to the selector is FALSE for the `files` path. Measured `vitest related --run --reporter=json` selections:
- changed `packages/llmwiki-kg/ts/src/core/ontology.ts` -> 490 files selected: 402 under `test/**` (including `test/dimensions/activation.test.ts`, `test/dimensions/kg-core-ontology-flow.test.ts`, `test/dimensions/kg-core-ontology-read.test.ts`) and 88 under `packages/**` (including `packages/llmwiki-kg/ts/src/core/ontology.test.ts`, `ontology-hierarchy.test.ts`, `ontology-domain-range.test.ts`, `stack_ontology.test.ts`, plus routes tests).
- changed `src/dimensions/activation.ts` -> 361 files selected, 0 under `packages/**`.
- changed `src/utils/lock-postgres.ts` -> 194 files selected, 0 under `packages/**`.
All three selections are strict subsets of the 802 collected files, and the config-excluded `test/sdk/packaging.test.ts` is absent from all three, which proves `related` respects the config `include`/`exclude`.

The real blind spot is the escalation and partition path:
- `scripts/test-partition.ts:30` `export const TEST_DIR = "test"`, used by `collectTestFiles` (`:61-76`, `walk(path.join(root, dir))` at `:74`) and `classifyTests`.
- `node scripts/test-partition.ts unit | wc -l` -> 631 files, and `grep -c '^packages/'` -> 0.
- `scripts/run-affected-tests.ts:95` `const unitFiles = partition(classifyTests(root, TEST_DIR)).unit;` is the global/escalation tier. So escalation runs 631 files and silently omits 86 kg tests plus 3 `src/dimensions/kg` tests plus `scripts/output-contracts.test.ts`.
- Escalation constants, `scripts/test-affected.ts:31-40`: GLOBAL_SCOPE_PATHS = ["package.json", "package-lock.json", "vitest.config.ts", "tsconfig.json", "tsconfig.test.json"]; GLOBAL_SCOPE_DIRS = ["scripts"].

Direction "root source change selects kg tests" has no import edge to miss: all 86 kg test files were walked and every relative specifier resolved -- 86 checked, 0 escaping above `packages/llmwiki-kg`, zero `(../){3,}` specifiers, zero bare `llm-wiki-compiler`/`@atomicstrata` specifiers, and the kg `tsconfig.json` declares no `paths`. Zero selection in that direction is correct.

Existing selector tests: `test/test-affected-scope.test.ts` covers `resolveAffectedScope`, `isGlobalScope` and `selectableFiles`; `scripts/output-contracts.test.ts` covers `planAffectedInvocations`. Nothing covers the test-file enumeration in `test-partition.ts`, and nothing covers the `vitest related` selection. That is how half the repo went unnoticed.

Environment note: this worktree had no usable `node_modules`, so a bare `npx vitest` fetched 5.1.0 from the network instead of the pinned `^3.2.7`. Task T1 fixes that before any gate is trusted.

### L3 — Manager rulings during implementation
Recorded as the rulings this branch was executed under, kept factual and compact.

1. **The invariant is BIDIRECTIONAL.** `collected ⊆ unit ∪ integration` AND `(unit ∪ integration) − collected` equals exactly `["test/sdk/packaging.test.ts"]`, named explicitly; the test must fail and name any file that joins the difference. Acceptance: 804 collected, 805 walked, difference exactly that one file.
2. **`test/sdk/packaging.test.ts` stays as it is**: config-excluded from `vitest run`, executed by `test:pack` (`package.json`), and correctly still enumerated by the partition.
3. **The Docker/Postgres cost of the widened tier must be documented where developers hit it**, and the loud-failure message must name `LLMWIKI_TEST_ALLOW_NO_DATABASE=1`.
4. **The 155-second `vitest related` alias crawl is CANCELLED**: it cannot catch a regression the cheap alias pin misses. The alias pin asserts the `llmwiki-kg` mapping in `vitest.config.ts` resolves to `packages/llmwiki-kg/ts/src/core-index.ts` and that target exists.
5. **Editing exactly one existing test file was authorized with veto explicitly denied**, understood as "do not weaken any assertion" rather than "freeze test bytes", because `test/test-partition.test.ts:88-93` asserted that no file outside `test/` may be classified — the blind spot written down as correct behaviour.
6. **Three conditions on that edit**: (1) no optional `dir` parameter defaulting to `test/` may survive in any exported enumeration API; (2) the commit message must quote what the old assertion claimed and what replaced it; (3) the before/after is recorded in this document — which is L4.
7. **Scope clarifications**: `CONTRIBUTING.md` edits are authorized (S4 covered test files, not docs); the `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` message string is the one narrow `test/setup/**` exception; CI is report-only and was not touched.

### L4 — the replaced assertions (`test/test-partition.test.ts`, ruling condition 3)
`git show bf12016 -- test/test-partition.test.ts` changes two assertions in one file; the other 13 tests in it are untouched.

**Old assertion 1** — a count equality against a single-directory walk:
```ts
const onDisk = readdirSync(path.join(ROOT, "test"), { recursive: true })
  .filter((entry) => typeof entry === "string" && entry.endsWith(".test.ts"));
expect(classified.length).toBe(onDisk.length);
```
It claimed "the classifier returns as many files as `test/` holds". A file outside `test/` was therefore either a failure or, more often, never counted at all, and a tree added later could not be noticed.

**Old assertion 2** — a shape check:
```ts
expect(entry.file).toMatch(/^test\/.*\.test\.ts$/);
```
In words: **no test file outside `test/` may ever be classified**. That is the blind spot written down as correct behaviour, not as coverage.

**New assertion 1** — exact set equality against an independent four-root walk, asserted in both directions, with the differing paths in the failure message:
```ts
const suiteRoots = ["test", "packages", "src", "scripts"];
const skipped = new Set(["node_modules", "dist", ".worktrees", ".claude", ".git", ".llmwiki"]);
...
const unclassified = onDisk.filter((file) => !classifiedByPath.has(file));
const fabricated = [...classifiedByPath].filter((file) => !onDisk.includes(file));
expect(unclassified, `on disk but not classified: ${unclassified.join(", ")}`).toEqual([]);
expect(fabricated, `classified but not on disk: ${fabricated.join(", ")}`).toEqual([]);
expect(classified.length, "classified files vs files on disk").toBe(onDisk.length);
```

**New assertion 2** — an anchored root alternation, keeping the existing absolute-path check:
```ts
expect(entry.file).toMatch(/^(test|packages|src|scripts)\/.*\.test\.ts$/);
expect(entry.file.startsWith("/")).toBe(false);
```

**Why the replacement is strictly stronger.** (a) The oracle walks the four roots itself, with its own copy of the root list and skip list, so it cannot inherit the constant it checks and a tree added later fails here by name instead of being silently agreed with. (b) Both directions are asserted, so a fabricated path fails as loudly as a missing one, and the message names the paths. (c) The shape check is anchored to the four declared roots rather than to `test/` alone, so a path outside them is either fabricated or from a root nobody declared.

**Measured before/after** (`node scripts/test-partition.ts unit|integration | wc -l`, vitest 3.2.7, node v22.23.2):

| tree state | unit | integration | total | under `packages/` |
| --- | --- | --- | --- | --- |
| before the fix (1ca9dc0) | 631 | 82 | 713 | 0 |
| after the fix (bf12016) | 722 = 632 `test/` + 86 `packages/` + 3 `src/` + 1 `scripts/` | 83 | 805 | 86 |
| at HEAD 18da507 (re-measured for this record) | 723 = 633 `test/` + 86 `packages/` + 3 `src/` + 1 `scripts/` | 83 | 806 | 86 |

At bf12016, 805 is every `*.test.ts` on disk; `vitest list --filesOnly` collects 804, and the difference is exactly `test/sdk/packaging.test.ts`. The bottom row is the same measurement one commit later, and it is the invariant still holding rather than a second claim: `test/affected-escalation-wiring.test.ts` (added by 18da507) is the single added file, the difference is still exactly `test/sdk/packaging.test.ts`, and 86 `packages/` files are in the unit tier in both rows.

### L5 — docs slice: audit result, `CONTRIBUTING.md`, gates
**Loud-failure audit (report-only).** The unavailable-database message is produced in two places, one per compilation boundary, and BOTH already name the escape hatch by name:

- `test/fixtures/test-database-handoff.ts:257-265` — `noDatabaseMessage()`, the root chokepoint used by `test/fixtures/kg-postgres.ts` and `test/fixtures/rls-probe.ts` via `missingTestDatabase`. Its last line is `` `  - set ${DATABASE_OPT_OUT_ENV_VAR}=1 to accept the old skip behavior for this run.` ``, and `DATABASE_OPT_OUT_ENV_VAR` is `"LLMWIKI_TEST_ALLOW_NO_DATABASE"` (`test/fixtures/test-database-handoff.ts:86`).
- `packages/llmwiki-kg/ts/src/testing/no-database.ts:81` — the in-package twin, same wording, same result.

So ruling 3's message requirement was already satisfied, and **nothing under `test/setup/**` was touched**. `test/setup/test-database-url.ts` is not the failure path at all: it publishes the run's URL into every worker and deliberately never throws (its own header says the loud message belongs to the chokepoint).

**`CONTRIBUTING.md`.** Two true-after-bf12016 additions, nothing else: the `test:unit` line no longer describes one directory, and one paragraph after the command block states that the tier covers `test/`, `packages/`, `src/` and `scripts/` minus the files that spawn a CLI subprocess, that the `packages/llmwiki-kg` suites make Docker or `LLMWIKI_TEST_DATABASE_URL` a prerequisite, and that `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` skips the database-backed suites so the run verifies nothing about them. The `~5 min` durations were left alone: the measured widened-tier runs on this branch were 242.41 s and 189.27 s (vitest 3.2.7), which does not falsify a conservative `~5 min` upper bound.
