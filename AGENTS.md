# llmwiki

A knowledge compiler. Raw sources in, interlinked wiki out, reached through the MCP server or the container image — not a CLI.

## Development Guidelines

### Code Style & Standards

- Code files (TypeScript, Python, JavaScript, shell, SQL) must be smaller than 400 lines excluding comments. Once 400 is exceeded, initiate a refactor. **Markdown and other prose/config files (`.md`, `.mdx`, `.yaml`, `.json`, `.toml`) are exempt** — long planning documents, roadmaps, and reference catalogs are allowed to grow as substance requires. Enforced by `pnpm run lint`, which runs in CI.
- Functions must be smaller than 40 lines excluding comments and the catch/finally blocks of try/catch sections. If a function exceeds that, refactor it. Enforced by the same `pnpm run lint` rule.
- test files must be smaller than 400 lines excluding comments. Once 400 is exceeded, split the tests into multiple files. Same 400-line limit, enforced by `pnpm run lint`.
- tests must be smaller than 40 lines excluding comments and the catch/finally blocks of try/catch sections. If a test exceeds that, refactor it, or separate it into multiple tests. Same 40-line limit, enforced by `pnpm run lint`.
- Use TypeScript with proper types — avoid `any`. Enforced by `pnpm run lint` in CI; today's occurrences are frozen in `eslint-baseline.json` and only new ones fail.


### clean code rules

- Meaningful Names: Name variables and functions to reveal their purpose, not just their value.
- One Function, One Responsibility: Functions should do one thing.
- Avoid Magic Numbers: Replace hard-code values with named constants to give them meaning.
- Use Descriptive Booleans: Boolean names should state a condition, not just its value.
- Keep Code DRY: Duplicate code means duplicate bugs. Try and reuse logic where it makes sense.
- Avoid Deep Nesting: Flatten your code flow to improve clarity and reduce cognitive load.
- Comment Why, Not What: Explain the intention behind your code, not the obvious mechanics.
- Limit Function Arguments: Too many parameters confuse. Group related data into objects.
- Code Should Be Self-Explanatory: Well-written code needs fewer comments because it reads like a story.

### Comments and Documentation

- include a substantial JSDoc comment at the top of each file. For python files, use google style docstrings
- Write clear comments for complex logic
- Document public APIs and functions
- Use JSDoc comments for functions
- Keep comments up-to-date with code changes
- Document any non-obvious behavior

### Installing the workspace

The checkout is a pnpm workspace, so install it with pnpm and a frozen lockfile:

```bash
corepack pnpm install --frozen-lockfile
```

**Bare `pnpm` may be unavailable**: on the reference host the global shim's `exec`
target was deleted, so `command -v pnpm` succeeds while `pnpm --version` exits `127`.
`corepack pnpm` reaches the launcher without that dependency, which is why the
install is written that way — the bare `pnpm` forms elsewhere in this file are the
same invocation wherever `pnpm` works. The lockfile is authoritative:
`--frozen-lockfile` refuses rather than resolving a graph nobody tested.

**The suite verifies the install before it runs anything.** `test/global-setup.ts`
refuses at session start, printing that command, when `node_modules` is not a pnpm
tree — it carries `node_modules/.package-lock.json`, or has no
`node_modules/.pnpm` — or when a `@repo/api`, `@repo/foundation`, `@repo/kg` or
`@repo/wiki` link is missing. Without that check the run dies later with
`Cannot find package '@repo/kg/testing/per-run-database'`, an error that names an
internal export and hides the cause. **Do not delete `node_modules` to fix it**: the
install above is the whole fix, because the lockfile is what the tree must match.

### Test Execution Policy

The full suite takes ~9 minutes and belongs to CI. For its current size run
`git ls-files '*.test.ts' | wc -l` — a baked count goes stale the moment someone
adds a test, so this file does not carry one. Run the tests your change can
actually affect; do not wait for the whole suite while iterating.

1. **Iterating on code** — run the tests related to what you touched:
   `pnpm exec vitest related <changed-file>`. This selects only files that import it.
2. **Before considering a task complete** — run `pnpm run test:affected`. It diffs
   against the merge-base and runs `vitest related` over your changes. It is
   local-iteration tooling, not a gate anything else runs: CI does not run it and
   neither does the push hook. When the change has suite-wide reach
   (`package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `tsconfig*.json`, or
   anything under `scripts/`), narrowing there would be a false negative, so it
   resolves the scope to the full unit tier and then declines to run it — that
   tier is a subset of `pnpm test`, and running it here pays for the same files
   twice. It prints
   `` affected: scope resolves to the full unit tier; run `pnpm test` instead ``
   on stderr and exits `78`, so run `pnpm test` yourself in that case. It exits
   `69` when the change set cannot be computed at all (no `origin/main` or
   `upstream/main`, or a failed merge-base); exit `0` is reserved for a
   computation that succeeded and found nothing relevant.
3. **`pnpm test`** — the exhaustive run. Required only when your change is
   cross-cutting, when you suspect a coupling the related-selection cannot see,
   or before opening a pull request. CI runs it on every push and pull request,
   and that is the gate of record.

Never claim a task complete on the strength of a partial run without saying which
scope you ran. Report the scope and the result together.

**`pnpm run test:integration`** is the remaining tier: `scripts/test-partition.ts`
classifies a test as integration when it spawns a child process — `runCLI(`,
`spawnSync(`, `spawn(`, `execFileSync(`, `execFile(`, `execSync(`, `npm pack`,
`fixtures/run-cli-server`, `fixtures/mcp-test-env` — so it covers spawned process
behaviour end to end rather than behaviour reached in process. `test:unit` takes
everything that does not spawn, and `pnpm test` is plain `vitest run`, which
collects both tiers.
`test/sdk/packaging.test.ts` spawns too but `vitest.config.ts` excludes it from
that collection; it runs only via `pnpm run test:pack`.

**Workers are capped by measured memory, not by core count.** `vitest.config.ts`
pins `maxWorkers: 4`, and `pnpm run test:integration` lowers it further with
`--maxWorkers=2`, because those files spawn `node dist/api.js` children — the
launcher the build produces is the only executable in `dist/` — whose cost is per
child process rather than per file, and spawning is exactly what
`scripts/test-partition.ts` classifies as `integration`. Three full-suite runs on
the reference host — one per configuration, sequential and alone, peak RSS of the
whole run's process tree from its cgroup counter — measured 2 workers 809 s /
2808 MB / no swap out, 4 workers 496 s / 3816 MB / ~1 MB, and 6 workers 403 s /
5119 MB / ~400 MB with worst MemAvailable down to 2576 MB. Six workers buys 93 s
and costs the host, which is how concurrent verification runs start killing each
other. The cap is sized from the worst case `pnpm test` can actually meet — the
integration tier's per-worker peak, since that run covers both tiers unfiltered —
so **the unit tier deliberately runs below its own optimum; do not raise this
number without the integration tier's peak in hand.**

Tests must not depend on timing or external services.

**`test:unit` is not the `test/` directory.** It covers every test tree in the
repository — `test/`, `packages/`, `src/` and `scripts/` — minus the files that
spawn a child process, so the `packages/llmwiki-kg` suites are part of it, along
with the `src/dimensions/kg/` suites and `scripts/output-contracts.test.ts`.
Those `llmwiki-kg` suites are database-backed, so without Docker or
`LLMWIKI_TEST_DATABASE_URL` they fail — they do not skip. `LLMWIKI_TEST_ALLOW_NO_DATABASE=1`
is the only escape hatch, and it downgrades those hard database failures to
skips that still report their reason, so a run that sets it verifies nothing
about them. It exists for local debugging: **CI must never set
`LLMWIKI_TEST_ALLOW_NO_DATABASE=1`**, because a green run there would then
prove nothing about the database-backed suites.

**The build in `test/global-setup.ts` is cached.** A content hash of the `src/`,
`packages/` and `scripts/` trees plus `tsup.config.ts`, `tsconfig.json` and
`package.json` is recorded in `.llmwiki/build-stamp.json`, so when nothing feeds
that hash a run skips the ~42 s tsup rebuild and a single-file run drops from
~48 s to under a second. To force the rebuild anyway — after a suspicious
`dist/`, for example — set `LLMWIKI_TEST_FORCE_BUILD=1`.

### Iterating per package, and why the full suite is still the gate

`turbo run test --filter=@repo/wiki` runs one package's tests and nothing else. The
selection census measured on this workspace puts `@repo/wiki` at **565** of the
**827** collected test files — 68.3% by arithmetic on those two counts — with
`@repo/foundation` at 405, `@repo/kg` at 549 and `@repo/api` at 13. That is the
iteration loop to prefer over the full run.

`test`, `lint`, `typecheck` and `fallow` all select the same way, and each routes to
the **real** root gate rather than to a weaker sibling: `@repo/kg#typecheck` spawns
`scripts/kg-typecheck.ts` itself rather than re-declaring its rules, and `lint` runs
the same ratchet scoped to the package's file set. A filtered run executes **exactly**
the filtered package's tasks — no task declares a `^test` edge, so
`--filter=@repo/wiki` starts no `@repo/foundation` task. The single pgvector database
is protected by `"concurrency": "1"` in `turbo.json`, a concurrency constraint of one
task at a time rather than a dependency edge.

**The gate of record is still the full suite, in CI and before a PR**:
`turbo run test --filter=//`. A selective run is a local iteration affordance and
never a gate: a gate that runs a different set depending on which files you happened
to touch stops being a record of anything.

Four properties of that selection are worth knowing before you trust it:

- **It models static import specifiers only.** `require(`, computed `import(` and
  `new URL(` are invisible to it, and four type-only dependents are deliberately
  outside the `@repo/wiki` set: `test/provenance-metadata-shape.test.ts`,
  `test/query-candidate-id-absent.test.ts`, `test/viewer-sidebar.test.ts` and
  `test/sdk/published-dimensions-port.test.ts`. A **type** change to wiki is caught by
  the root `typecheck:tests`, not by the selective run, and a green selective run
  says nothing about it. The run prints a notice naming them; do not silence it.
- **Bare `pnpm` must be on `PATH`.** Turbo spawns the package manager itself, and
  `corepack pnpm` does not reach that spawn. On the reference host bare `pnpm` exits
  `127`, so a shim is needed — a host defect, not part of this repository.
- **`cache: false` stays on every verdict task.** Turbo is used here for selection
  and ordering, not for speed: a cache hit is a green that did not run.
- **`//` is the root project**, and a root script joins a task run only through a
  declared `//#<task>` entry. That is why the distribution's build is `//#build`, and
  why `turbo run build --filter=@repo/kg` runs `@repo/kg#build` alone — exit `0`, one
  task — and leaves `dist/` to `//#build`: filtering to a package never builds the
  distribution for you.

The design, the rejected candidates and the named gaps belong to `docs/turborepo.md`;
this section is only the operating instructions.

### Pre-Commit Checks

Before committing any work, and before considering any task complete, you must:

1. `pnpm exec tsc --noEmit` — type-check passes
2. `pnpm run typecheck:tests` — the test type-check ratchet passes (no new test type errors)
3. `pnpm run build` — build succeeds
4. `pnpm run test:affected` — tests for what you changed pass. It is local-only, and
   it declines with exit `78` when the change has suite-wide reach: run `pnpm test`
   yourself then, and likewise when the change is cross-cutting or before opening a
   PR (see Test Execution Policy)
5. `pnpm run fallow:ci` — the fallow codebase health analyzer with `--gate new-only`, and the command that actually gates. Fix all issues it reports (dead code, duplication, complexity). Use `fallow fix --dry-run` to preview auto-fixes, then `fallow fix --yes` to apply. Fix any remaining issues manually. Do not commit while it fails. `pnpm exec fallow` is the raw full-tree report and exits non-zero on inherited debt; it is not the gate.
6. `pnpm run lint` — the house-rule ratchet: 400-line files, 40-line functions, no
   `any`, and the `src/` <-> `packages/llmwiki-kg` import boundary. It passes on a
   frozen baseline and fails only on newly introduced violations. `pnpm run lint:update`
   rebaselines; using it to absorb a new violation defeats the gate.

   The boundary half of that gate is two rules reading one set of patterns.
   `no-restricted-imports` reports static `import`/`export` declarations; the local
   `local/dimension-boundary` rule (`scripts/eslint-rules/dimension-boundary.mjs`)
   reports the forms it cannot see — a dynamic `import()`, a type-level
   `typeof import()`, and a `vi.mock`/`vi.doMock`/`vi.importActual`/`vi.importMock`
   factory whose first argument names a module. A specifier that is not a string
   literal (a template with substitutions, an identifier, a concatenation) is
   reported as its own category instead of being ignored, and it is deliberately
   not resolved: the gate states that it cannot verify it rather than guessing.
   What is forbidden has not changed — `wiki → kg` and `kg → wiki` are both
   forbidden, exactly as before. `corepack pnpm run lint` regenerates the counts:
   the triple it prints — violations, files, rule/file entries — is the
   authoritative figure, and `npm run lint` (equivalently `pnpm run lint`) fails
   only on newly introduced violations; this file does not carry the numbers,
   since a baked count goes stale the moment someone adds a rule or a file. Of
   the violations the gate counts today, 80
   static sites (67 files), 30 literal dynamic-or-mocked sites (11 files) and 6
   non-literal sites (1 file) are boundary reaches, all `wiki → kg`, with
   `kg → wiki` at 0.

Never bypass these gates with `--no-verify`; fix the underlying issue instead.

The statically independent gates are cheaper together: `pnpm run gates:static` runs
`tsc`, `typecheck:tests`, `typecheck:kg`, `lint`, `fallow:ci` and `fallow:kg` two at a
time, buffers each gate's output and prints it as its own labelled block, and exits
non-zero if any gate failed. Measured on the reference host, those six gates took 35.6 s
serially (`tsc` 5.1 s, `typecheck:tests` 12.5 s, `typecheck:kg` 5.2 s, `lint` 10.2 s,
`fallow:ci` 2.1 s, `fallow:kg` 0.5 s) and ~26.7 s behind the command, peaking at ~2.2 GB
with no swap added. `pnpm run build` is deliberately NOT in that set and must not be
added: every gate there is read-only over the checkout, while `build` writes `dist/`, so
it stays ordered before anything that spawns `dist/`. The push hook runs that root script
directly; **in CI the ordering is implemented by `turbo run build`**, which runs the same
root `pnpm run build` script as its `//#build` task. Grep CI for `pnpm run build` and you
will not find the literal — the graph is the caller now, not because the rule was dropped.

### Branch protection

**`main` is not protected.** Measured against the live repository,
`GET /repos/urgosxd/llm-wiki-compiler/branches/main` returns `"protected": false`
with `"protection": {"enabled": false, "required_status_checks":
{"enforcement_level": "off", "contexts": []}}`. Nothing at the GitHub level refuses
a merge. The checks described below exist and run on every push and pull request,
but they are **advisory**: a red one does not stop a merge, and reading them before
merging is a human responsibility rather than an enforced gate. Branch protection is
a **missing control**, not an existing one — and if it is ever turned on, these are
the check names it must require.

The three are `build-and-test (24)`, `codebase-health` and `test-typecheck`. Two
mechanical facts make the first of them easy to break by accident:

- **`build-and-test (24)` is not written anywhere in the workflows.** The job key is
  `build-and-test` with no job-level `name:`, so GitHub renders the key plus the
  matrix value from `node-version: [24]`. An explicit job-level `name:` replaces that
  rendering outright, and a second matrix value renames the check into a `(22)`/`(24)`
  pair. Either way a required-check entry written against `build-and-test (24)` stops
  matching.
- `codebase-health` and `test-typecheck` are each a job of their own.

The lint ratchet runs as a **step inside `build-and-test`**, not as its own job: a
step inherits that job's check name, while a new job name has no branch-protection
entry and its red result could be merged past. Renaming or splitting the lint step
into a separate job would therefore silently un-gate it. That reasoning holds whether
protection is enabled today or turned on later.

## General Rules

- First think through the problem, read the codebase for relevant files.
- Name branches `feature/<name>` for new features and `fix/<name>` for bug fixes.
- Make every task and code change you do as simple as possible. We want to avoid making any massive or complex changes. Every change should impact as little code as possible. Everything is about simplicity.
- Never speculate about code you have not opened. If the user references a specific file, you MUST read the file before answering. Make sure to investigate and read relevant files BEFORE answering questions about the codebase. Never make any claims about code before investigating unless you are certain of the correct answer - give grounded and hallucination-free answers.

<pi-intercom>
Coordinate with other local pi sessions on related codebases. Use `/skill:pi-intercom`
for transport mechanics and `/skill:multi-agent-coordination` for the protocol.

**When:** same codebase in parallel worktrees, a reference codebase you are consulting,
related repos sharing a library.

**Not when:** unrelated codebases, a question you can answer yourself, or any time you
can proceed independently.

**Transport:** prefer `send` for anything nobody must answer. `ask` only when you are
blocked and the answer changes what you do next — it blocks you for up to ten minutes.

## Always answer threaded

pi-intercom knows only two things about a reply: `expectsReply` on the way out, and
`replyTo` threading it back. Our words — `work_result`, `done`, `blocked` — are plain
text to it.

That matters because intercom releases the asker's waiter only when a `replyTo` comes
back. A `work_result` sent as a bare `send` leaves the sender of the request still
"waiting for a reply from this session" until the ten-minute timeout, and that leftover
edge is what later refuses your next ask as `E_MUTUAL_ASK`.

So:

- Answer with `action: "reply"` and the `replyTo` from the incoming reply hint. The hint
  carries the exact call; do not rebuild it.
- If you must use `send`, pass `replyTo` explicitly.
- The hook warns `unthreaded-response` when a terminal type leaves without threading.
  Treat that warning as a defect in the message, not as noise.

Other transport machinery worth using deliberately:

- `cancel` an ask you no longer need, instead of leaving a peer blocked for ten minutes.
- `supersedes` to correct a message rather than repeat it.
- `pending` before replying when more than one ask is open — a bare `reply` needs exactly
  one.

`ask` opens a waiter and intercom refuses a mutual pair as `E_MUTUAL_ASK`. That refusal
is the deadlock being broken, and it applies to `ask` only — alternating `ask` and `send`
evades it while still looping, which is why the exchange budget exists as well.

## Stopping rule

A coordination turn ends at the first of these. When one applies you stop SENDING; it
does not mean you stop working.

- You received `done`, `audit_report`, or a verifying `work_result`. They are terminal.
- You sent one of those. Your scope is closed; do not report it again.
- You sent one `blocked` for an `id`. The human decides next, not you.
- Your `expect` is satisfied. `expect: none` means nothing follows it.
- You are waiting for an answer. Waiting is not a turn: do not send a progress note, a
  reminder, or a re-send.

The hook counts non-terminal messages per peer and refuses the sixth with
`exchange-too-long`. A task that reaches `done`, `audit_report`, or `work_result` resets
that count to zero, so finishing work is never throttled. The count is per peer, so
talking to three roles is three conversations. A conversation that never reaches a
terminal type is not making progress, whatever its topic — and git is the usual topic.

## Git is decided by the owner, never by message

Your worktree, branch, index, and commits are your scope. The coordination contract
already declares them, so no peer's answer could change them. A git question is the
classic loop generator: it asks someone else to decide what you already own.

- Inside your own checkout — dirty tree, wrong branch, rebase, stash, whether and when
  to commit — you run the command and report the result. You never ask.
- Crossing checkouts — a merge between branches, primary-branch history, a missing
  worktree — the integration owner decides and tells you what to run.
- The contract itself being wrong or unusable — one `blocked` to the human, then stop.

Never resolve a git disagreement by message. It is settled by reading the repository
(`git log`, `git merge-base`, `git worktree list`), not by more turns.

## Commits are evidence, not a topic

Commit in your own checkout when the work needs it, then report it ONCE in the
`evidence` field of `work_result` or `done`. That report is the entire conversation
about the commit.

Never ask permission to commit, never ask which branch, never ask whether to commit,
and never announce that you committed. Every one of those costs a turn and proves
nothing.

`evidence` is verified against git: if the commit does not exist, or does not touch the
paths you listed in `files_changed`, the report is refused. A verifying report is the
proof, so citing the commit is the only form that carries information.

This does not weaken the Pre-Commit Checks above. `tsc`, `build`, `test:affected`,
`fallow:ci` and `lint` still gate a completed task — `test:affected` locally only, and
`pnpm run gates:static` runs the statically independent ones of them concurrently (see
Pre-Commit Checks). They are yours to run in your own checkout; none of them requires a
peer's agreement, and none of them is a message.
</pi-intercom>
