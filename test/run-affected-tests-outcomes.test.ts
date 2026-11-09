/**
 * @file Pin the four outcomes of `scripts/run-affected-tests.ts`, and the exit
 * status each one reports, without starting a single child process.
 *
 * WHY THIS FILE EXISTS. The module used to call its entry at import time, so no
 * test could import it: the first import would launch a real run. The entry now
 * takes the scope decision and the invocation runner as injected dependencies,
 * which makes all three statuses (`0`, `69`, `78`) and the exact bytes each
 * outcome prints assertable in milliseconds instead of minutes.
 *
 * The four outcomes are not interchangeable, and the difference is the point:
 *
 *   - `none` (exit 0) is a TRUE NEGATIVE: the computation succeeded and found
 *     nothing relevant.
 *   - `global` (exit 78) is a REFUSAL: a suite-wide change was resolved, and the
 *     full unit tier is declined rather than re-run, because it is a subset of
 *     `pnpm test`.
 *   - `unresolved` (exit 69) is a FAILED COMPUTATION: the base ref or the diff
 *     could not be produced. It must never borrow the `none` wording, or a broken
 *     computation would read as a clean run.
 *
 * NO CHILD-PROCESS CONSTRUCT HERE, DELIBERATELY. `scripts/test-partition.ts`
 * classifies a test file by its CONTENT, and a child-process token in this file
 * would exile the pin into the integration tier it exists to keep cheap. The
 * injected dependency is called an invocation runner, and nothing in this file
 * starts a process.
 */

import { describe, expect, it } from "vitest";
import {
  EXIT_FULL_TIER_DECLINED,
  EXIT_SCOPE_UNRESOLVED,
  runAffectedTests,
  type AffectedRunner,
} from "../scripts/run-affected-tests.js";

/** The full-tier refusal, byte for byte, including its `affected:` prefix. */
const FULL_TIER_LINE = 'affected: scope resolves to the full unit tier; run `pnpm test` instead\n';

/** The `none` message the module already printed before this change. */
const NOTHING_TO_RUN_LINE = "test-affected: nothing to run — no changes since origin/main\n";

/** A changed file the `files` outcome can select. */
const CHANGED = ["src/dimensions/activation.ts"];

/** The two ways the changed set fails to be computed, as the resolver reports them. */
const UNRESOLVED_REASONS = [
  "no canonical base ref (upstream/main or origin/main) could be resolved",
  "merge-base against origin/main failed",
  "diff against origin/main failed",
];

/**
 * A runner that records what it was handed instead of running it.
 * @returns The runner, plus the argv of every invocation set it received.
 */
function recordingRunner(): { runner: AffectedRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: AffectedRunner = (plan) => {
    calls.push(plan.map((invocation) => invocation.argv.join(" ")));
    return 0;
  };
  return { runner, calls };
}

/**
 * Run one case with stderr captured, so its exact bytes are assertable.
 * @param run - The call under test.
 * @returns The status it reported and everything it wrote to stderr.
 */
function withStderr(run: () => number): { status: number; text: string } {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { status: run(), text: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

describe("a resolved full unit tier is declined, never re-run", () => {
  it("exits 78 with the exact line and runs nothing", () => {
    const { runner, calls } = recordingRunner();
    const scope = { kind: "global", reason: "package.json affects the whole suite" } as const;
    const result = withStderr(() => runAffectedTests([], { scope, runner }));

    expect(EXIT_FULL_TIER_DECLINED).toBe(78);
    expect(result.status).toBe(78);
    expect(result.text).toBe(FULL_TIER_LINE);
    expect(calls).toEqual([]);
  });
});

describe("a change set that could not be computed is never reported as `none`", () => {
  it.each(UNRESOLVED_REASONS)("exits 69 naming the failed step for %s, and runs nothing", (reason) => {
    const { runner, calls } = recordingRunner();
    const result = withStderr(() => runAffectedTests([], { scope: { kind: "unresolved", reason }, runner }));

    expect(EXIT_SCOPE_UNRESOLVED).toBe(69);
    expect(result.status).toBe(69);
    expect(result.text).toContain("could not compute");
    expect(result.text).toContain(reason);
    expect(result.text).not.toContain("scope resolves");
    expect(result.text).not.toContain("nothing to run");
    expect(calls).toEqual([]);
  });
});

describe("a successful computation that finds nothing relevant stays a true negative", () => {
  it("exits 0 with its existing message and runs nothing", () => {
    const { runner, calls } = recordingRunner();
    const scope = { kind: "none", reason: "no changes since origin/main" } as const;
    const result = withStderr(() => runAffectedTests([], { scope, runner }));

    expect(result.status).toBe(0);
    expect(result.text).toBe(NOTHING_TO_RUN_LINE);
    expect(calls).toEqual([]);
  });
});

describe("a `files` scope still runs the related selection", () => {
  it("hands the runner one plan whose first invocation is the related run", () => {
    const { runner, calls } = recordingRunner();
    const result = withStderr(() => runAffectedTests([], { scope: { kind: "files", files: CHANGED }, runner }));

    expect(result.status).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toContain("related ");
    expect(calls[0]?.[0]).toContain(CHANGED[0]);
    expect(result.text).toContain("1 changed file(s); running related tests only");
  });
});
