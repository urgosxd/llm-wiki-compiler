/**
 * @file test/temp-writer-symlink-hardening.test.ts
 * @description The three bespoke temp+rename writers (state.json, rule-state.json,
 * and the trust journal) now route through the hardened {@link atomicWrite}, so
 * none of them can be redirected outside the project root by a symlink planted at
 * the old predictable `<path>.tmp` leaf. Each test plants such a symlink, performs
 * a normal write, and asserts the out-of-tree sink is untouched while the in-root
 * target round-trips correctly.
 */

import { describe, it, expect } from "vitest";
import { mkdir, symlink, readFile, writeFile } from "fs/promises";
import path from "path";
import { writeState, readState } from "../src/utils/state.js";
import { updateRuleSourceState, readRuleState } from "../src/compiler/rule-state.js";
import { openBatch, recordPreState } from "../src/trust/journal.js";
import { STATE_FILE, RULE_STATE_FILE, LLMWIKI_DIR } from "../src/utils/constants.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { withStackEnv } from "./fixtures/stack-env.js";

const ctx = useConfinementRoots("tw");

/** Plant a symlink at `<file>.tmp` pointing at an out-of-tree sink. */
async function plantTempSymlink(file: string): Promise<string> {
  const sink = path.join(ctx.outside, "sink");
  await writeFile(sink, "original", "utf-8");
  await symlink(sink, `${file}.tmp`);
  return sink;
}

describe("bespoke temp-writers route through hardened atomicWrite", () => {
  it("writeState does not escape via a planted state.json.tmp symlink", async () => {
    const { root } = ctx;
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    const sink = await plantTempSymlink(path.join(root, STATE_FILE));

    await writeState(root, { version: 1, indexHash: "h", sources: {} });

    expect(await readFile(sink, "utf-8")).toBe("original"); // outside untouched
    expect((await readState(root)).indexHash).toBe("h"); // target round-trips
  });

  it("rule-state write escapes NOT AT ALL, because it no longer writes a file", async () => {
    // Stronger than the hardening it replaces. This case used to plant a symlink at
    // `rule-state.json.tmp` and assert `atomicWrite` refused to follow it. On a
    // Stack-backed project the cursor is a ROW, so there is no temp leaf to redirect
    // -- and the assertion that proves it is that no `/tmp` sink and no in-root file
    // was touched at all, while the cursor still round-trips through the database.
    const { root } = ctx;
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    const sink = await plantTempSymlink(path.join(root, RULE_STATE_FILE));

    await withStackEnv("symlink-rule-state", async () => {
      await updateRuleSourceState(root, "a.md", { hash: "x", compiledAt: "t", concepts: [] });

      expect(await readFile(sink, "utf-8")).toBe("original"); // outside untouched
      expect((await readRuleState(root)).sources["a.md"].hash).toBe("x"); // round-trips
      // No marker file was created either: the write never went near the filesystem.
      const { access } = await import("node:fs/promises");
      const onDisk = await access(path.join(root, LLMWIKI_DIR, RULE_STATE_FILE))
        .then(() => true, () => false);
      expect(onDisk).toBe(false);
    });
  });

  it("journal persist does not escape via a planted journal.tmp symlink", async () => {
    const { root } = ctx;
    const batch = await openBatch(root); // writes the (empty) journal file
    const sink = await plantTempSymlink(
      path.join(root, LLMWIKI_DIR, "journal", `${batch.batchId}.json`),
    );

    await recordPreState(batch, path.join(root, "page.md")); // re-persists journal

    expect(await readFile(sink, "utf-8")).toBe("original");
    expect(batch.entries).toHaveLength(1);
  });
});
