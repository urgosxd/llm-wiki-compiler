/**
 * @file test/sdk/vitest.packaging.config.ts
 * @description Config for the `test:pack` packaging gate: it pins the gate to exactly one test file.
 *
 * WHY THIS FILE EXISTS, AND WHY IT MUST NOT BE "SIMPLIFIED" BACK.
 * `test:pack` used to run `vitest run --config /dev/null test/sdk/packaging.test.ts`.
 * With `/dev/null` as the config, vitest falls back to its built-in defaults, and a
 * positional argument is then a SUBSTRING FILTER over discovered filenames — not an
 * exact path. So the gate collected every discovered file whose path merely CONTAINS
 * `test/sdk/packaging.test.ts`: the real one, plus the same path inside every sibling
 * checkout living under `.worktrees/` (and any other tree with that shape). A gate that
 * reports "one test passed" while silently running whatever copies happen to be on the
 * developer's disk is not a gate; it is a coin flip whose result depends on unrelated
 * checkouts.
 *
 * Adding an `--exclude` glob for the worktree directory would treat one instance and
 * leave the class open: the next sibling tree named anything else, at any depth, joins the
 * run again. The structural fix is to stop asking vitest to discover-and-filter, and
 * instead DECLARE the selection: `include` names exactly one file, so the set of collected
 * files is fixed by construction and no sibling checkout can change it. There is also no
 * positional argument in the script any more — removing it removes the substring
 * semantics that caused the defect.
 *
 * WHY THE MAIN `vitest.config.ts` IS NOT REUSED. That config seeds a database URL into
 * every worker, runs a `setupFiles` module and a `globalSetup` that provisions Postgres.
 * The packaging gate installs tarballs and type-checks declarations; it needs none of
 * that, and inheriting it would make a networked packaging smoke test depend on a
 * reachable database. So this config stays deliberately tiny: one include, two excludes,
 * `globals`, and an explicit root. Nothing here may grow a `globalSetup`, `setupFiles` or
 * `env` block. `test/sdk/packaging.test.ts` is excluded in the main config, so `npm test`
 * never double-runs it.
 *
 * WHY `globals` IS ON, AND WHY IT IS NOT ONE OF THOSE FORBIDDEN BLOCKS. The gate calls
 * `test/fixtures/probe-stack-suite.ts`, which registers its suites through the bare
 * `describe` / `describe.skip` / `vi` globals rather than importing them, exactly as the
 * two row-backed suites that share it do. The main `vitest.config.ts` sets `globals: true`,
 * so those fixtures always had them; this config never did, and the gate never noticed
 * because it died earlier at the tarball INSTALL — `ETARGET` on the pinned
 * `@atomicstrata/llmwiki-core` — and never reached the fixture. Once the core collapse
 * (`odd/tasks/collapse-core-package.md`) made that install succeed, the gate reached
 * `createProbeSuite` and failed with `ReferenceError: describe is not defined`. `globals`
 * is a flags block, not one of the three forbidden ones, and it aligns this config with
 * the repository's own default instead of introducing a mechanism. The alternative —
 * editing the shared fixture to import its vitest globals — would touch every suite that
 * uses it, in order to fix one gate.
 */

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Repository root, resolved from this file's own location.
 *
 * Set explicitly instead of implied: a config's directory is only the default root, and
 * an `include` is resolved against the root. Deriving it from `import.meta.url` keeps the
 * pin correct no matter which directory the command was launched from, so the one
 * included path always means this repository's file.
 */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The only test file the packaging gate is allowed to collect. */
const PACKAGING_TEST_FILE = "test/sdk/packaging.test.ts";

export default defineConfig({
  root: REPO_ROOT,
  test: {
    // The pin: exactly one file, whichever sibling trees exist on disk.
    include: [PACKAGING_TEST_FILE],
    // The shared probe fixture registers its suites through the bare vitest globals; the
    // header records why this gate needs them and why it only needed them after the collapse.
    globals: true,
    // Both are defaults, restated so the intent survives a future default change:
    // installed dependencies and sibling worktree checkouts are never gate input.
    exclude: ["**/node_modules/**", "**/.worktrees/**"],
  },
});
