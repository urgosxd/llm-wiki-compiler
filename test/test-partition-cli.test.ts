/**
 * @file Pin the tier CLI that `package.json` actually consumes, not only the
 * library behind it.
 *
 * `test:unit` and `test:integration` are not wrappers around
 * `scripts/test-partition.ts`; they are COMMAND SUBSTITUTIONS:
 * `vitest run $(node scripts/test-partition.ts unit | tr '\n' ' ')`. Whatever
 * that process writes to stdout becomes vitest's file arguments, split on
 * whitespace. The printed list is therefore a public interface with two failure
 * modes that no library-level test can see.
 *
 * 1. THE PRINT DRIFTS FROM THE PARTITION. Every other test in this repo asserts
 *    against `partition(classifyTests(...))` — the very function the CLI calls —
 *    so a tree dropped from the enumeration makes the test and the CLI agree
 *    with each other while `test:unit` runs the wrong files. An extra path, a
 *    dropped path, or reordered output all leave a green suite behind an
 *    `npm run test:unit` that runs something else.
 * 2. THE PRINT GROWS A SHAPE THE SUBSTITUTION CANNOT SURVIVE. `tr '\n' ' '`
 *    translates newlines only, so a header line, a blank line or a trailing
 *    space becomes an argument vitest reads as a test file that does not exist.
 *
 * Everything here spawns the real script with `execFileSync(process.execPath,
 * …)` and the repository root as cwd: the same invocation `package.json`
 * performs, minus the shell. The assertion is exact array equality, and both
 * directions of divergence are named separately, because "the lists have the
 * same length" is precisely the check that lets a substitution pass.
 *
 * BOTH DIMENSIONS ARE ASSERTED THROUGH THAT INTERFACE. The shipped defect was a
 * tier that enumerated `test/` alone while reporting success for the kg suites
 * it never looked at. The printed unit list — the one `package.json` feeds to
 * vitest — is required to carry at least one `test/` path and at least one
 * `packages/llmwiki-kg/` path, which is the two-dimensional property as the
 * shipped script reports it rather than as the library describes itself.
 *
 * TIER: this file spawns a child process, so content classification puts it in
 * `integration`. That is deliberate — `npm test` and `npm run test:integration`
 * are its home, and the fast `test:unit` loop, one of the two lists it guards,
 * does not pay for it.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyTests, partition } from "../scripts/test-partition.js";

const ROOT = path.resolve(".");

/** The script `package.json` substitutes into `vitest run …`, repo-relative. */
const CLI_SCRIPT = "scripts/test-partition.ts";

/** The two tier names the CLI accepts, in the order `package.json` uses them. */
const TIER_NAMES = ["unit", "integration"] as const;

type TierName = (typeof TIER_NAMES)[number];

/** Prefix of the root dimension's test tree. */
const ROOT_TREE = "test/";

/** Prefix of the kg dimension's test tree, the one the defect made invisible. */
const KG_TREE = "packages/llmwiki-kg/";

/**
 * Every path the CLI may print: a repo-relative `*.test.ts` under a declared
 * root. Anchored, because `package.json` passes these strings to vitest as
 * arguments and an absolute path or a bare word is a different program.
 */
const PRINTED_PATH = /^(test|packages|src|scripts)\/.*\.test\.ts$/;

/** The library's answer, computed once: what the CLI is required to print. */
const TIERS = partition(classifyTests(ROOT));

/**
 * Run the real CLI for one tier and return its raw stdout.
 *
 * `encoding: "utf8"` keeps the output comparable as text, and an uncaught
 * non-zero exit is the correct result here: a CLI that cannot print a tier is a
 * broken `test:unit`, so the failure belongs in the test rather than in a
 * skipped branch.
 *
 * @param tier - Tier name to ask for.
 * @returns Exactly what `package.json`'s substitution would capture.
 */
function printTier(tier: TierName): string {
  return execFileSync(process.execPath, [CLI_SCRIPT, tier], { cwd: ROOT, encoding: "utf8" });
}

const PRINTED: Record<TierName, string> = {
  unit: printTier("unit"),
  integration: printTier("integration"),
};

/**
 * Split captured stdout into the arguments the substitution would produce.
 *
 * This is `$(...)` word-splitting, not a trim: an empty line is dropped by the
 * shell, so it is dropped here too and asserted separately below. A line with
 * inner whitespace would split into two arguments and is kept intact on purpose,
 * so the shape test can name it.
 *
 * @param stdout - Raw captured stdout.
 * @returns One entry per non-empty line.
 */
function printedLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

/**
 * The two independent ways a printed list can disagree with the library.
 *
 * Kept as a named pair instead of a boolean so a failure carries the paths, and
 * so the non-tautology test below can drive the same predicate with deliberately
 * broken lists.
 *
 * @param printed - Paths the CLI printed.
 * @param computed - Paths the library classified into that tier.
 * @returns `extra` = printed only, `missing` = computed only.
 */
function divergence(printed: readonly string[], computed: readonly string[]): { extra: string[]; missing: string[] } {
  const printedSet = new Set(printed);
  const computedSet = new Set(computed);
  return {
    extra: printed.filter((file) => !computedSet.has(file)),
    missing: computed.filter((file) => !printedSet.has(file)),
  };
}

describe("the tier CLI prints exactly the library's partition", () => {
  it.each(TIER_NAMES)("prints the %s tier as the same exact array", (tier) => {
    const computed = TIERS[tier];
    const printed = printedLines(PRINTED[tier]);
    expect(computed.length, `the ${tier} tier must be non-empty for this to assert anything`).toBeGreaterThan(0);
    const { extra, missing } = divergence(printed, computed);
    expect(extra, `printed but absent from the library ${tier} tier: ${extra.join(", ")}`).toEqual([]);
    expect(missing, `in the library ${tier} tier but never printed: ${missing.join(", ")}`).toEqual([]);
    expect(printed, `the printed ${tier} tier must keep the library's order`).toEqual(computed);
  });

  it("prints both dimensions in the unit tier package.json runs", () => {
    const printed = printedLines(PRINTED.unit);
    const rootFiles = printed.filter((file) => file.startsWith(ROOT_TREE));
    const kgFiles = printed.filter((file) => file.startsWith(KG_TREE));
    expect(rootFiles.length, `no root ${ROOT_TREE} suites were printed`).toBeGreaterThan(0);
    expect(kgFiles.length, `no ${KG_TREE} suites were printed — the tier covers one dimension`).toBeGreaterThan(0);
  });
});

describe("the printed shape survives the shell substitution", () => {
  it.each(TIER_NAMES)("emits one repo-relative path per line for %s and nothing else", (tier) => {
    const stdout = PRINTED[tier];
    expect(stdout.endsWith("\n"), "stdout must end with exactly one newline").toBe(true);
    expect(stdout.endsWith("\n\n"), "a trailing blank line becomes an empty argument").toBe(false);
    expect(stdout.includes("\r"), "a carriage return would survive into a file argument").toBe(false);
    const malformed = printedLines(stdout).filter(
      (line) => line !== line.trim() || !PRINTED_PATH.test(line),
    );
    expect(malformed, `stdout carries something other than a path: ${malformed.join(" | ")}`).toEqual([]);
  });

  it("flags a printed path the library does not compute, and one it never printed", () => {
    const computed = TIERS.unit;
    const surplus = [...printedLines(PRINTED.unit), "test/fabricated-by-this-test.test.ts"];
    const narrowed = printedLines(PRINTED.unit).slice(1);
    expect(divergence(surplus, computed).extra).toEqual(["test/fabricated-by-this-test.test.ts"]);
    expect(divergence(narrowed, computed).missing).toEqual([computed[0]]);
    expect(surplus, "an extra printed path must not compare equal").not.toEqual(computed);
    expect(narrowed, "a dropped printed path must not compare equal").not.toEqual(computed);
  });
});
