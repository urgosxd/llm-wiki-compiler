/**
 * @file test/sdk/pack-distribution.test.ts
 * @description Pin the packed distribution list to the workspaces that are actually publishable.
 *
 * `PACK_DISTRIBUTION` is what `packaging.test.ts` packs and installs, and it is a
 * literal. A literal is only trustworthy if something compares it against the
 * filesystem on every run — otherwise a deleted package (as happened with
 * `packages/llmwiki-local-workflows` in `0374a5f`) or a workspace that becomes
 * publishable stays invisible until someone runs the slow, network-dependent
 * `test:pack` tier.
 *
 * The release workflow carries the same fact a second time, as the
 * `PACKAGE_DIRS` env literal that every publish step iterates. A stale entry
 * there fails the release before anything is published, so the workflow's value
 * is read back and compared against the derivation: neither copy can move alone.
 *
 * This file deliberately does not import `packaging.test.ts`: that would register
 * the slow packaging test in the default tier. It imports only the shared list and
 * the derivation, so it runs as an ordinary unit test.
 */

import { describe, it, expect } from "vitest";
import { PACK_DISTRIBUTION, derivePackDistribution, readPublishPackageDirs } from "./pack-distribution.js";

describe("pack distribution list", () => {
  it("names exactly the publishable workspaces and the root facade", () => {
    const derived = derivePackDistribution(process.cwd());
    const problems = [
      ...PACK_DISTRIBUTION.filter(entry => !derived.includes(entry))
        .map(entry => `listed for packing but not publishable: ${entry}`),
      ...derived.filter(entry => !PACK_DISTRIBUTION.includes(entry))
        .map(entry => `publishable but missing from the list: ${entry}`),
    ];
    expect(problems).toEqual([]);
  });

  it("publishes exactly the derived distribution from the release workflow", () => {
    const derived = derivePackDistribution(process.cwd());
    const workflow = readPublishPackageDirs(process.cwd());
    // Both lists are named in the expectation so a failure shows which side moved.
    expect({ "publish.yml PACKAGE_DIRS": workflow, "derived distribution": derived })
      .toEqual({ "publish.yml PACKAGE_DIRS": derived, "derived distribution": derived });
  });
});
