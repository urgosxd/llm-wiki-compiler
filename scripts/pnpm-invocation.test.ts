/**
 * @file Prove pnpm is found by execution, not by name.
 *
 * The defect these tests pin: both `scripts/run-affected-tests.ts` and
 * `.husky/pre-commit` used to spawn the bare program name `pnpm`. A name that
 * RESOLVES is not a name that WORKS — on this machine the global launcher is a
 * shell wrapper whose `exec` target was deleted, so `pnpm --version` exits 127
 * while `command -v pnpm` succeeds. Every gate that relied on the bare name was
 * therefore red for every branch and required a hand-built PATH shim to run at
 * all, which is how a gate stops being a gate.
 *
 * Everything here is asserted through the public surfaces the gate actually
 * uses: the resolver's command line, and the committed hook's own bytes. A
 * candidate only counts as working when it EXITS 0, so the fakes are real
 * spawnable executables that really fail — a `which`-style implementation
 * cannot pass these tests, which is the property worth pinning.
 *
 * `scripts/test-partition.ts` classifies this file as integration because it
 * contains `spawnSync`, which is correct: it is only meaningful when a child
 * process actually starts.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildPnpmCandidates, describeFailure } from "./pnpm-invocation.ts";

/** Repository root, so a test can name the real resolver and the real hook. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RESOLVER = path.join(REPO_ROOT, "scripts", "pnpm-invocation.ts");
const HOOK = path.join(REPO_ROOT, ".husky", "pre-commit");

/** Printed by the working fake, so a pass proves it was the program that ran. */
const SENTINEL = "fake-pnpm-third-candidate";

/** Named by the failure message: one line per candidate that was tried. */
const CANDIDATE_LABELS = ["npm_execpath", "corepack pnpm", "node_modules/.bin/pnpm", "pnpm"];

/** A real, spawnable program that answers the way the broken launcher does. */
const EXIT_127 = "#!/bin/sh\nexit 127\n";

/** Every temporary root this file created, removed in `afterEach`. */
const scratchRoots: string[] = [];

/** A throwaway root outside the worktree, cleaned up by `afterEach`. */
function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pnpm-invocation-"));
  scratchRoots.push(root);
  return root;
}

/** Write a fake that is executable regardless of the ambient umask. */
function writeFake(file: string, body: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

/**
 * An environment where nothing named `pnpm` works.
 *
 * Candidate 1 points at a `node` script called `pnpm.cjs` that exits 127, and the
 * first entries on PATH are `sh` fakes for `corepack` and `pnpm` that do the
 * same. `node` is forwarded to this run's own binary so the only variable under
 * test is how pnpm is resolved — a fake `node` would make the result say nothing
 * about pnpm.
 * @param root - Temporary root the fakes are written under.
 */
function hostileEnv(root: string): NodeJS.ProcessEnv {
  const bin = path.join(root, "poison-bin");
  writeFake(path.join(bin, "corepack"), EXIT_127);
  writeFake(path.join(bin, "pnpm"), EXIT_127);
  writeFake(path.join(bin, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  return {
    ...process.env,
    npm_execpath: writeFake(path.join(root, "npm-execpath", "pnpm.cjs"), "process.exit(127);\n"),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

/** Run the resolver exactly as the gates run it: `node …/pnpm-invocation.ts <args>`. */
function runResolver(root: string, env: NodeJS.ProcessEnv, args: readonly string[]) {
  return spawnSync(process.execPath, [RESOLVER, ...args], { cwd: root, env, encoding: "utf8" });
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pnpm-invocation — resolve by executing, not by name", () => {
  it("falls through to the local pnpm when npm_execpath and corepack both fail", () => {
    const root = makeRoot();
    const env = hostileEnv(root);
    writeFake(path.join(root, "node_modules", ".bin", "pnpm"), `#!/bin/sh\necho ${SENTINEL}\nexit 0\n`);

    const resolver = runResolver(root, env, ["--version"]);

    expect(resolver.status).toBe(0);
    expect(resolver.stdout).toContain(SENTINEL);
    // The defect in one line: the bare name resolves and still exits 127.
    expect(spawnSync("pnpm", ["--version"], { cwd: root, env, encoding: "utf8" }).status).toBe(127);
  });

  it("names every candidate and its failure when none of them work", () => {
    const root = makeRoot();
    const env = hostileEnv(root);
    writeFake(path.join(root, "node_modules", ".bin", "pnpm"), EXIT_127);

    const resolver = runResolver(root, env, ["--version"]);

    expect(resolver.status).not.toBe(0);
    expect(resolver.stdout).toBe("");
    expect(resolver.stderr).toContain("pnpm-invocation: no working pnpm found (tried 4 candidates):");
    for (const label of CANDIDATE_LABELS) expect(resolver.stderr).toContain(label);
    expect(resolver.stderr.match(/exited 127/gu)).toHaveLength(4);
    expect(resolver.stderr).toContain("corepack enable pnpm");
  });
});

describe("pnpm-invocation — the candidate order is the contract", () => {
  it("keeps the defined order and skips npm_execpath when it is not pnpm", () => {
    const withPnpm = buildPnpmCandidates({ root: "/repo", npmExecPath: "/corepack/pnpm.cjs" });
    expect(withPnpm.map((candidate) => candidate.label)).toEqual([
      "npm_execpath (/corepack/pnpm.cjs)",
      "corepack pnpm",
      "node_modules/.bin/pnpm",
      "pnpm",
    ]);
    // Spawning node on the script keeps candidate 1 free of the exec bit and of any sh wrapper.
    expect(withPnpm[0].command).toBe(process.execPath);
    expect(withPnpm[0].args).toEqual(["/corepack/pnpm.cjs"]);

    const withNpm = buildPnpmCandidates({ root: "/repo", npmExecPath: "/usr/bin/npm-cli.js" });
    expect(withNpm.map((candidate) => candidate.rank)).toEqual([2, 3, 4]);
  });
});

describe("pnpm-invocation — the failure message is the contract", () => {
  it("names every tried candidate, its reason, and one actionable line", () => {
    const message = describeFailure([
      { label: "corepack pnpm", reason: "exited 127" },
      { label: "pnpm", reason: "not found (ENOENT)" },
    ]);

    expect(message).toBe(
      [
        "pnpm-invocation: no working pnpm found (tried 2 candidates):",
        "  1. corepack pnpm — exited 127",
        "  2. pnpm — not found (ENOENT)",
        "Install pnpm (e.g. `corepack enable pnpm`) or fix the pnpm on PATH.",
        "",
      ].join("\n"),
    );
  });
});

describe("pnpm-invocation — the hook routes through the resolver", () => {
  it("keeps the gate order and never invokes a bare pnpm program", () => {
    const commands = hookCommands(readFileSync(HOOK, "utf8"));
    expect(commands).toEqual([
      "node scripts/pnpm-invocation.ts run fallow:ci",
      "node scripts/pnpm-invocation.ts exec tsc --noEmit",
    ]);
    for (const line of commands) expect(line).not.toMatch(/^(\.\/)?pnpm(\s|$)/u);
  });

  it("fails loudly instead of reaching the gates when nothing resolves", () => {
    const root = makeRoot();
    const env = hostileEnv(root);
    // An inapplicable candidate is not tried, so candidate 1 is absent here.
    delete env.npm_execpath;
    copyIntoRoot(root);
    writeFake(path.join(root, "node_modules", ".bin", "pnpm"), EXIT_127);

    const hook = spawnSync("sh", ["-e", ".husky/pre-commit"], { cwd: root, env, encoding: "utf8" });

    expect(hook.status).not.toBe(0);
    expect(hook.stderr).toContain("pnpm-invocation: no working pnpm found (tried 3 candidates):");
    expect(hook.stderr).toContain("node_modules/.bin/pnpm — exited 127");
    expect(hook.stderr).toContain("corepack pnpm — exited 127");
    // Fast and loud: resolution failed, so no gate was started.
    expect(hook.stdout).not.toContain("fallow");
  });
});

/** The hook's executable lines, with comments and blank lines dropped. */
function hookCommands(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * Reproduce the hook's working directory so the resolver it names really exists.
 *
 * The hook runs from the repository root and shells out to `scripts/`, so a
 * temporary root has to carry that tree for the failure path to be the
 * resolver's rather than the shell's "no such file".
 * @param root - Temporary root to populate.
 */
function copyIntoRoot(root: string): void {
  mkdirSync(path.join(root, ".husky"), { recursive: true });
  copyFileSync(HOOK, path.join(root, ".husky", "pre-commit"));
  cpSync(path.join(REPO_ROOT, "scripts"), path.join(root, "scripts"), { recursive: true });
}
