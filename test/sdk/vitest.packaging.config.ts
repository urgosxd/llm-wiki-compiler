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
 * and an explicit root. Nothing here may grow a `globalSetup`, `setupFiles` or `env`
 * block. `test/sdk/packaging.test.ts` is excluded in the main config, so `npm test`
 * never double-runs it.
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
    // Both are defaults, restated so the intent survives a future default change:
    // installed dependencies and sibling worktree checkouts are never gate input.
    exclude: ["**/node_modules/**", "**/.worktrees/**"],
  },
});
