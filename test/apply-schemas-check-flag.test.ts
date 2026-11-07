/**
 * `scripts/apply-schemas.sh` advertises `--check` as its verify-only mode, so the flag
 * must reach the runner as a MODE and never as a connection string.
 *
 * Every case below deliberately supplies no database: the assertions are about which
 * branch of the script runs, and the branches are distinguishable before any connection
 * is attempted. A missing target prints the configuration message; a target that cannot
 * be reached prints the connection message. Treating `--check` as a target falls into the
 * second, which is the defect these cases pin.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/apply-schemas.sh";
const NO_TARGET = "error: no target. Pass a connection string or set DATABASE_URL.";
const CANNOT_CONNECT = "error: cannot connect to the database.";

/**
 * Run the runner with a scrubbed environment, so the developer's own `DATABASE_URL`,
 * `PSQL` or `CHECK_ONLY` cannot decide the outcome.
 *
 * @param args - Arguments to pass to the script, exactly as a user would.
 * @param extraEnv - Variables the case under test supplies on purpose.
 * @returns The exit status, stdout and stderr of that run.
 */
function run(args: readonly string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...env, ...extraEnv },
  });
}

describe("apply-schemas.sh --check", () => {
  it("reads --check as the verify mode, not as the target", () => {
    const result = run(["--check"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(NO_TARGET);
    expect(result.stderr).not.toContain(CANNOT_CONNECT);
  });

  it("keeps the CHECK_ONLY form CI runs working", () => {
    const result = run([], { CHECK_ONLY: "true" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(NO_TARGET);
  });

  it("still treats a positional argument as the connection target", () => {
    const result = run(["postgresql://aks:aks@127.0.0.1:1/aks"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(CANNOT_CONNECT);
  });
});
