/**
 * @file Pin the boundary notice `scripts/package-tasks.ts` prints before a selective `test` run.
 *
 * S5 of `odd/tasks/selection-type-and-url-edges.md` says the notice is ONE printed line,
 * on the affected flow only. That is a developer-facing claim, and until this file existed
 * nothing committed held it: the message could have been deleted, doubled, or printed for
 * every package with every gate still green. It is the only place a developer is told that
 * a selective green does not speak for a type-only dependent, so it is pinned byte for byte.
 *
 * WHY THIS IS NOT IN `test/package-task-selection.test.ts`. That file pins the task surface
 * as DATA with `node:` imports only, which is exactly why it is a frozen `orphan` in
 * `test/package-selection-union.test.ts`. Importing `../scripts/package-tasks.js` from it
 * would attribute it to the `meta` bucket and delete one entry of the 29-name frozen pin —
 * a census move this slice must not make for a test of a message.
 *
 * WHY IT DOES NOT SPAWN THE CLI. A `test` invocation derives the selection and then runs
 * vitest over 565 files, so a contract test that spawned it would cost a full suite run.
 * `scripts/output-contracts.ts` states the rule this follows: "If a spawn-free assertion can
 * pin the same contract, add it to the unit tier instead and do NOT list the file here." So
 * the printer is exported and driven directly, with the repository's own `captureProcessIo`
 * helper recording what it wrote.
 *
 * WHAT THE THIRD AND FOURTH CASES ARE FOR. The exact-string case pins the message; it does
 * not pin that the message still describes the declaration it summarizes, nor that `main`
 * calls it on the `test` flow only. Both are cheap to assert and both can regress silently.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PACKAGE_SURFACES, TYPE_ONLY_DEPENDENTS, type PackageSurface } from "../scripts/package-selection.js";
import { reportTypeOnlyDependents } from "../scripts/package-tasks.js";
import { captureProcessIo } from "./fixtures/process-io.js";

/** Absolute repository root, from this test file's location. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The exact line the notice must print for `@repo/wiki`, trailing newline included.
 *
 * Written out rather than composed from the declaration on purpose: a message assembled
 * from the same data it announces would agree with any rewording, and the point of pinning
 * a developer-facing sentence is that a human reading the diff sees the sentence change.
 * The case below also checks it still agrees with the declaration, so the pin cannot rot
 * in silence in the other direction.
 */
const WIKI_NOTICE =
  "package-tasks: @repo/wiki has 3 declared type-only dependent test(s) this selection cannot " +
  "observe (test/provenance-metadata-shape.test.ts, test/query-candidate-id-absent.test.ts, " +
  "test/sdk/published-dimensions-port.test.ts); root `typecheck:tests` is the covering tier\n";

/** The declared surface for a package name, failing loudly rather than returning undefined. */
function surfaceNamed(name: string): PackageSurface {
  const surface = PACKAGE_SURFACES.find((entry) => entry.name === name);
  if (surface === undefined) throw new Error(`no declared package surface named ${name}`);
  return surface;
}

/** The printed call sites in `scripts/package-tasks.ts`, trimmed, so wiring is visible as data. */
function noticeCallSites(): string[] {
  const source = readFileSync(path.join(REPO_ROOT, "scripts", "package-tasks.ts"), "utf8");
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("reportTypeOnlyDependents(") && !line.includes("function "));
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("prints exactly one line, naming the count, the three files and the covering tier", () => {
  const io = captureProcessIo();
  reportTypeOnlyDependents(surfaceNamed("@repo/wiki"));
  expect(io.err()).toBe(WIKI_NOTICE);
  expect(io.out()).toBe("");
});

it("prints nothing at all for a package with no declared type-only dependents", () => {
  const declared = TYPE_ONLY_DEPENDENTS.filter((entry) => entry.packageName === "@repo/api");
  expect(declared).toEqual([]);
  const io = captureProcessIo();
  reportTypeOnlyDependents(surfaceNamed("@repo/api"));
  expect(io.err()).toBe("");
  expect(io.out()).toBe("");
});

it("keeps the pinned notice agreeing with the declaration it summarizes", () => {
  const declared = TYPE_ONLY_DEPENDENTS.filter((entry) => entry.packageName === "@repo/wiki");
  expect(declared.length).toBe(3);
  expect(WIKI_NOTICE).toContain(`has ${declared.length} declared type-only dependent test(s)`);
  expect(WIKI_NOTICE).toContain("root `typecheck:tests` is the covering tier");
  for (const entry of declared) expect(WIKI_NOTICE).toContain(entry.testFile);
});

it("calls the notice from the test flow only", () => {
  expect(noticeCallSites()).toEqual(['if (task === "test") reportTypeOnlyDependents(surface);']);
});
