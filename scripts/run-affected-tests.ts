/**
 * @file Execute the test selection decided by `scripts/test-affected.ts`.
 *
 * Kept separate from the resolver so the scoping logic stays a pure, testable
 * function while this module owns the one impure step: spawning vitest. The
 * split also keeps each file under the size budget.
 *
 * Three outcomes, matching {@link AffectedScope}:
 *
 *   - `files`  → `vitest related <changed files>`, which runs only tests that
 *                import them.
 *   - `global` → the whole `test:unit` tier, because a build/test-config change
 *                can reach any file and a narrow selection would be a lie.
 *   - `none`   → exit 0 without running anything.
 *
 * The full suite is deliberately NOT one of these outcomes: CI runs it on every
 * push (`.github/workflows/ci.yml`), and duplicating it locally is the cost this
 * hook exists to remove. `npm test` still runs it on demand.
 */

import { spawnSync } from "node:child_process";
import { readRoot } from "./cli-root.ts";
import { classifyTests, partition, TEST_DIR } from "./test-partition.ts";
import { resolveAffectedScope } from "./test-affected.ts";

/**
 * Run vitest, inheriting stdio so the hook shows real progress.
 * @param root - Repository root.
 * @param argv - Full argv AFTER the `vitest` binary (`run …` or `related …`).
 */
function runVitest(root: string, argv: readonly string[]): number {
  const result = spawnSync("npx", ["vitest", ...argv], { cwd: root, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`test-affected: could not start vitest — ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/** Run the whole spawn-free tier, used when a change has suite-wide reach. */
function runUnitTier(root: string): number {
  const files = partition(classifyTests(root, TEST_DIR)).unit;
  process.stderr.write(`test-affected: ${files.length} unit file(s)\n`);
  return runVitest(root, ["run", ...files]);
}

/** Entry point: resolve the scope, then run exactly that. */
function main(argv: readonly string[]): number {
  const root = readRoot(argv);
  const scope = resolveAffectedScope(root);

  if (scope.kind === "none") {
    process.stderr.write(`test-affected: nothing to run — ${scope.reason}\n`);
    return 0;
  }
  if (scope.kind === "global") {
    process.stderr.write(`test-affected: full unit tier — ${scope.reason}\n`);
    return runUnitTier(root);
  }
  process.stderr.write(
    `test-affected: ${scope.files.length} changed file(s); running related tests only\n`,
  );
  // `related` is a vitest SUBCOMMAND, not a flag after `run`.
  return runVitest(root, ["related", ...scope.files]);
}

process.exitCode = main(process.argv.slice(2));
