/**
 * @file Pin the boundary notice `scripts/package-tasks.ts` prints before a selective `test` run.
 *
 * S5 of `odd/tasks/selection-type-and-url-edges.md` says the notice is ONE printed line, on the
 * affected flow only. That is a developer-facing claim, and until this file existed nothing
 * committed held it: the message could have been deleted, doubled, or printed for every package
 * with every gate still green. It is the only place a developer is told that a selective green
 * does not speak for a type-only dependent, so it is pinned byte for byte.
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
 * WHAT THE THIRD AND FOURTH CASES ARE FOR. The byte-exact case pins the message but not that it
 * still describes the declaration it summarizes, so the third case rebuilds the whole line FROM
 * the declaration and requires the two to be identical — the count and the file list cannot
 * drift apart. The fourth case pins the GATE behaviourally, through the exported predicate, for
 * all four tasks: the first version of this gate asserted a source-text filter over the CLI
 * file, and a staged second call path walked through it with every case still green.
 */

import { afterEach, expect, it, vi } from "vitest";
import {
  PACKAGE_SURFACES,
  typeOnlyDependentsOf,
  type PackageSurface,
} from "../scripts/package-selection.js";
import { reportTypeOnlyDependents, shouldReportTypeOnlyDependents } from "../scripts/package-tasks.js";
import { captureProcessIo } from "./fixtures/process-io.js";

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
  "package-tasks: @repo/wiki has 7 declared type-only dependent test(s) this selection cannot " +
  "observe (test/mcp/query-sources-use-filesystem.test.ts, test/provenance-metadata-shape.test.ts, " +
  "test/query-candidate-id-absent.test.ts, test/query-stale-warning.test.ts, " +
  "test/sdk/published-dimensions-port.test.ts, test/search-fallback-eligibility.test.ts, " +
  "test/viewer-sidebar.test.ts); root `typecheck:tests` is the covering tier\n";

/** The declared surface for a package name, failing loudly rather than returning undefined. */
function surfaceNamed(name: string): PackageSurface {
  const surface = PACKAGE_SURFACES.find((entry) => entry.name === name);
  if (surface === undefined) throw new Error(`no declared package surface named ${name}`);
  return surface;
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("prints exactly one line, naming the count, every file and the covering tier", () => {
  const io = captureProcessIo();
  reportTypeOnlyDependents(surfaceNamed("@repo/wiki"));
  expect(io.err()).toBe(WIKI_NOTICE);
  expect(io.out()).toBe("");
});

it("prints nothing at all for a package with no declared type-only dependents", () => {
  expect(typeOnlyDependentsOf("@repo/api")).toEqual([]);
  const io = captureProcessIo();
  reportTypeOnlyDependents(surfaceNamed("@repo/api"));
  expect(io.err()).toBe("");
  expect(io.out()).toBe("");
});

it("rebuilds the pinned line from the declaration, so count and files cannot drift", () => {
  const declared = typeOnlyDependentsOf("@repo/wiki");
  const rebuilt =
    `package-tasks: @repo/wiki has ${declared.length} declared type-only dependent test(s) this ` +
    `selection cannot observe (${declared.map((entry) => entry.testFile).join(", ")}); ` +
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
