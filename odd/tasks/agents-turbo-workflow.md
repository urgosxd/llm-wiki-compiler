# AGENTS.md: per-package Turborepo workflow, and the branch-protection correction

Branch `docs/agents-turbo-workflow`, base `main` = `7bf0f26f99bfec9cf0c2f0a562354f515a37037e`. Prose-only:
two sections of `AGENTS.md` are replaced, no executable delta exists, so there is no RED/GREEN pair to
observe and none is claimed (T4).

## Specs

**S1 — the false claim is corrected, and its consequence stated.** `AGENTS.md` said `test-typecheck` is
required by `main`'s branch protection. Measured against the live repository that is false: the branch
report carries `"protected": false` and `"protection": {"enabled": false, "required_status_checks":
{"enforcement_level": "off", "contexts": []}}`. The section must state that `main` is not protected,
that the checks still exist and run but are **advisory** (a red one does not stop a merge; reading
them is a human responsibility, not an enforced gate), and that branch protection is a **missing
control**, not an existing one.

**S2 — the section keeps its original purpose: which job carries which check.** The three names are
`build-and-test (24)`, `codebase-health` and `test-typecheck`. Two mechanical facts are preserved
because they are what stops an accidental un-gating: `build-and-test (24)` appears in no workflow
literal (the job key is `build-and-test` with no job-level `name:`, so GitHub renders the key plus the
matrix value from `node-version: [24]`; an explicit `name:` replaces that rendering and a second matrix
value renames it into a `(22)`/`(24)` pair), and the lint ratchet must stay a **step inside
`build-and-test`**, since a step inherits that job's check name while a new job name has no entry and
could be merged past.

**S3 — per-package iteration, with the census numbers.** `turbo run test --filter=@repo/wiki` is the
iteration loop to prefer. The census puts `@repo/wiki` at **565** of **827** collected test files —
68.3% by arithmetic on those two counts — with `@repo/foundation` at 405, `@repo/kg` at 549 and
`@repo/api` at 13. Source: `docs/turborepo.md:257-258`, quoted below in the Log.

**S4 — the other tools select the same way, and route to the real gate.** `test`, `lint`, `typecheck`
and `fallow` all select the same way, and each routes to the **real** root gate rather than a weaker
sibling: `@repo/kg#typecheck` spawns `scripts/kg-typecheck.ts` itself rather than re-declaring its
rules, and `lint` runs the same ratchet scoped to the package's file set. A filtered run executes
**exactly** the filtered package's tasks — no task declares a `^test` edge — and the single pgvector
database is protected by `"concurrency": "1"`, a concurrency constraint rather than a dependency edge.

**S5 — the gate of record, and the declared boundary of the selection.** The gate of record is the full
suite, in CI and before a PR: `turbo run test --filter=//`. A selective run is a local iteration
affordance and never a gate, because a gate that runs a different set depending on which files you
touched stops being a record of anything. The selection models **static import specifiers only**:
`require(`, computed `import(` and `new URL(` are invisible to it, and four type-only dependents are
deliberately outside the `@repo/wiki` set — `test/provenance-metadata-shape.test.ts`,
`test/query-candidate-id-absent.test.ts`, `test/viewer-sidebar.test.ts` and
`test/sdk/published-dimensions-port.test.ts`. A **type** change to wiki is caught by the root
`typecheck:tests`, not by the selective run; the run prints a notice naming them and the notice must
not be silenced. Bare `pnpm` must be on `PATH` because turbo spawns the package manager itself and
`corepack pnpm` does not reach that spawn (host defect on the reference host, where bare `pnpm` exits
`127`). `cache: false` stays on every verdict task: turbo is used here for selection and ordering, not
speed, and a cache hit is a green that did not run.

**S6 — constraints on the write.** No caching enabled, `turbo.json` untouched, no
`.github/workflows/*` changed, no `workflow_dispatch` added, `docs/turborepo.md` untouched. `~9 minutes`
in `### Test Execution Policy` is left alone; no other section of `AGENTS.md` is edited, and the
`## General Rules` and `pi-intercom` content is untouched. Allowed edit surfaces: `AGENTS.md` and this
document only.

## Tasks

- **T1** — S1, S2: create this feature document before any `AGENTS.md` edit. Route: inline. Commit: this commit.
- **T2** — S1, S2: replace `### Branch protection` (`AGENTS.md:211-222`). Route: inline. Commit: this commit.
- **T3** — S3, S4, S5: replace `### Per-Package Task Surfaces` (`AGENTS.md:139-157`) with
  `### Iterating per package, and why the full suite is still the gate`. Route: inline. Commit: this commit.
- **T4** — S6: the three static gates and the report; no RED/GREEN because the change is prose with no
  executable delta. Route: inline. Commit: this commit.

## Log

**L1 — the originating request, verbatim:** "Codify the Turborepo workflow in `AGENTS.md` so a future
agent knows how to iterate per package — and fix one false claim in that file that is currently
misleading every agent who reads it."

**L2 — the delegated task's framing, verbatim:** "ORDERING: feature document first, before any AGENTS.md
edit". Two behavioural claims were to be confirmed in source before being left in, and on failure the
bullet dropped and reported rather than rewritten. `docs/turborepo.md` was to be checked for its census
line, with a mismatch a stop condition rather than an edit.

**L3 — fact check, all confirmed at `7bf0f26f`.** `packages/llmwiki-kg/package.json` does not exist; the
kg package is `packages/llmwiki-kg/ts/package.json`, whose `typecheck` script is
`"typecheck": "node ../../../scripts/package-tasks.ts typecheck --package @repo/kg"`. The claim holds
transitively and one hop deeper than the task expected: `scripts/package-tasks-runners.ts:304` is
`const ratchet = path.join(context.root, "scripts", "kg-typecheck.ts");`, so `@repo/kg#typecheck` does
spawn `scripts/kg-typecheck.ts` rather than re-declaring its rules. Every `lint` script is the same
form (`"lint": "node ../../scripts/package-tasks.ts lint --package @repo/<pkg>"`), and that runner reuses
the whole-repo ratchet's own `collectSnapshot` from `./lint-ratchet.ts`
(`scripts/package-tasks-runners.ts:238`), scoped by filtering the measurement — the same ratchet, never a
weaker config. Census confirmed verbatim at `docs/turborepo.md:257-258`:
``selection buckets: @repo/foundation=405 @repo/wiki=565 @repo/kg=549 @repo/api=13 meta=70
orphan=29 uncovered=0 collected=827 distinct=827 multiPackage=409`` — the four numbers match the task
brief, so no stop condition fired.

**L4 — one further claim in the mandated wording was refuted and is NOT reproduced as given.** S5's
bullet said `turbo run build --filter=@repo/kg` **hard-errors**. That was true only while no `build` task
was declared, and `docs/turborepo.md` already marks that measurement SUPERSEDED ("a `build` task exists
now, and this decline no longer stands"). Measured here at `7bf0f26f`:
`corepack pnpm turbo run build --filter=@repo/kg --dry=json` exits **0** and resolves exactly one task,
`@repo/kg#build`. The false clause was not written. The structural half of the bullet is kept and stated
as measured: `//` is the root project, a root script joins a task run only through a declared
`//#<task>` entry, and filtering to a package never builds the root `tsup` distribution.

**L5 — the live-repository branch-protection JSON in S1 is parent-supplied evidence**, not something this
task could re-measure: no GitHub API call was authorized from this worker. The three workflow facts in
S2 were re-verified by reading, not editing, the workflows — `build-and-test` (`ci.yml:24`, no job-level
`name:`, matrix `node-version: [24]` at `ci.yml:28`), `codebase-health` (`ci.yml:182`), `test-typecheck`
(`typecheck-tests.yml:12`, no matrix), and `pnpm run lint` as a **step** inside `build-and-test`
(`ci.yml:81`).

**L6 — no RED/GREEN, deliberately.** This change is prose with no executable delta: no test can fail
before it and pass after it. What was run instead is the three static gates, unchanged by a markdown
edit, and `npm test` was deliberately not run by the requester's decision.
