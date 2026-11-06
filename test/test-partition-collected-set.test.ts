/**
 * @file Pin that the affected-test tiers and `vitest` collect the same files.
 *
 * The coverage test beside this one walks the repository itself, which proves
 * the tiers match the filesystem. This one proves the stronger, more useful
 * property: the tiers match what `vitest` ACTUALLY collects, as reported by
 * `vitest list --filesOnly`. Only vitest knows its own `include`/`exclude`
 * resolution, the workspace layout and the `.claude`/`.worktrees` exclusions, so
 * this is the only honest definition of "the suite".
 *
 * The comparison is BIDIRECTIONAL on purpose. A one-way subset check would pass
 * silently if files stopped appearing on either side, which is precisely the
 * blindness this work exists to remove. So both directions are asserted, and the
 * failure message names the differing paths instead of reporting a count:
 *
 *   - collected but in no tier        → an orphan test file the selector misses;
 *   - in a tier but never collected    → an enumeration that includes a file
 *     vitest will not run, which must equal the single known exception below.
 *
 * CONTAINMENT, NOT EQUALITY, and the reason is deliberate: `vitest.config.ts`
 * excludes `test/sdk/packaging.test.ts` from the ordinary run because that file
 * installs a packed tarball and is executed by its own `test:pack` step. The
 * partition still enumerates it, and it must keep doing so — enumerating it is
 * correct, and `test:pack` is where it runs. The difference therefore has to be
 * EXACTLY that one file: if a second file ever drops out of the collection, this
 * test fails and names it rather than tolerating it.
 *
 * This file invokes the vitest binary, so the content rule classes it
 * `integration` and the fast loop never runs it. Nothing here weakens an
 * assertion elsewhere; it only pins what nothing pinned before.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyTests, partition } from "../scripts/test-partition.js";

const ROOT = path.resolve(".");
const VITEST_BIN = "./node_modules/.bin/vitest";

/** A kg package test that a root-only enumeration could never see. */
const KG_ONTOLOGY_TEST = "packages/llmwiki-kg/ts/src/core/ontology.test.ts";

/**
 * The one file `vitest.config.ts` keeps out of the ordinary run. Named here so
 * the difference stays a stated exception instead of a silent one.
 */
const KNOWN_EXCLUDED = ["test/sdk/packaging.test.ts"];

/** Listing the suite is fast, but a cold workspace can pay for transform work. */
const LIST_TIMEOUT_MS = 240_000;

/** Repo-relative, sorted list of the test files `vitest` collects. */
function collectViaVitest(): string[] {
  const raw = execFileSync(VITEST_BIN, ["list", "--filesOnly"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => path.relative(ROOT, path.resolve(ROOT, line)).split(path.sep).join("/"))
    .sort();
}

const COLLECTED = collectViaVitest();
const TIERS = partition(classifyTests(ROOT));
const TIERED = [...TIERS.unit, ...TIERS.integration].sort();

describe("the tiers and vitest collect the same test files", () => {
  it("leaves no collected test file outside both tiers", () => {
    const tiered = new Set(TIERED);
    const untiered = COLLECTED.filter((file) => !tiered.has(file));
    expect(untiered, `collected but in no tier: ${untiered.join(", ")}`).toEqual([]);
    expect(tiered.has(KG_ONTOLOGY_TEST), `${KG_ONTOLOGY_TEST} must land in a tier`).toBe(true);
  });

  it("enumerates nothing beyond the known excluded file", () => {
    const collected = new Set(COLLECTED);
    const uncollected = TIERED.filter((file) => !collected.has(file));
    expect(uncollected, `in a tier but never collected: ${uncollected.join(", ")}`).toEqual(KNOWN_EXCLUDED);
  });
}, LIST_TIMEOUT_MS);
