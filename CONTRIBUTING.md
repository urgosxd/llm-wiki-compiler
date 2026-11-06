# Contributing to llmwiki

Thanks for your interest in contributing! This guide covers the fork-and-PR workflow we use for all contributions.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/llm-wiki-compiler.git
   cd llm-wiki-compiler
   ```
3. **Install dependencies:**
   ```bash
   npm install
   ```
4. **Create a feature branch:**
   ```bash
   git checkout -b feature/<your-feature-name>
   ```

## Branch Naming

- `feature/<name>` — new features
- `fix/<name>` — bug fixes

## Development

### Working across packages

Use Node 24 or later and run installation, build and test commands from the
repository root. npm workspaces link the supporting packages automatically;
`npm run build` builds core, local workflows and the public facade in order.
You do not need to publish packages or open multiple PRs for one feature.

Applications import `llm-wiki-compiler`. Its public scoped dependencies,
`@atomicstrata/llmwiki-core` and `@atomicstrata/llmwiki-local-workflows`, expose
internal composition contracts, not separately supported application APIs.
Their filesystem directories remain `packages/llmwiki-core` and
`packages/llmwiki-local-workflows`.

Put knowledge and authority changes in the relevant `src/` subsystem, local
execution in `src/local-workflows/`, shared host contracts in
`src/local-workflow-host/`, and public composition in `src/sdk/` or `src/index.ts`.
See [package ownership](docs/guides/sdk-packages.mdx) for the boundaries.
After building, use `npm run test:pack` for packaging or export changes; it
checks an installed consumer outside workspace aliases.

### Build and Test

```bash
npm run build            # Compile TypeScript
npm test                 # Run all tests (~10 min: use test:unit while iterating)
npm run test:unit        # Every test tree, minus files that spawn a CLI subprocess (~5 min)
npm run test:integration # Tests that spawn `node dist/cli.js` (~5 min)
npx vitest related <file>  # Only the tests touching one source file (seconds)
npm run dev              # Watch mode for development
```

`test:unit` is not the `test/` directory. It covers every test tree in the
repository — `test/`, `packages/`, `src/` and `scripts/` — minus the files that
spawn a CLI subprocess, so the `packages/llmwiki-kg` suites are part of it, along
with the three `src/dimensions/kg/` suites and `scripts/output-contracts.test.ts`.
Those `llmwiki-kg` suites are database-backed, so they need Docker (or
`LLMWIKI_TEST_DATABASE_URL`) — but they did not create that prerequisite: the unit
tier already held roughly 65 root test files that use the database fixtures. What
the widened enumeration changed is the scale. It brings 86 more database-backed
files into `test:unit`, and the pre-push `test:affected` escalation now runs that
whole tier where before it might have run only the tests related to your change,
so the requirement is harder to avoid than it used to be. Without either provision
those files FAIL with a message naming Docker, the pinned image and the override
variable; `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` is the escape hatch, and it makes the
database-backed suites skip instead, so a run that sets it verifies nothing about
them.

**Why the suite is slow, and how to stay fast.** The suite is tail-dominated:
the median test file finishes in 0.24s, but 131 files spawn a CLI subprocess
(544 spawn sites total) and average 13.7s each because every `node dist/cli.js`
costs ~1.5s of cold start. Those 131 files are 54% of all test time. The tiers
are computed by content, not filename — `scripts/test-partition.ts` detects the
spawn constructs, so no slow file hides in the fast tier.

During development prefer `npx vitest related <file-changed>` and run
`npm run test:unit` before pushing. `npm test` remains the pre-push and CI gate
and runs every file.

The build in `test/global-setup.ts` is cached: a content hash of `src/`,
`packages/`, and the tsup configs in `.llmwiki/build-stamp.json` skips the ~42s
tsup run when nothing changed, so a single-file run drops from ~48s to under a
second. Set `LLMWIKI_TEST_FORCE_BUILD=1` to force a rebuild.

The database-backed suites start their own Postgres too. `test/global-setup.ts`
resolves one `pgvector/pgvector:pg16` container for the run, Docker picks the host
port, and every parallel worker shares it; repeat local runs reuse it. Isolation
between workers is unchanged: each test process creates its own database, applies
the schema files `scripts/apply-schemas.sh` lists, and drops it on exit. On that
default path nothing has to be started by hand — the container carries the schema, so
a local run no longer begins with `docker compose up` and `./scripts/apply-schemas.sh`
— and Docker is required locally.

If no container can start, the run falls back to a server already listening on the
compose stack's port (`postgresql://aks:aks@localhost:5434/aks`) and warns that this
run is not isolated from it.

Two variables change that:

- `LLMWIKI_TEST_DATABASE_URL` — use that database and start no container. Workers
  also receive it as `AKS_DATABASE_URL`, so set only the one and the paths that read
  production config see the same server. On this path the database belongs to the
  caller: the harness does not migrate it, so pointing the variable at a bare server
  means provisioning that schema yourself with `./scripts/apply-schemas.sh`.
- `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` — the only way to get a green run without a
  database. It is a debugging escape hatch: the database-backed suites skip, so they
  verify nothing. CI must never set it.

Without either one, database-backed suites FAIL with a message naming Docker, the
pinned image and the override variable. They no longer skip quietly, so a green run
means those assertions actually ran.

**CI and a local run reach the same rule by different routes.** CI supplies pgvector
through a `services:` block and sets `LLMWIKI_TEST_DATABASE_URL`, which wins under the
precedence above, so the container is never started there; a local run starts it.
Same precedence rule, two provisioning paths — which is why a CI-only failure and a
local-only failure can have different causes. Both workflows also set
`DATABASE_URL`, because `scripts/apply-schemas.sh` resolves its target from `$1` or
`DATABASE_URL` and reads neither of the two `*_DATABASE_URL` variables; without it
the schema steps exit 2 and `npm test` never runs.

**What the harness costs and buys, measured.** The database-gated tier is 81 test
files: 448 tests executed and 7 skipped on every run (the 7 are three gateway files
behind `AKS_TEST_GATEWAY` plus three RETIRED cases, not database skips). On the same
81 files:

| run | wall clock |
| --- | --- |
| live server via `LLMWIKI_TEST_DATABASE_URL` (baseline) | 50.37 s |
| container, cold (`TESTCONTAINERS_REUSE_ENABLE=false`, nothing adoptable) | 55.82 s |
| container, warm (`withReuse`, adopting a running container) | 48.61 s / 49.80 s |

Warm container against that baseline is −1.76 s, about 0.8% of the full-suite
reference (231.45 s): no real speed change, well inside load noise. The harness is
worth what it is worth for self-containment and for the end of silent skips, not for
wall clock — and the machine was under heavy external load when these were taken
(build times varied 3–5x), so read the numbers as indicative. The cold-start cost it
does add is small and one-off: about 1.5 s to create a container, about 120 ms to
adopt a reused one, so the first run of the day pays a few seconds and later runs do
not.

**Where each gate lives:**

The full suite runs in **CI**, on every push to main and every pull request
(`.github/workflows/ci.yml`). That is the ground truth and it is not duplicated
locally: a pre-push hook that re-ran all 1313 files added ~9 minutes to every
push to repeat a check the push itself triggers seconds later.

After `npm install`, husky wires up hooks that run automatically:

- **pre-commit** — `fallow` (codebase health) and `npx tsc --noEmit` (type check)
- **pre-push** — `npm run build` and `npm run test:affected`

`test:affected` resolves what changed since the merge-base with the canonical
main (`upstream/main` when a fork remote exists, else `origin/main`, matching
`scripts/fallow-ci.sh`) and runs `vitest related` over those files, so only tests
that import the changed code run. It escalates to the full `test:unit` tier when
a change has suite-wide reach — `package.json`, `package-lock.json`,
`vitest.config.ts`, `tsconfig*.json`, or anything under `scripts/` — because
narrowing there would be a false negative.

Run `npm test` locally whenever you want the exhaustive pass, for example before
opening a PR or after a wide refactor.

If a hook fails, fix the underlying issue rather than bypassing with `--no-verify`. Use `fallow fix --yes` to auto-fix unused exports, then address remaining issues manually.

You can also run the full suite manually:

```bash
npx tsc --noEmit   # Type-check
npm run typecheck:tests # Type-check tests against the per-file baseline
npm run build       # Build
npm test            # Tests
npx fallow          # Codebase health (dead code, duplication, complexity)
npm run fallow:ci   # Run fallow scoped to changes since origin/main (matches CI args)
```

**A note on `npm run fallow:ci`:** the `codebase-health` job in CI passes `--changed-since <PR-base-sha>` so it scopes analysis to the diff. `npm run fallow:ci` mirrors that locally by computing the merge-base between `HEAD` and the canonical main branch. The script prefers `upstream/main` when an `upstream` remote is configured (the fork workflow), and falls back to `origin/main` for direct clones. To make sure the comparison uses the canonical main from atomicmemory/llm-wiki-compiler:

```bash
# One-time setup on your fork
git remote add upstream https://github.com/atomicstrata/llm-wiki-compiler.git
```

Without an `upstream` remote on a fork checkout, the script compares against your fork's `origin/main`, which can drift from the canonical main and miss findings CI will catch.

There is also one known parity gap that no flag closes: fallow's clone-detection occasionally returns different results across platforms (CI Linux x64 vs macOS arm64). When CI flags a clone you can't reproduce locally, dedupe by intent and re-push — it's not a bug in your branch.

### Code Style

- Follow the conventions in `CLAUDE.md`
- **File size limit:** 400 lines (excluding comments). Refactor if exceeded.
- **Function size limit:** 40 lines (excluding comments and catch/finally blocks).
- Use TypeScript with proper types — avoid `any`.
- Include JSDoc comments on all exported functions and at the top of each file.
- Write meaningful variable and function names that reveal purpose.

### Writing Tests

- Place tests in the `test/` directory
- Use Vitest (already configured)
- Tests should not depend on timing or external services
- Keep test files under 400 lines; split if needed

### Test Type-checking

Vitest runs tests but does not check their TypeScript types. Run
`npm run typecheck:tests` as well. It checks nested tests, fixtures, and imported
production code without emitting JavaScript or declarations. TypeScript is
pinned so the recorded diagnostics are comparable across machines.

The existing backlog is recorded per file in `test-typecheck-baseline.json`.
New errors fail, including errors in previously clean files; reducing errors in
another file does not provide an allowance. When you fix an existing error, run
`npm run typecheck:tests:update` and include the reduced baseline in your PR.
That command refuses increases. To see diagnostic locations and messages, run
`npx tsc -p tsconfig.test.json`; this raw command also reports the known backlog.

The `test-typecheck` CI job compares the proposed baseline with the PR's base
commit, so editing an allowance upward cannot hide a new failure. To reproduce
that comparison locally, run `npm run typecheck:tests -- --base-ref origin/main`
(use `upstream/main` for a fork). Compiler-version or configuration changes need
an explicit baseline migration and review; routine updates do not accept them.
`--init` is only for initial baseline creation, not for clearing failures.

`test-typecheck` is required by main's branch protection, alongside
`codebase-health` and `build-and-test (24)`. Branches must be up to date before
merging. Workflow changes must preserve the required check name or update
branch protection in the same rollout.

## Submitting a Pull Request

1. Push your branch to your fork
2. Open a PR against `main` on this repository
3. In your PR description:
   - Describe **what** the change does and **why**
   - Reference the issue number if applicable (e.g., "Closes #3")
   - Include instructions on how to test the change
4. Ensure CI checks pass

## Review Process

- A maintainer will review your PR within a few days
- Address any requested changes by pushing new commits to your branch
- Once approved, the maintainer will squash-merge your PR

## Questions?

Open an issue or start a discussion — we're happy to help.
