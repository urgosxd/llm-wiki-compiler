/**
 * @file A `review` key in project config REFUSES at config load, and writes nothing.
 *
 * ## Why this test exists
 *
 * The review policy is retired: no surface promotes a candidate into the wiki, so
 * `review.hold` can never be honoured. A compile that silently ignored the key would
 * leave a user who configured `review: { hold: [...] }` believing pages are being
 * withheld while they are written live — their wiki may have GAINED pages, and only
 * the error tells them so.
 *
 * ## Why the refusal is asserted at CONFIG LOAD and not at first use
 *
 * `review` is read from `.llmwiki/config.json` (and from a Stack's
 * `wiki.project_config` row), which is exactly where a load-time refusal stops a run
 * before it writes anything. That is the opposite of the compile-option guard, whose
 * key was never file-configurable. So each case below asserts the throw AND the
 * absence of every write: no page, no candidate record, no compile state.
 *
 * ## The message carries two facts, and the second one is the load-bearing one
 *
 * That `review.hold` is gone, and that pages which would previously have been held are
 * now written live. The first fact alone would let a user delete the key and never
 * learn their corpus changed.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as store from "../packages/wiki/src/dimensions/wiki/project-config-store.js";
import { compileAndReport } from "../packages/wiki/src/compiler/index.js";
import { loadSourceSelection } from "../packages/wiki/src/sources/selection.js";
import { CANDIDATES_DIR, CONCEPTS_DIR } from "../packages/wiki/src/utils/constants.js";
import { useCompileProject } from "./fixtures/compile-project.js";

/** The exact refusal, asserted verbatim: a user reads this instead of a silent write. */
const REFUSAL =
  'The project config "review" key no longer exists: `review.hold` is retired, and pages which ' +
  "would previously have been held are now written live. Remove the key.";

const project = useCompileProject({ dirSuffix: "review-key-refused" });

/** The page files a compile would have written, so "nothing was written" is measured. */
async function writtenPageNames(): Promise<string[]> {
  return (await readdir(path.join(project.dir, CONCEPTS_DIR))).filter((name) => name.endsWith(".md"));
}

/** Write the retired policy document the way a user's checkout would carry it. */
async function configWithRetiredPolicy(): Promise<void> {
  await writeFile(
    path.join(project.dir, ".llmwiki", "config.json"),
    JSON.stringify({ version: 1, review: { hold: ["low-confidence"] } }),
    "utf-8",
  );
}

describe("a `review` key in .llmwiki/config.json", () => {
  it("refuses the compile with the exact message and writes nothing", async () => {
    await configWithRetiredPolicy();

    await expect(compileAndReport(project.dir)).rejects.toThrow(REFUSAL);

    expect(await writtenPageNames()).toEqual([]);
    expect(existsSync(path.join(project.dir, CANDIDATES_DIR))).toBe(false);
    expect(existsSync(path.join(project.dir, ".llmwiki", "state.json"))).toBe(false);
  });

  it("refuses even when the policy would have held no page", async () => {
    await writeFile(
      path.join(project.dir, ".llmwiki", "config.json"),
      JSON.stringify({ version: 1, review: { hold: [] } }),
      "utf-8",
    );

    await expect(compileAndReport(project.dir)).rejects.toThrow(REFUSAL);
    expect(await writtenPageNames()).toEqual([]);
  });
});

describe("a `review` key in a Stack's wiki.project_config row", () => {
  it("refuses with the same message before any source is selected", async () => {
    vi.spyOn(store, "readProjectConfig").mockResolvedValue({
      version: 1,
      review: { hold: ["all"] },
    });

    await expect(
      loadSourceSelection(project.dir, { AKS_STACK_ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
    ).rejects.toThrow(REFUSAL);
    vi.restoreAllMocks();
  });
});

describe("a config that names only `sources`", () => {
  it("still loads, so the refusal is about the retired key alone", async () => {
    await mkdir(path.join(project.dir, ".llmwiki"), { recursive: true });
    await writeFile(
      path.join(project.dir, ".llmwiki", "config.json"),
      JSON.stringify({ version: 1, sources: { recursive: true } }),
      "utf-8",
    );

    expect(await loadSourceSelection(project.dir, {})).toEqual({ recursive: true, exclude: [] });
  });
});
