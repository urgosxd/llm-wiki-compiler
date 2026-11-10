/**
 * @file test/review-option-removal.test.ts
 * @description The `review` COMPILE option is gone, and asking for it fails loudly.
 *
 * The option promised a hold with no surface that promotes a held candidate, so it was
 * removed rather than softened. Typed callers get a compile error; the guard measured
 * here is for untyped and dynamically built callers, and it fires at FIRST USE — before
 * the provider, the lock, or any write — because a refusal that still did the work would
 * be worse than the option itself.
 *
 * `compile()` returns `Promise<void>` and discards the compile result, and the SDK
 * wrapper never turns a result's `errors` into a failure. A refusal reported as data
 * would therefore be silent at both surfaces, which is why the guard throws.
 *
 * Query carries a DISTINCT `review` field with its own guard (`Query review requires
 * save.`); it is not this option and is not covered here.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile, compileAndReport } from "../packages/wiki/src/compiler/index.js";
import { AnthropicProvider } from "../packages/wiki/src/providers/anthropic.js";
import { ProviderUnavailableError } from "../packages/wiki/src/utils/provider-guard.js";
import { useManagedTempRoots } from "./fixtures/temp-root.js";

/**
 * The one message the removed option produces, character for character.
 *
 * Equality, not a substring: the removal is final, so the wording other callers quote
 * is part of the contract.
 */
const REMOVED_MESSAGE =
  "The review compile option no longer exists: no surface promotes a held candidate, "
  + "and the option will not come back. Remove it from your call.";

/** A page already in the wiki, so a run that wrote anything would be visible. */
const EXISTING_PAGE = "# Existing\n\nA page the compile has no reason to touch.\n";

const roots = useManagedTempRoots();

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Stub the provider boundary, so "never invoked" is observed rather than assumed.
 *
 * A guard that threw only after routing an extraction would leave the keys untouched
 * and still have paid for a model call.
 *
 * @returns The two provider spies, asserted `not.toHaveBeenCalled()` by the cases.
 */
function stubProvider() {
  const toolCall = vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue("{}");
  const complete = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("body");
  return { toolCall, complete };
}

/**
 * Every file under `root` with its exact bytes, so "unchanged" means byte-identical.
 *
 * @param root - Directory to walk.
 * @param prefix - Relative path of the directory being walked.
 * @returns Relative file path to file content.
 */
async function snapshotTree(root: string, prefix = ""): Promise<Record<string, string>> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await snapshotTree(root, relative));
    else result[relative] = await readFile(path.join(root, relative), "utf8");
  }
  return result;
}

describe("the compile review option is removed", () => {
  it("rejects the removed option at the public compile entry", async () => {
    const root = await roots.tempRoot("review-removed-entry");

    const attempt = compile(root, { review: true } as never);

    await expect(attempt).rejects.toThrow(new Error(REMOVED_MESSAGE));
    // A provider or credential refusal would also throw, and would prove nothing.
    await expect(attempt).rejects.not.toBeInstanceOf(ProviderUnavailableError);
  });

  it("rejects from compileAndReport without doing any work", async () => {
    const root = await roots.tempRoot("review-removed-no-work");
    await writeFile(path.join(root, "wiki/concepts/existing.md"), EXISTING_PAGE);
    const provider = stubProvider();
    const before = await snapshotTree(root);

    await expect(compileAndReport(root, { review: true } as never))
      .rejects.toThrow(new Error(REMOVED_MESSAGE));

    expect(await snapshotTree(root)).toEqual(before);
    expect(existsSync(path.join(root, ".llmwiki/candidates"))).toBe(false);
    expect(existsSync(path.join(root, ".llmwiki/lock"))).toBe(false);
    expect(provider.toolCall).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("rejects the presence of the key, not its truthiness", async () => {
    const root = await roots.tempRoot("review-removed-false");

    await expect(compileAndReport(root, { review: false } as never))
      .rejects.toThrow(new Error(REMOVED_MESSAGE));
  });
});
