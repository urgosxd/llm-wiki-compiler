# verification-throughput — verification that is measured, cheap and parallel-safe

Makes a delivery's verification cheaper: the full suite stops being paid twice, worker
and integration caps come from measured peak RSS instead of core count, and the six
independent static gates overlap behind one command. One delivery: T1–T7 close together.

## Specs

**S1 — measure, then pin.**

> Run the full suite at 2, 4 and 6 workers (or 3 points that bracket the host honestly). For each: wall time, peak RSS of the vitest process tree, whether swap was touched (`vmstat`/`swapon --show` deltas), and the resulting pass/fail. Then choose `maxWorkers` from that data and state the number with the measurement that justifies it. One measurement per configuration; do not average over runs unless you report every run.

**S2 — pin the limits in `vitest.config.ts`.**

> `maxWorkers` from A. A lower cap for the spawning/integration files: they launch `node dist/cli.js` children at 150–250 MB each, so their cost is per child process, not per file — use `poolOptions` or the existing partition rather than guessing a number, and say which mechanism you used and why. Outcome required: a single suite run must not be able to exhaust this host, so two deliveries can run concurrently without either paying for the other.

The two-item menu in that requirement cannot both hold, and the audit (`F5`, then
design question 5a) established why:

- `poolOptions.forks.maxForks` is **one global number**, so it cannot give the spawning
  files a lower cap than the rest of a run.
- "the existing partition" is a pair of **separate invocations** (`test:unit` /
  `test:integration`, `package.json:32-33`) produced by `scripts/test-partition.ts`,
  while `package.json`'s `test` is a bare unfiltered `vitest run` (`package.json:31`). A
  partition-level cap therefore never applies to `pnpm test`.
- per-project `projects` config also cannot express this repo's integration set: the
  partition classifies files by **content** (spawn-pattern matching,
  `scripts/test-partition.ts:78-86`, `spawnsChildProcess` at `:127`), not by path globs,
  and a content classification cannot be spelled as `include` patterns.

**Lead decision — two mechanisms, with the reason each one exists:**

1. **`vitest.config.ts` `maxWorkers`** — a single global cap, sized from the measured
   worst-case worker (the integration tier's per-worker peak, since it spawns
   `node dist/cli.js` children) so that `pnpm test` — the gate of record, with the same
   unfiltered command line — cannot exhaust the host.
2. **`package.json`'s `test:integration` script** — a lower `--maxWorkers` CLI override,
   sized from the measured per-child cost, so the deliberately-invoked spawning tier gets
   the lower cap the requirement asks for.

Stated plainly: **the global cap protects the suite nobody re-invokes differently; the
script-level override is what gives the spawning files their lower number; `projects` was
rejected because the tier is content-classified and cannot be spelled as include globs.**

**S3 — `test:affected` stops being a CI gate and never runs the full tier.**

Three parts.

**(a)** In `scripts/run-affected-tests.ts`, when the scope computation resolves to the
full tier, do not execute it: print the exact line
``affected: scope resolves to the full unit tier; run `pnpm test` instead`` and exit with
a distinct non-zero status — `78` (EX_CONFIG). Manager, verbatim: "a command that prints
a note and returns success while running **zero tests** is the precise failure class this
session has spent the day eliminating — a gate that looks green because it declined to
look."

Three contract details a byte-exact assertion depends on:

1. **The line goes to `stderr`**, not stdout.
2. **The prefix is `affected:` — NOT `test-affected:`.** Do not normalise it to the
   module's existing message convention (every other message uses `test-affected: `, at
   `scripts/run-affected-tests.ts:91`, `:129-135`, `:180`); the byte-exact assertion is
   on the mandated prefix.
3. **The pre-existing `kind: "none"` path is deliberately OUT of scope and keeps exit
   0** (`scripts/run-affected-tests.ts:178-181`). The resolution: `none` is a true
   negative, `global` is a refusal — `none` means nothing needs verifying, whereas
   `global` asserts work exists that this tool declines to do.

**(b)** Remove `test:affected` from `.github/workflows/ci.yml`: CI runs the static gates
plus `pnpm test`, one suite, one verdict. Manager, verbatim: "`ci.yml` runs
`test:affected` and then `pnpm test` in the same job — so on every single CI run, the
affected tier is executed and then immediately superseded by the exhaustive suite. It has
never contributed a verdict the full suite would not have produced."

**(c)** Remove it from `.husky/pre-push`. Manager, verbatim: "a push hook that may decide
to run nothing is not a hook."

Keep the escalation *decision* for `package.json`-class paths intact; only the redundant
*execution* goes. `test:affected` becomes a local-only tool.

The printed line, literally, in full — a test asserts it byte for byte — and the exit
status it accompanies is `78`:

```text
affected: scope resolves to the full unit tier; run `pnpm test` instead
```

**S4 — no stale docs.**

> Then update every caller and every document that describes the behaviour: `.github/workflows/ci.yml`, `.husky/*` if it applies, `AGENTS.md`'s Test Execution Policy, and the script's own header. A behaviour change with stale docs is how the next person runs both again.

Because S3(b) and S3(c) delete a CI step and a hook step, every document that lists them
moves with them: any document naming the `test:affected` CI step or the pre-push
invocation is in scope for T6, not only the four surfaces the quote names.

**S5 — overlap the static gates.**

> Provide one command that runs the independent static gates concurrently (`tsc`, `typecheck:tests`, `typecheck:kg`, `lint`, `fallow:ci`, `fallow:kg`) and fails if any fails, with each gate's output attributed. `build` is not in that set — it stays ordered before anything that spawns `dist/`. Report the wall-time before and after for the whole static set on this host. If the concurrency makes any gate flaky or output unreadable, say so and revert that gate to serial rather than shipping a flaky convenience.

**S6 — test-first for S3.**

> `C` is a behaviour change with a deterministic outcome, so: write the failing test first and show it RED. Cover: escalation detected → no test execution happens (assert on the observable — spawned child count or exit status and the printed line), and non-escalated scope → still executes. Assert exit codes and the exact message, not internals.

**The test seam.** `scripts/run-affected-tests.ts` currently calls `main()` at import time
(`:199`, `process.exitCode = main(process.argv.slice(2));`) with no invoked-directly
guard, so **no unit test can import it**. The change must:

- extract an exported entry, and put the top-level call behind the same invoked-directly
  guard `scripts/test-affected.ts:173-175` already uses;
- **inject the vitest invocation** so the test can count invocations. Name the injected
  dependency something neutral (e.g. `runner`).

The test must assert, for the escalated case: exit status `78`, the exact stderr bytes,
and **zero** invocations. For the non-escalated case: the invocation happens.

**Constraint:** the test file must not contain the literal token `spawn(` or any of the
spawn patterns `scripts/test-partition.ts:78-86` matches — `runCLI(`, `execFileSync(`,
`spawnSync(`, `spawn(`, `execFile(`, `execSync(`, `npm pack`, `fixtures/cli-runner` —
because classification is by content and the pin would otherwise land in the slow tier it
is meant to protect.

**Additional test cases the S11 guardrail requires.** They do not all live in the same tier,
and must not be moved between tiers:

- **Scope level** — an absent/unreachable base ref in a synthetic repository must return
  `unresolved`, and explicitly **not** `none`. The harness already exists at
  `test/test-affected-scope.test.ts:73-99`: `mkdtempSync` + `git init`, `git config`, one
  commit, a synthetic `refs/remotes/origin/main` and a local `origin` remote.
- **Scope level** — a remote ref that **exists** but whose history is unrelated, so
  `merge-base` fails, must return the same `unresolved` outcome.
- **Script seam** — exit status `69` with the exact wording its own line requires, plus
  **zero** invocations of the injected `runner`.

Those synthetic-repository tests run `git` through `execFileSync`
(`test/test-affected-scope.test.ts:76-77`), so `scripts/test-partition.ts`'s content
classification (`:78-86`, pattern `\bexecFileSync\s*\(`) already places that file in the
**integration** tier. That is correct and expected — do not move those tests, and do not
try to make them unit-tier by hiding the spawn.

**Consequence for the seam's shape.** The escalated (`78`) and uncomputable (`69`) cases
cannot be produced from a synthetic repository without running `git`, and running `git`
means an `execFileSync(`/`spawnSync(` call site in the pin file, which the spawn-pattern
constraint above forbids. So the extracted entry must inject **two** dependencies: the
`runner` (so the test can count invocations) and the **scope decision** — the resolved
`AffectedScope`, or the resolver function returning it. With both injected, all three
`test:affected` outcomes are assertable in a pattern-free unit-tier file. Deciding the
scope from git stays the job of `resolveAffectedScope`, covered by the integration-tier
tests above.

**S7 — hard prohibitions.**

> No buying hardware. No changing what the tests assert. No skipping, no `.only`, no relaxed timeouts to make a number look better — if a test needs a longer timeout under a lower worker count, say so explicitly instead of raising it silently. No history rewriting, no push, no `--no-verify`, no `HUSKY=0`. No `cp -a` of this worktree for a baseline tree — it copies a `.git` pointer file and any git command inside the copy hits the shared gitdir; use `git worktree add` or `git archive`. `odd/tasks/**` is append-only.

**S8 — gates.**

> `corepack pnpm exec tsc --noEmit` · `corepack pnpm run typecheck:tests` · `corepack pnpm run lint` (**643/466/496 is the ceiling; report the literal triple**) · `corepack pnpm run build` · `corepack pnpm run fallow:ci` · **`corepack pnpm test` in full, alone** — mandatory, because this delivery changes how the suite itself is scheduled, which is the one thing `test:affected` can never validate.

**S9 — the pinned contract may be edited, loudly.**

> And yes, this authorizes editing `test/control-gates.test.ts`. My 'no test edits' rule was written for renames; these assertions pins a CI step I am deliberately deleting. Update them explicitly and say in the commit body which pinned contract changed and why — do not quietly loosen them. The assertions about the six-gate numbered list in `AGENTS.md` and the `README.md` fenced block stay unless the commands themselves change.

`GATE_COMMANDS` (`test/control-gates.test.ts:27-34`) and the six-gate numbered list in
`AGENTS.md` (`AGENTS.md:94-100`) stay exactly as they are, because `pnpm run test:affected`
remains a local pre-commit gate there. What S9 authorizes is the CI-wiring assertions
that pin a step this delivery deletes: the job-key assertion
(`test/control-gates.test.ts:91-93`) is unaffected because the jobs stay, while the
`pnpm run test:affected` step and its ordering assertions
(`test/control-gates.test.ts:99-104`, `:106-114`) must be updated to the new CI reality,
with the commit body naming the changed contract and the reason.

**S9 is the ONLY carve-out from S7**, and it covers `test/control-gates.test.ts` **and**
the push-gate pins in `scripts/pnpm-invocation.test.ts` — the exact hook command list
(`scripts/pnpm-invocation.test.ts:205-212`) and the build-then-affected ordering
assertions (`:214-227`) — plus any other test pinning the deleted `test:affected`
pre-push invocation, which T3 must find by grep rather than assume.

The reason: an assertion that pins a step the delivery deliberately deletes is the same
class of edit as the CI pin the Manager already authorized, and the alternative is a red
suite or a quiet loosening.

**S10 — acceptance and report.**

> The three measurement points with wall time, peak RSS, swap delta and pass/fail; the chosen `maxWorkers` and the sentence that justifies it; the integration cap mechanism; the `test:affected` behaviour change with its RED test; the static-gate before/after wall times; every document updated with `file:line`; every gate exit with the literal lint triple; the full suite under the new limits; commit SHAs as **full 40 characters**; `git status --short`; and a `Risk:` line using item 1 data/irreversible, 2 security, 3 contracts others consume, 4 concurrency, 5 delivery/environment, 6 no test would catch a regression — or `Risk: none`. **Item 5 applies** (CI and the local gate chain) and **item 3 likely applies** (CI consumes `test:affected`'s exit semantics). Say which rather than defaulting to `none`.

Every command in this delivery runs with **Node 24 only**, prefixed
`PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`, using `corepack pnpm` when bare
`pnpm` answers 127.

**S11 — a true negative must be reachable only by a successful computation.**

Manager, verbatim:

> Add one guardrail, and test it: `none` must be reachable only by a successful computation, never by a failed one. The risk in the current shape is that a failure to resolve `origin/main` — remote absent, ref deleted, merge-base error — degrades to 'no changes detected' and exits 0. In *this* repo that is not hypothetical: `origin/main` is roughly 300 commits behind local `main`, so the ref exists but means something quite different from what a fresh clone would see. So: If `origin/main` cannot be resolved, or the merge-base fails, that is **not** `none`. It must be a distinct non-zero outcome with its own message, in the same family as `78`. Add a test for it: unreachable/absent base ref → non-zero, and specifically **not** the `none` path. A true negative is only true if the computation that produced it succeeded; otherwise it is a refusal wearing the word 'none', which is the same silent-green shape in different clothes.

**The Lead's reading of the current defect, verified in `scripts/test-affected.ts`.** Two
facts, and the second one is the real defect:

- **Already good:** `resolveAffectedScope` refuses to return `none` on a failed
  computation. An unresolvable base ref returns
  `{ kind: "global", reason: "no canonical base ref (upstream/main or origin/main) could be resolved" }`
  (`scripts/test-affected.ts:126-128`), and a failed merge-base/diff returns
  `{ kind: "global", reason: "could not diff against ${baseRef}" }` (`:130-132`). So `none`
  **is** already unreachable by failure.
- **The defect, once S3a lands:** every `global` outcome prints
  ``affected: scope resolves to the full unit tier; run `pnpm test` instead`` and exits
  `78`. That message asserts a scope was *computed*, when in a failure nothing could be
  computed at all. The failure is therefore still misreported — a refusal wearing the word
  "resolved" instead of the word "none" — and the guardrail requires a **distinct**
  outcome with its **own** message.

**Required design:**

1. `AffectedScope` gains a fourth kind, **`unresolved`**, carrying a `reason`. Both current
   failure paths move to it: no canonical base ref (`upstream/main` or `origin/main`
   absent, unreadable, or `rev-parse --verify --quiet` failing —
   `scripts/test-affected.ts:64-70`) and a failed `merge-base` / failed diff (`:105-117`).
2. Three distinct non-zero statuses, all documented as **named constants in one place**:
   - `78` (**EX_CONFIG**) — the full unit tier **was resolved** and is being declined; the
     required line
     ``affected: scope resolves to the full unit tier; run `pnpm test` instead``, on
     **stderr** (S3a).
   - `69` (**EX_UNAVAILABLE**) — the change set **could not be computed**: base ref
     unavailable or merge-base failed. Its own line on **stderr**, with distinct wording
     that does **not** claim a scope was resolved, and it must **name which step failed**.
   - `none` keeps `0` and its existing message, and is reachable **only** when the
     computation succeeded and found nothing relevant.
3. **Consequence to record:** `unresolved` is **not** an escalation. The old behaviour
   silently fell back to the unit tier; that fallback is now a hard, loud failure, because
   after S3a an escalation can no longer run anything anyway.
4. **Exhaustiveness.** The new union member must be handled everywhere `AffectedScope` is
   switched on: `scripts/test-affected.ts` (`report` at `:154-162`, `main` at `:165-170`),
   `scripts/output-contracts.ts` (`planAffectedInvocations`, `:93-97`),
   `scripts/run-affected-tests.ts` (`announceTier` at `:116-128`, `main` at `:178-181`, and
   the file header's outcome list at `:8-18`). Named explicitly rather than quietly
   widened: `test/test-affected-scope.test.ts:56-58`'s "returns a scope object with a
   recognised kind" assertion lists `["global", "files", "none"]` and **must gain the
   new kind**. That is an authorized edit of the same class as S9 — a union member added by
   this delivery — and it is named here rather than discovered later by a red suite.

**Named non-goal.** The fact that `origin/main` in this repository is roughly 300 commits
behind local `main` is a **semantic divergence, not a resolution failure**. This delivery
does **not** change the base-ref choice; recording it here prevents a later reader from
claiming the guardrail covered it.

## Tasks

- [x] T1 — this document · S1-S11 · Lead · commit: e4f3b8f1887d9ef4b03672099a91810279be323a
- [x] T2 — `run-affected-tests.ts`: full-tier scope prints the line and exits 78 (see L5; L2's exit 0 is superseded), RED test first, including the extracted entry behind the invoked-directly guard, the injected `runner` seam so the test can count invocations, and the S11 guardrail — the four-way outcome, the three statuses (`0` / `69` / `78`), and the `unresolved`-is-not-`none` tests · S3a, S6, S11 · worker · commit: 405c5999f46a2e41e951790d8add09c21dac6f65 — reopened and re-closed: T5's `lint` run found a function-length violation in the test file this work unit added; fixed by refactoring in the follow-up `fix(tests): split the synthetic-repo helper under the function-length limit` work unit (see L9)
- [x] T3 — remove `test:affected` from `.github/workflows/ci.yml` and `.husky/pre-push`, update the `test/control-gates.test.ts` CI-wiring assertions explicitly, and update the push-gate pins in `scripts/pnpm-invocation.test.ts` (the hook command list and the build-then-affected ordering assertions); grep for any other test pinning the deleted invocation · S3b, S3c, S9 · worker · commit: f658edffde9ac46a8c9195fb3449bdff6131dd70
- [x] T4 — `vitest.config.ts` worker and integration caps derived from the S1 measurements · S1, S2 · worker · commit: e4f3b8f1887d9ef4b03672099a91810279be323a
  Precondition: measure only when `pgrep -af vitest` is empty and no other campaign is
  running; each measurement point sequential and alone. The three measurement points are
  recorded by appending them to this document's `## Log`, with the worker count printed
  next to every RSS figure.
- [x] T5 — the concurrent static-gate command plus its `package.json` script · S5 · worker · commit: 3c0604b6e6b000e3d4df6c67c73b5a71193cf12e
- [x] T6 — documentation and script-header updates for T2-T5 · S4 · worker · commit: d997a0b41d42ebf7dc5a8a8d788c477d9de1c96c
  Exact edit list from the audit (`F6`): `AGENTS.md:46-51` (the Test Execution Policy
  sentence saying it escalates to the full unit tier), `AGENTS.md:97-98` (pre-commit gate
  4 prose tail — the numbered command itself must stay, only the prose changes),
  `AGENTS.md:237-239`, `README.md:449-452`, `.husky/pre-push:1-6` (its own comment), and
  the header of `scripts/run-affected-tests.ts`.
  PINNED, must not be reordered or removed: `README.md:440-448`'s fenced block and the
  six-gate numbered list (`AGENTS.md:94-100`). `CONTRIBUTING.md` does not exist at the
  repository root (only under `packages/llmwiki-kg/`), and `docs/**` has no
  `test:affected` reference.
- [ ] T7 — independent verification per `S#`, exercising all three exit paths through the seam (`0` true negative, `69` uncomputable base, `78` full-tier decline) and asserting that `unresolved` never reports as `none`, then the full `pnpm test` alone under the new limits · S1-S11 · verifier · commit: pending

`Build` stays in `.husky/pre-push` and in CI; only the `test:affected` invocation is
removed from both, so the hook keeps a real gate and the pipeline keeps `pnpm test` as
its only full-suite verdict.

## Log

**L1 — Project assignment for branch chore/verification-throughput (verbatim).**

```text
Project assignment for branch chore/verification-throughput:

Make verification cheaper and parallel-safe, measured rather than guessed. The human's words: `mas que comprar talves asignar ahora, a los comanos run tests, el problema es cuando hay en paralelo … 20 min haciendo tests de verificacion es mucho`.

Repo: llm-wiki-compiler, `main` at `c71d05aef0760c784fa6c5c91dbb84f2ca51807a`. Read `AGENTS.md` first — the Test Execution Policy section is the contract you are changing. Node 24 ONLY. pnpm; if bare `pnpm` answers 127, use `corepack pnpm` and say so.

Measured problem, three parts: (1) the same suite is paid twice, because `test:affected` escalates to the full unit tier whenever `package.json`, the lockfile, `vitest.config.ts`, `tsconfig*.json` or `scripts/` change, and that tier is a subset of `pnpm test` — roughly 4–5 minutes per delivery spent re-running the same tests; (2) workers are sized by core count, not by memory: five concurrent vitest runs exhausted swap on a ~14 GB host with 3 GB swap, spiked load to 51, killed three agent sessions and produced `ERR_IPC_CHANNEL_CLOSED` and 30–60 s timeouts on tests that pass in 6–8 s alone; (3) the static gates run in series out of habit, though only `build` must precede anything that spawns `dist/`. Nobody has measured peak RSS of a suite run, and that number is the input to every limit set.

Deliverable A/B/C/D: measure and report; pin limits in `vitest.config.ts`; stop the double suite in `scripts/run-affected-tests.ts`; overlap the static gates behind one command. Gates: tsc, typecheck:tests, lint at 643/466/496, build, fallow:ci, and `corepack pnpm test` in full and alone. Full prohibition set and the report format follow in the body of the assignment.
```

**L2 — Lead decision: exit status for the full-tier skip.**

The full-tier skip exits **0**, not a dedicated non-zero code. Why:

- `.github/workflows/ci.yml:103` runs `pnpm run test:affected` immediately before
  `pnpm test` in the same `build-and-test` job (`.github/workflows/ci.yml:24`), so a
  non-zero skip would fail CI on every delivery whose change has suite-wide reach —
  the normal case for `package.json`-class paths — instead of letting the very next
  step do the work.
- `.husky/pre-push:8` runs `node scripts/pnpm-invocation.ts run test:affected` as a
  blocking gate, and that resolver exits non-zero on its own. A non-zero skip would
  therefore block every push, and the only ways out would be a `||` tolerance in the
  hook or `--no-verify`, and a `||` tolerance also masks a genuine test failure.
- `test/control-gates.test.ts:99-104` pins the literal command string
  `pnpm run test:affected` inside `build-and-test`, and
  `test/control-gates.test.ts:127-129` pins `AGENTS.md`'s six-gate numbered list in
  order. S7 forbids changing what an existing test asserts, so a new non-zero status
  would have to edit a pinned assertion.

The distinguishable signal is therefore the exact stderr line (S3) plus zero spawned
children, both of which S6's test asserts.

**L3 — Lead constraint: pinned surfaces that must not move.**

Read and confirmed against the files; any documentation or workflow edit in this
delivery must preserve all four:

- **The six-gate order in `AGENTS.md`'s numbered list** — `AGENTS.md:94-100`, items
  1–6 (`pnpm exec tsc --noEmit`, `pnpm run typecheck:tests`, `pnpm run build`,
  `pnpm run test:affected`, `pnpm run fallow:ci`, `pnpm run lint`), pinned by exact
  equality against `GATE_COMMANDS` (`test/control-gates.test.ts:27-34`) in
  `test/control-gates.test.ts:127-129`. `numberedGateCommands` scans **every** line of
  `AGENTS.md` with `/^\d+\. \`([^\`]+)\`/`, so a new numbered entry must not begin with
  a backticked command; the Test Execution Policy's own numbered items start with `**`
  (`AGENTS.md:44`, `AGENTS.md:46`, `AGENTS.md:52`) and are therefore invisible to it.
  Prose may be added, the numbered list must not be renumbered or reordered.
- **The same commands in `README.md`'s fenced block** — `README.md:440-448`, pinned for
  presence and relative order at `test/control-gates.test.ts:131-138`. The block also
  carries `pnpm test` (`README.md:445`), which is not one of the six pinned commands.
- **The branch-protection job keys** — `build-and-test` (`.github/workflows/ci.yml:24`)
  and `codebase-health` (`.github/workflows/ci.yml:122`), pinned as the exact `jobs`
  key list at `test/control-gates.test.ts:91-93`; and `test-typecheck`
  (`.github/workflows/typecheck-tests.yml:12`), pinned at
  `test/control-gates.test.ts:95-97`.
- **The literal `pnpm run test:affected` step in `build-and-test`** —
  `.github/workflows/ci.yml:103`, pinned as a command of that job at
  `test/control-gates.test.ts:99-104`, and pinned in position relative to
  `pnpm test` (`.github/workflows/ci.yml:104`) at `test/control-gates.test.ts:106-114`.

**L4 — Lead constraint: concurrency hazard to verify, not assume.**

The six static gates are read-only in normal (non-`--update`) mode per reconnaissance,
and the open hazard is whether a `tsc`-based gate writes a shared `.tsbuildinfo` (or
any other shared cache path) when run concurrently. T4 must verify that by observation,
not assume it.

What was confirmed by reading (not by running): the only writes in the three Node
ratchets sit on their update paths — `scripts/lint-ratchet.ts:376`
(`if (update) writeBaseline(...)`), `scripts/typecheck-tests.ts:79`, and
`scripts/kg-typecheck.ts:254` — and each writes a distinct baseline file at the
repository root, not a shared cache directory. None of the four compiler
configurations declares `incremental` or `composite` (`tsconfig.json`,
`tsconfig.test.json`, `packages/llmwiki-kg/ts/tsconfig.json`,
`packages/llmwiki-kg/ts/tsconfig.build.json`), and `scripts/kg-typecheck.ts:192`
creates its program in-process with `noEmit: true`; `scripts/lint-ratchet.ts:203`
constructs `ESLint` without a `cache` option, so no `.eslintcache` is produced.
`scripts/fallow-ci.sh` reads and fetches but writes nothing, `fallow:kg`
(`package.json:44`) writes nothing, and neither `.fallowrc.json` names a cache path.
The expectation is therefore that concurrent execution writes nothing shared — T4 must
still show it, with a before/after observation of the working tree and of any
`.tsbuildinfo` or cache path, rather than inheriting that expectation.

**L5 — Manager ruling (supersedes L2).**

Manager:

```text
Both flagged before writing code — that is exactly the right time, and one of them changes my answer.

## 1. Exit status: I am overruling exit 0, and I am also removing the reason it looked necessary

Your reasoning is sound on the facts, and it points at something bigger than the exit code: **`test:affected` in CI is redundant by construction.** `ci.yml` runs `test:affected` and then `pnpm test` in the same job — so on every single CI run, the affected tier is executed and then immediately superseded by the exhaustive suite. It has never contributed a verdict the full suite would not have produced. It is local-iteration tooling that got wired into a pipeline that already runs everything.

So the change is larger and cleaner than a status code:

- **Remove `test:affected` from `.github/workflows/ci.yml`.** CI runs the static gates plus `pnpm test`. One suite, one verdict.
- **Remove it from `.husky/pre-push`.** The commit hook already runs `fallow:ci` + `tsc --noEmit`; a push hook that may decide to run nothing is not a hook.
- **`test:affected` becomes a local-only tool** that, when the scope resolves to the full tier, prints the exact line and exits with a **distinct non-zero status (use `78`, EX_CONFIG)** — not 0.

Why I will not accept exit 0: a command that prints a note and returns success while running **zero tests** is the precise failure class this session has spent the day eliminating — a gate that looks green because it declined to look. Three separate deliveries today were saved by refusing exactly that shape (`skipIf`-gated RLS coverage, a derivation that shrank its own set, a CLI whose build exited 0 while the artifact could not start). I am not going to introduce a fourth one in the tooling that decides whether anything gets verified, even with a clear message. Message plus zero children plus exit 0 still reads as "verified" to a script, a hook, or an agent under time pressure.

## 2. The contaminated baseline is the more interesting finding — keep going, but change what carries the decision
6588 MB used and 3415 MB of swap consumed **with no vitest running** is not noise, it is a resident consumer nobody has identified. Two consequences you already drew correctly: the headroom is far smaller than 14 GB, and part of what killed three sessions may have had a co-factor. **Per-worker peak RSS is the right decision input**, and I want the absolute figures labelled indicative rather than presented as the host's capacity. Do not kill other sessions to make a number look better — that would be measuring a machine that no longer exists.

If the measurement campaign can identify what is holding ~6.5 GB resident, that is worth a paragraph on its own: it is the difference between "we need more RAM" and "something here leaks".

## 3. Ordering and the feature document
Writing `odd/tasks/verification-throughput.md` before any source write, on top of `odd/tasks/test-suite-speedup.md` without contradicting it, is correct. Keep every measurement point strictly sequential and alone, and report the worker count next to every RSS figure — a memory number without its worker count is not a measurement.

Everything else in the brief stands.
```

What L5 supersedes, so no later reader has to reconstruct it:

- **L2 in full.** The full-tier skip exits `78` (EX_CONFIG), not `0` (S3a), and the two
  facts L2 leaned on are themselves deleted: the `pnpm run test:affected` step in
  `.github/workflows/ci.yml:103` and the invocation in `.husky/pre-push:8` (S3b, S3c).
  `test:affected` is a local-only tool.
- **The part of L3 that pins the deleted CI step** — `.github/workflows/ci.yml:103` as a
  command of `build-and-test`, and its position relative to `pnpm test`, pinned at
  `test/control-gates.test.ts:99-104` and `:106-114`. S9 authorizes editing exactly those
  assertions, loudly and with the reason in the commit body. Still unchanged and still
  enforced: the `AGENTS.md` six-gate numbered list (`AGENTS.md:94-100`), the `README.md`
  fenced block (`README.md:440-448`), and the branch-protection job keys
  (`.github/workflows/ci.yml:24`, `:122`; `.github/workflows/typecheck-tests.yml:12`).
- **Task numbering.** The task list was rebuilt around the new split; L4's reference to
  "T4" for the observation of the static gates now names **T5**, and the caps task that
  was T3 is now T4. L4's constraint itself is unchanged.

**L6 — Lead decisions after audit.**

Decisions taken after the document audit (`F1`-`F13`), one line of reason each.

- **S2 resolves to two mechanisms, not a menu.** The global `vitest.config.ts`
  `maxWorkers` protects `pnpm test` (the gate of record, same unfiltered command line),
  and the `test:integration` script-level `--maxWorkers` override gives the spawning tier
  the lower cap the requirement asks for. `projects` was rejected because the tier is
  classified by file **content** (spawn-pattern matching in `scripts/test-partition.ts`),
  and a content classification cannot be spelled as `include` globs.
- **The skip line goes to `stderr` with the prefix `affected:`.** Not `test-affected:`:
  every other message in the module uses that prefix and the mandated line does not, so a
  normalising edit silently breaks the byte-exact assertion.
- **`kind: "none"` stays out of scope and keeps exit 0.** `none` is a true negative —
  nothing needs verifying — while `global` is a refusal, asserting work exists that this
  tool declines to do.
- **S9's carve-out extends into `scripts/pnpm-invocation.test.ts` (F1).** Removing the
  pre-push invocation breaks the pinned hook command list (`:205-212`) and the
  build-then-affected ordering assertion (`:214-227`); an assertion pinning a step the
  delivery deliberately deletes is the same class of edit as the CI pin the Manager
  already authorized, and the alternative is a red suite or a quiet loosening.
- **S6 requires a test seam.** `run-affected-tests.ts` calls `main()` at import time with
  no invoked-directly guard, so the change extracts an exported entry behind the same
  guard `scripts/test-affected.ts` uses and injects the `runner` dependency; the test file
  must avoid the literal `spawn(` token and every spawn pattern
  `scripts/test-partition.ts` matches, because classification is by content and the pin
  would otherwise land in the slow tier it is meant to protect.
- **The lint triple `643/466/496` is reported as printed at run time, not treated as a
  frozen constant**, per `AGENTS.md`; two older task documents record a different triple,
  so the print of that run is the ceiling and S8's literal is the historical reference,
  not a number to preserve.

**L7 — Manager guardrail (extends L6 and S3a).**

Manager, verbatim:

```text
Add one guardrail, and test it: `none` must be reachable only by a successful computation, never by a failed one. The risk in the current shape is that a failure to resolve `origin/main` — remote absent, ref deleted, merge-base error — degrades to 'no changes detected' and exits 0. In *this* repo that is not hypothetical: `origin/main` is roughly 300 commits behind local `main`, so the ref exists but means something quite different from what a fresh clone would see. So: If `origin/main` cannot be resolved, or the merge-base fails, that is **not** `none`. It must be a distinct non-zero outcome with its own message, in the same family as `78`. Add a test for it: unreachable/absent base ref → non-zero, and specifically **not** the `none` path. A true negative is only true if the computation that produced it succeeded; otherwise it is a refusal wearing the word 'none', which is the same silent-green shape in different clothes.
```

Lead note: the current `global` fallback on an unresolvable base ref would **misreport**
once S3a lands — it would print "scope resolves to the full unit tier" and exit `78` for a
computation that never succeeded — which is why `unresolved` is a **separate kind with its
own status (`69`) and its own message**, not a fourth message attached to `global`.

**L8 — S1 measurement campaign (recorded).**

Method first, because every number below is only as good as it. One full-suite run per
configuration, **sequential and alone**, `corepack pnpm exec vitest run --maxWorkers=N`.
Peak RSS is the cgroup `memory.peak` of the run's `systemd-run --user --scope` unit, which
**covers descendants** — the vitest pool processes and every spawned `node dist/cli.js`
child count against the same counter. `MemoryPeak=1` is **rejected by systemd 255**, so
the counter **file** (`/sys/fs/cgroup/<scope>/memory.peak`) was read instead of setting a
property. A ps-sampler cross-check **over-counts**, because summing per-process RSS counts
shared pages once per process that maps them (RSS is not exclusive); the cgroup figure
counts each page once, which is why it carries the decision.

Three points, one run each, nothing averaged:

| workers | wall s | peak RSS MB | MB/worker | max concurrent node procs | pswpout Δ | worst SwapFree MB | worst MemAvailable MB | exit | files | tests |
|---|---|---|---|---|---|---|---|---|---|---|
| 2 | 809.2 | 2808 | 1404 | 9 | 0 | 680 | 3727 | 0 | 917/0/3 | 6838/0/7 |
| 4 | 496.1 | 3816 | 954 | 13 | 266 pages (~1 MB) | 691 | 3638 | 0 | 917/0/3 | 6838/0/7 |
| 6 | 402.7 | 5119 | 853 | 17 | 102 509 pages (~400 MB) | **359** | **2576** | 0 | 917/0/3 | 6838/0/7 |

(`files` and `tests` are vitest's passed/failed/skipped totals — every point passed the
suite clean.)

**Host baseline, and the resident-consumer finding.** 16 cores, 13805 MB RAM, 4 GB swap
that was **already 3.4–3.7 GB used before every run** by processes unrelated to this
campaign: 14 other `pi` sessions (~3.5 GB), Chrome (~2 GB), `opencode serve` (409 MB) and
4 docker containers. Idle node RSS across all of them is only 260–307 MB total, so ~6.5 GB
resident with **no vitest running** is not noise — it is a resident consumer nobody has
identified. Two consequences: the headroom is far smaller than 14 GB suggests, and part of
what killed three earlier agent sessions may have had this co-factor. No other session was
killed to make a number look better — that would be measuring a machine that no longer
exists. So "no swap pressure" below means **the run added none**, and every absolute figure
is **indicative** of this shared host, not this host's capacity.

**The integration tier is not the memory hog.** Measured alone, `vitest run
--maxWorkers=2`, 86 files: **287.9 s**, peak **1858 MB**, max **2** concurrent
`node dist/cli.js` children, **max single child RSS 442 MB**. The brief assumed 150–250 MB
per child — the observed peak is nearly double, so **442 MB is the figure the per-child
cap is sized from**, not the assumed range. The spawning tier is *not* where the memory
goes; the plain-parallel unit tier is.

**Serial static-gate baseline at the base commit.** `tsc --noEmit` 5.1 s,
`typecheck:tests` 12.5 s, `typecheck:kg` 5.2 s, `lint` 10.2 s, `fallow:ci` 2.1 s,
`fallow:kg` 0.5 s → **35.6 s total**, with `build` 20.6 s **separate** (it stays ordered
before anything that spawns `dist/`). `lint` printed the literal triple **643/466/496** on
that run.

**Decision: `maxWorkers` is pinned to 4.** Six workers is 93 s faster (402.7 s vs
496.1 s) and is not affordable: it pushes ~400 MB into swap and drags worst MemAvailable
down to 2576 MB on a host already carrying other sessions, whereas 4 workers peaks at
3816 MB (954 MB/worker) with ~1 MB of swap added. The cap is sized from **the worst case
`pnpm test` can actually meet — the integration tier's per-worker peak, since `pnpm test`
runs both tiers unfiltered — so the unit tier deliberately runs below its own optimum.
Nobody should raise this number without the integration peak in hand.**

One more scaling fact, because it changes what the wall time means: this host measured
**~2× slower than `AGENTS.md`:39's "~9 minutes" reference**, so W=4 lands at **~8.3 min**
(496.1 s), not the ~4 min the reference would imply.

`test:integration` takes the lower cap at the **script level** — `vitest run
--maxWorkers=2 $(node scripts/test-partition.ts integration | tr '\n' ' ')` — because
`2` is the only integration worker count measured (287.9 s, 1858 MB, 2 concurrent children
at 442 MB each); **no higher count was measured, so none was invented**. `test`,
`test:unit` and every other script stay byte-identical, which is the S2 split from L6: the
global config cap protects the unfiltered gate of record, the script override gives the
spawning tier its lower number.

**L9 — T2 reopened: house-rule violation found by T5's gate run.**

The static-gate task ran `pnpm run lint` — the gate T2 was explicitly told not to run — and it
failed on T2's own new code:

```text
test/test-affected-scope.test.ts:116 max-lines-per-function Arrow function has too many lines (51). Maximum allowed is 39.
```

T2 introduced it when it added the two synthetic-repository cases and the local
`FixtureRepo` / `inSyntheticRepo` helpers to that file: the enclosing `describe` arrow grew to
51 lines against a 39-line allowance. It was caught by a DIFFERENT task's gate run, not by the
one that wrote the code, which is the whole reason the gate exists.

Fixed by REFACTORING, not by disabling. The repeated fixture setup (commit the base, point an
unrelated `origin/main` at an orphan history) became named helpers — `commitAll` and
`addUnrelatedOriginMain` — and the two new cases moved into their own `describe`, so each case
body is four lines and every arrow is under the limit. Not one assertion changed: both cases
still assert `unresolved` and explicitly not `none`, and the recognised-kind list still carries
`unresolved`. No `eslint-disable`, no `lint:update`, no baseline absorption — a baseline raised
to swallow a new violation is the gate deleting itself. The file stays in the integration tier,
because it spawns `git` and `scripts/test-partition.ts` classifies by content.

Lint after the fix, literally: `643 baseline violations in 466 files across 496 rule/file
entries; no regression.` (`corepack pnpm run lint`, exit 0). Test count unchanged: 20 passed
before and after.

Corrected in the same pass while the document was open: the note under `## Tasks` claimed the
pipeline keeps `pnpm test` as its "only test verdict", which is false —
`.github/workflows/ci.yml` also runs `pnpm run test:pack` and the two schema-apply steps. It now
reads "its only full-suite verdict" (defect F11 from the same audit).
