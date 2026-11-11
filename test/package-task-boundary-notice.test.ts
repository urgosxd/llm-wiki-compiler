/**
 * @file Pin the boundary notice `scripts/package-tasks.ts` prints before a selective `test` run.
 *
 * S5 of `odd/tasks/selection-type-and-url-edges.md` says the notice is ONE printed line, on the
 * affected flow only. That is a developer-facing claim, and nothing committed held it until this
 * file existed: the message could have been deleted, doubled, or printed for every package with
 * every gate still green. It is the only place a developer is told that a selective green does
 * not speak for a type-only dependent, so it is pinned byte for byte.
 *
 * WHY THIS IS NOT IN `test/package-task-selection.test.ts`. That file pins the task surface as
 * DATA with `node:` imports only, which is exactly why it is a frozen `orphan` in
 * `test/package-selection-union.test.ts`. Importing `../scripts/package-tasks.js` from it would
 * attribute it to the `meta` bucket and delete one entry of the 29-name frozen pin.
 *
 * WHY IT DOES NOT SPAWN THE CLI. A `test` invocation derives the selection and then runs vitest
 * over 565 files, so a contract test that spawned it would cost a full suite run.
 * `scripts/output-contracts.ts` states the rule this follows: "If a spawn-free assertion can pin
 * the same contract, add it to the unit tier instead and do NOT list the file here." So the
 * printer is exported and driven directly, with the repository's own `captureProcessIo` helper
 * recording what it wrote.
 *
 * WHY THE WIRING IS PINNED STRUCTURALLY. "One line, on the affected flow only" is a property of
 * `main`, which is private, and driving it would cost a 565-file selection run. The first attempt
 * asserted a source-text filter that a staged second call path walked straight through, so the
 * guard is now a COUNT: exactly one call site may exist beside the definition. A second call
 * anywhere in the file makes the count three and fails the run, which is the shape an ungated
 * duplicate actually takes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  PACKAGE_SURFACES,
  typeOnlyDependentsOf,
  type PackageSurface,
  type TypeOnlyPair,
} from "../scripts/package-selection.js";
import { reportTypeOnlyDependents, shouldReportTypeOnlyDependents } from "../scripts/package-tasks.js";
import { captureProcessIo } from "./fixtures/process-io.js";

/** Absolute repository root, from this test file's location. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** The declared `@repo/wiki` pairs, in the order the notice must print them. */
function wikiPairs(): TypeOnlyPair[] {
  return typeOnlyDependentsOf("@repo/wiki").map((entry) => ({
    testFile: entry.testFile,
    packageName: entry.packageName,
  }));
}

/**
 * The exact line the notice must print for `@repo/wiki`, trailing newline included.
 *
 * Written out rather than composed from the declaration on purpose: a message assembled from
 * the same data it announces would agree with any rewording, and the point of pinning a
 * developer-facing sentence is that a human reading the diff sees the sentence change. The
 * third case below also rebuilds it from the declaration, so the pin cannot rot in silence in
 * the other direction.
 */
const WIKI_NOTICE =
  "package-tasks: @repo/wiki has 4 derived type-only dependent test(s) this selection cannot " +
  "observe (test/provenance-metadata-shape.test.ts, test/query-candidate-id-absent.test.ts, " +
  "test/sdk/published-dimensions-port.test.ts, test/viewer-sidebar.test.ts); " +
  "root `typecheck:tests` is the covering tier\n";

/** The declared surface for a package name, failing loudly rather than returning undefined. */
function surfaceNamed(name: string): PackageSurface {
  const surface = PACKAGE_SURFACES.find((entry) => entry.name === name);
  if (surface === undefined) throw new Error(`no declared package surface named ${name}`);
  return surface;
}

/** The two `reportTypeOnlyDependents(` occurrences: the definition and its one call site. */
function noticeOccurrences(): number {
  const source = readFileSync(path.join(REPO_ROOT, "scripts", "package-tasks.ts"), "utf8");
  return source.split("reportTypeOnlyDependents(").length - 1;
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("prints exactly one line, naming the count, every file and the covering tier", () => {
  const io = captureProcessIo();
  reportTypeOnlyDependents(surfaceNamed("@repo/wiki"), wikiPairs());
  expect(io.err()).toBe(WIKI_NOTICE);
  expect(io.out()).toBe("");
});

it("prints nothing at all when the derived set for a package is empty", () => {
  expect(typeOnlyDependentsOf("@repo/api")).toEqual([]);
  const io = captureProcessIo();
  reportTypeOnlyDependents(surfaceNamed("@repo/api"), []);
  expect(io.err()).toBe("");
  expect(io.out()).toBe("");
});

it("rebuilds the pinned line from the derived pairs, so count and files cannot drift", () => {
  const pairs = wikiPairs();
  const rebuilt =
    `package-tasks: @repo/wiki has ${pairs.length} derived type-only dependent test(s) this ` +
    `selection cannot observe (${pairs.map((pair) => pair.testFile).join(", ")}); ` +
    "root `typecheck:tests` is the covering tier\n";
  expect(WIKI_NOTICE).toBe(rebuilt);
  expect(WIKI_NOTICE).toContain("test/viewer-sidebar.test.ts");
});

it("gates the notice to the test flow and to no other task", () => {
  const gated = (["test", "lint", "typecheck", "fallow"] as const).map((task) =>
    shouldReportTypeOnlyDependents(task),
  );
  expect(gated).toEqual([true, false, false, false]);
});

it("keeps exactly one call site beside the definition, and reads no committed annotation", () => {
  expect(noticeOccurrences(), "a second call site would print the notice twice").toBe(2);
  const source = readFileSync(path.join(REPO_ROOT, "scripts", "package-tasks.ts"), "utf8");
  // The notice must be true by construction on every run, so the CLI may not print from the
  // committed annotation: that would make it as true as the last commit instead of as true as
  // this run, and the equality validating the annotation lives in a test the selective path
  // never executes.
  expect(source).not.toContain("typeOnlyDependentsOf");
  expect(source).not.toContain("TYPE_ONLY_DEPENDENTS");
});
