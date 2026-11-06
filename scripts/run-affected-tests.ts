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
 * EVERY outcome also runs the output contracts listed in
 * {@link OUTPUT_CONTRACT_TESTS}; `scripts/output-contracts.ts` explains why that
 * list exists and how to justify an entry. Which invocations that produces is
 * decided by the pure `planAffectedInvocations`, so the coverage is asserted by
 * `scripts/output-contracts.test.ts` without spawning anything.
 *
 * The full suite is deliberately NOT one of these outcomes: CI runs it on every
 * push (`.github/workflows/ci.yml`), and duplicating it locally is the cost this
 * hook exists to remove. `npm test` still runs it on demand.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readRoot } from "./cli-root.ts";
import { OUTPUT_CONTRACT_TESTS, planAffectedInvocations, type VitestInvocation } from "./output-contracts.ts";
import { classifyTests, partition } from "./test-partition.ts";
import { resolveAffectedScope, type AffectedScope } from "./test-affected.ts";

/**
 * Spawn a command, inheriting stdio so the hook shows real progress.
 * @param root - Repository root, used as the child's cwd.
 * @param command - Executable to start.
 * @param args - Arguments for that executable.
 * @param label - Human name for the command, used in the failure message.
 * @returns The child's exit status, or 1 when it could not be started.
 */
function spawnInherit(
  root: string,
  command: string,
  args: readonly string[],
  label: string,
): number {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`test-affected: could not start ${label} — ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Run vitest.
 * @param root - Repository root.
 * @param argv - Full argv AFTER the `vitest` binary (`run …` or `related …`).
 */
function runVitest(root: string, argv: readonly string[]): number {
  return spawnInherit(root, "npx", ["vitest", ...argv], "vitest");
}

/**
 * Build `dist/` when a contract file needs it and it is absent.
 *
 * The output contracts spawn `node dist/cli.js`, so a checkout that was never
 * built cannot run them. Skipping them would turn a real byte-contract check
 * into a silent no-op, so this BUILDS ONCE instead, and a failing build fails
 * the hook. (vitest's own `globalSetup` also builds; this covers the case where
 * the contract list is the reason a build is needed at all.)
 *
 * @param root - Repository root.
 * @returns Process status: 0 when a build was unnecessary or succeeded.
 */
function ensureBuiltCli(root: string): number {
  if (OUTPUT_CONTRACT_TESTS.length === 0 || existsSync(path.join(root, "dist", "cli.js"))) return 0;
  process.stderr.write(
    "test-affected: dist/cli.js is missing — running `npm run build` once for the output contracts\n",
  );
  return spawnInherit(root, "npm", ["run", "build"], "the build");
}

/**
 * Report the tier the scope selected.
 *
 * @param root - Repository root.
 * @param scope - The resolved scope; `none` is handled by the caller.
 * @returns The unit tier's files for a `global` scope, otherwise an empty list.
 */
function announceTier(root: string, scope: AffectedScope): string[] {
  if (scope.kind === "global") {
    // No root argument: the classification default enumerates every test tree,
    // so the escalation tier cannot silently narrow to `test/` again.
    const unitFiles = partition(classifyTests(root)).unit;
    process.stderr.write(`test-affected: full unit tier — ${scope.reason}\n`);
    process.stderr.write(`test-affected: ${unitFiles.length} unit file(s)\n`);
    return unitFiles;
  }
  if (scope.kind === "files") {
    process.stderr.write(
      `test-affected: ${scope.files.length} changed file(s); running related tests only\n`,
    );
  }
  return [];
}

/** Say which output contracts the run adds, so the extra work is auditable. */
function announceContracts(plan: readonly VitestInvocation[]): void {
  const added = [...new Set(plan.flatMap((invocation) => invocation.addedContracts))];
  if (added.length === 0) return;
  process.stderr.write(`test-affected: adding output-contract file(s) — ${added.join(", ")}\n`);
}

/**
 * Run every planned invocation.
 *
 * A failure does not stop the remaining ones — the next invocation may show that
 * the failure is isolated — but the first failing status is the one returned.
 */
function runPlan(root: string, plan: readonly VitestInvocation[]): number {
  let status = 0;
  for (const invocation of plan) {
    const code = runVitest(root, invocation.argv);
    if (code !== 0 && status === 0) status = code;
  }
  return status;
}

/** Entry point: resolve the scope, then run exactly what it selects plus the contracts. */
function main(argv: readonly string[]): number {
  const root = readRoot(argv);
  const scope = resolveAffectedScope(root);

  if (scope.kind === "none") {
    process.stderr.write(`test-affected: nothing to run — ${scope.reason}\n`);
    return 0;
  }

  const plan = planAffectedInvocations(scope, announceTier(root, scope));
  announceContracts(plan);

  const buildStatus = ensureBuiltCli(root);
  if (buildStatus !== 0) return buildStatus;

  return runPlan(root, plan);
}

process.exitCode = main(process.argv.slice(2));
