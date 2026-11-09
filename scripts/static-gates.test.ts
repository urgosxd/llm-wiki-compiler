/**
 * @file Pin the set of gates the concurrent static-gate runner executes.
 *
 * WHY THIS FILE EXISTS. A command whose job is "run the static gates" is one
 * constant away from quietly running fewer of them: delete one entry from the
 * gate list and every run stays green while a whole class of checks stops
 * happening, in the exact failure shape this repository keeps deleting — a gate
 * that looks green because it declined to look. So the set is pinned twice,
 * against repository evidence rather than against itself: every gate that runs a
 * `package.json` script must name a script that file actually declares, and
 * every gate `AGENTS.md` numbers must be either covered or explicitly excluded
 * here. A gate deleted from the runner, or added to the repository, fails this
 * file instead of passing unnoticed.
 *
 * NO CHILD-PROCESS CONSTRUCT HERE, DELIBERATELY. `scripts/test-partition.ts`
 * classifies a test file by its CONTENT, and one process-starting token would
 * exile this pin into the slow integration tier it exists to keep cheap.
 * Everything below is a file read.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATE_TIMEOUT_MS, STATIC_GATES } from "./static-gates.ts";

/** The gate labels this runner must always carry, in report order. */
const EXPECTED_LABELS = ["tsc", "typecheck:tests", "typecheck:kg", "lint", "fallow:ci", "fallow:kg"] as const;

/**
 * The numbered `AGENTS.md` gates that stay out of the concurrent set.
 *
 * `build` is ordering, not independence: it must finish before anything that
 * spawns `dist/`. `test:affected` is a local selection tool, not a static check.
 */
const EXCLUDED_NUMBERED_GATES = ["pnpm run build", "pnpm run test:affected"] as const;

/** The repository root, resolved from this file's URL so no assertion depends on the working directory. */
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Read a file by its path relative to the repository root. */
function repositoryText(relative: string): string {
  return readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");
}

/** The `scripts` map of `package.json`, read without executing anything. */
function packageScripts(): Record<string, string> {
  return (JSON.parse(repositoryText("package.json")) as { scripts: Record<string, string> }).scripts;
}

/** The gate commands an `AGENTS.md` numbered list names, in order — the same anchors `test/control-gates.test.ts` reads. */
function numberedGateCommands(text: string): string[] {
  return [...text.matchAll(/^\d+\. `([^`]+)`/gm)].flatMap((match) => (match[1] ? [match[1]] : []));
}

/** The pnpm arguments a numbered gate command is spelled with, e.g. `exec tsc --noEmit`. */
function argsOf(command: string): string[] {
  return command.replace(/^pnpm /, "").split(" ");
}

describe("static gates — the set cannot shrink silently", () => {
  it("declares exactly the six independent gates, in report order", () => {
    expect(STATIC_GATES.map((gate) => gate.label)).toEqual([...EXPECTED_LABELS]);
  });

  it("runs a script package.json really declares, for every gate that names one", () => {
    const scripts = packageScripts();
    const runGates = STATIC_GATES.filter((gate) => gate.args[0] === "run");
    // Every gate but the compiler one is a `pnpm run <script>`; a shrunken set
    // has to fail here even if someone edits EXPECTED_LABELS to match it.
    expect(runGates).toHaveLength(EXPECTED_LABELS.length - 1);
    for (const gate of runGates) {
      const [, script] = gate.args;
      expect(script).toBe(gate.label);
      expect(scripts[String(script)]).toBeTypeOf("string");
    }
  });

  it("covers every numbered gate in AGENTS.md, or names why it stays out", () => {
    const numbered = numberedGateCommands(repositoryText("AGENTS.md"));
    expect(numbered).toContain("pnpm run build");
    for (const command of numbered) {
      if ((EXCLUDED_NUMBERED_GATES as readonly string[]).includes(command)) continue;
      const wanted = argsOf(command).join(" ");
      const matching = STATIC_GATES.filter((gate) => gate.args.join(" ") === wanted);
      expect(matching, `${command} is numbered in AGENTS.md but no static gate runs it`).toHaveLength(1);
    }
  });

  it("keeps build and test:affected out of the concurrent set", () => {
    const commands = STATIC_GATES.map((gate) => gate.args.join(" "));
    expect(commands).not.toContain("run build");
    expect(commands).not.toContain("run test:affected");
  });

  it("keeps the compiler gate on --noEmit, so no gate can write build output", () => {
    const tsc = STATIC_GATES.find((gate) => gate.label === "tsc");
    expect(tsc?.args).toEqual(["exec", "tsc", "--noEmit"]);
  });

  it("bounds every gate well past the slowest one measured", () => {
    // 12.5 s is the slowest gate measured on this host; a bound that close would
    // turn a loaded machine into a false failure instead of a stuck gate.
    expect(GATE_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});
