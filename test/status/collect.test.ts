import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectStatus, type WikiStatus } from "../../packages/wiki/src/status/collect.js";

describe("collectStatus", () => {
  it("returns a typed status snapshot for an empty project root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-status-"));
    const status: WikiStatus = await collectStatus(root);
    expect(status.pages.total).toBe(0);
    expect(Array.isArray(status.orphanedPages)).toBe(true);
    expect(status.lastCompiledAt).toBeNull();
  });

  it("does not throw on a too-new state.json with no v1-shaped sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-status-toonew-"));
    const llmwikiDir = path.join(root, ".llmwiki");
    await mkdir(llmwikiDir, { recursive: true });
    // A future format need not carry a v1 `sources` map. Of the two fields this
    // test reads, only `lastCompiledAt` still comes from the compile state, and
    // that unusable-state read must fail closed (null) instead of throwing on
    // Object.keys(undefined). `sources` is 0 because this root has no `sources/`
    // listing to count, not because of the state.
    await writeFile(path.join(llmwikiDir, "state.json"), JSON.stringify({ version: 3 }), "utf-8");

    const status: WikiStatus = await collectStatus(root);

    expect(status.stateStatus).toBe("too-new");
    expect(status.sources).toBe(0);
    expect(status.lastCompiledAt).toBeNull();
  });

  it("does not write a .bak file when state.json is corrupt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-status-corrupt-"));
    const llmwikiDir = path.join(root, ".llmwiki");
    await mkdir(llmwikiDir, { recursive: true });
    const stateFile = path.join(llmwikiDir, "state.json");
    await writeFile(stateFile, "{ invalid json !!!", "utf-8");

    const status: WikiStatus = await collectStatus(root);

    expect(existsSync(path.join(llmwikiDir, "state.json.bak"))).toBe(false);
    expect(status.pages.total).toBe(0);
    expect(Array.isArray(status.orphanedPages)).toBe(true);
  });
});
