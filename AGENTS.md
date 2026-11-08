# llmwiki

A knowledge compiler CLI. Raw sources in, interlinked wiki out.

## Development Guidelines

### Code Style & Standards

- Code files (TypeScript, Python, JavaScript, shell, SQL) must be smaller than 400 lines excluding comments. Once 400 is exceeded, initiate a refactor. **Markdown and other prose/config files (`.md`, `.mdx`, `.yaml`, `.json`, `.toml`) are exempt** — long planning documents, roadmaps, and reference catalogs are allowed to grow as substance requires. Enforced by `npm run lint`, which runs in CI.
- Functions must be smaller than 40 lines excluding comments and the catch/finally blocks of try/catch sections. If a function exceeds that, refactor it. Enforced by the same `npm run lint` rule.
- test files must be smaller than 400 lines excluding comments. Once 400 is exceeded, split the tests into multiple files. Same 400-line limit, enforced by `npm run lint`.
- tests must be smaller than 40 lines excluding comments and the catch/finally blocks of try/catch sections. If a test exceeds that, refactor it, or separate it into multiple tests. Same 40-line limit, enforced by `npm run lint`.
- Use TypeScript with proper types — avoid `any`. Enforced by `npm run lint` in CI; today's occurrences are frozen in `eslint-baseline.json` and only new ones fail.


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

### Test Execution Policy

The full suite takes ~9 minutes across 1300+ files and belongs to CI. Run the
tests your change can actually affect; do not wait for the whole suite while
iterating.

1. **Iterating on code** — run the tests related to what you touched:
   `npx vitest related <changed-file>`. This selects only files that import it.
2. **Before considering a task complete** — run `npm run test:affected`. It diffs
   against the merge-base and runs `vitest related` over your changes. It
   escalates to the full `test:unit` tier automatically when the change has
   suite-wide reach (`package.json`, `package-lock.json`, `vitest.config.ts`,
   `tsconfig*.json`, or anything under `scripts/`), because narrowing there
   would be a false negative.
3. **`npm test`** — the exhaustive run. Required only when your change is
   cross-cutting, when you suspect a coupling the related-selection cannot see,
   or before opening a pull request. CI runs it on every push and pull request,
   and that is the gate of record.

Never claim a task complete on the strength of a partial run without saying which
scope you ran. Report the scope and the result together.

**`npm run test:integration`** is the remaining tier: `scripts/test-partition.ts`
classifies a test as integration when it spawns a child process — `runCLI(`,
`spawnSync(`, `spawn(`, `execFileSync(`, `execFile(`, `execSync(`, `npm pack`,
`fixtures/cli-runner` — so it covers the built command surface end to end rather
than behaviour reached in process. `test:unit` takes everything that does not
spawn, and `npm test` is plain `vitest run`, which collects both tiers.
`test/sdk/packaging.test.ts` spawns too but `vitest.config.ts` excludes it from
that collection; it runs only via `npm run test:pack`.

Tests must not depend on timing or external services.

**`test:unit` is not the `test/` directory.** It covers every test tree in the
repository — `test/`, `packages/`, `src/` and `scripts/` — minus the files that
spawn a child process, so the `packages/llmwiki-kg` suites are part of it, along
with the three `src/dimensions/kg/` suites and `scripts/output-contracts.test.ts`.
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

### Pre-Commit Checks

Before committing any work, and before considering any task complete, you must:

1. `npx tsc --noEmit` — type-check passes
2. `npm run typecheck:tests` — the test type-check ratchet passes (no new test type errors)
3. `npm run build` — build succeeds
4. `npm run test:affected` — tests for what you changed pass (use `npm test` when
   the change is cross-cutting or before opening a PR; see Test Execution Policy)
5. `npm run fallow:ci` — the fallow codebase health analyzer with `--gate new-only`, and the command that actually gates. Fix all issues it reports (dead code, duplication, complexity). Use `fallow fix --dry-run` to preview auto-fixes, then `fallow fix --yes` to apply. Fix any remaining issues manually. Do not commit while it fails. `npx fallow` is the raw full-tree report and exits non-zero on inherited debt; it is not the gate.
6. `npm run lint` — the house-rule ratchet: 400-line files, 40-line functions, no
   `any`, and the `src/` <-> `packages/llmwiki-kg` import boundary. It passes on a
   frozen baseline and fails only on newly introduced violations. `npm run lint:update`
   rebaselines; using it to absorb a new violation defeats the gate.

Never bypass these gates with `--no-verify`; fix the underlying issue instead.

### Branch protection

`test-typecheck` is required by main's branch protection, alongside
`codebase-health` and `build-and-test (24)`. Branches must be up to date before
merging. Workflow changes must preserve the required check name or update branch
protection in the same rollout: **renaming a CI job without updating branch
protection silently un-gates `main`**.

The lint ratchet runs as a **step inside `build-and-test`**, not as its own job:
a step inherits that job's required check name, while a new job name has no
branch-protection entry and its red result could be merged past. Renaming or
splitting the lint step into a separate job would therefore silently un-gate it.

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

This does not weaken the Pre-Commit Checks above. `tsc`, `build`, `test:affected`, and
`fallow:ci` still gate a completed task. They are yours to run in your own checkout; none
of them requires a peer's agreement, and none of them is a message.
</pi-intercom>
