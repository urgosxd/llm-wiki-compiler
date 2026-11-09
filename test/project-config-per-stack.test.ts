/**
 * @file test/project-config-per-stack.test.ts
 * @description Project config belongs to the STACK, not to the checkout.
 *
 * WHY THIS EXISTS
 *
 * `.llmwiki/config.json` holds how a wiki is REVIEWED (`review`) and how its
 * sources are DISCOVERED (`sources`). Neither is a property of a checkout: two
 * clones serving one Stack must review and discover identically, and a file per
 * clone let them disagree with nothing to report it.
 *
 * These tests pin the three states that matter, because each fails silently in a
 * different way:
 *
 *   1. A Stack-configured project reads its config from `wiki.project_config`.
 *   2. A Stack with NO row does not fall back to the checkout's file — falling
 *      back reintroduces the divergence and does it quietly.
 *   3. A project with no Stack still reads the file, unchanged.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as store from "../packages/wiki/src/dimensions/wiki/project-config-store.js";
import { loadProjectConfig } from "../packages/wiki/src/project/config.js";
import { loadReviewPolicy } from "../packages/wiki/src/review/config.js";
import { loadSourceSelection } from "../packages/wiki/src/sources/selection.js";

let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const STACK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STACK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A project root carrying a FILE config that must not be used when a Stack is set. */
async function projectWithFileConfig(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pcfg-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(
    path.join(root, ".llmwiki/config.json"),
    JSON.stringify({ version: 1, sources: { recursive: true, exclude: ["from-file.md"] } }),
  );
  return root;
}

/** Serve `wiki.project_config` from memory, keyed by stack id. */
function withStoredConfig(byStack: Record<string, Record<string, unknown>>) {
  return vi.spyOn(store, "readProjectConfig").mockImplementation(
    async (_db, stackId) => byStack[stackId],
  );
}

describe("config from the Stack", () => {
  it("reads the Stack's document, not the checkout's file", async () => {
    dir = await projectWithFileConfig();
    withStoredConfig({
      [STACK_A]: { version: 1, sources: { recursive: false, exclude: ["from-stack.md"] } },
    });

    const selection = await loadSourceSelection(dir, { AKS_STACK_ID: STACK_A });

    expect(selection.exclude).toEqual(["from-stack.md"]);
    expect(selection.recursive).toBe(false);
  });

  it("does not fall back to the file when the Stack holds no config", async () => {
    dir = await projectWithFileConfig();
    withStoredConfig({});

    // The file says `recursive: true` and excludes `from-file.md`. A fallback would
    // silently apply them to a Stack that never asked for them.
    const selection = await loadSourceSelection(dir, { AKS_STACK_ID: STACK_B });

    expect(selection).toEqual({ recursive: false, exclude: [] });
  });

  it("reads review policy from the Stack's document", async () => {
    dir = await projectWithFileConfig();
    withStoredConfig({
      [STACK_A]: { version: 1, review: { hold: ["low-confidence"] } },
    });

    const policy = await loadReviewPolicy(dir, { AKS_STACK_ID: STACK_A });

    expect(policy.hold).toContain("low-confidence");
  });
});

describe("config with no Stack configured", () => {
  it("still reads .llmwiki/config.json", async () => {
    dir = await projectWithFileConfig();

    const selection = await loadSourceSelection(dir, {});

    expect(selection.exclude).toEqual(["from-file.md"]);
    expect(selection.recursive).toBe(true);
  });

  it("returns null when the file is absent", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pcfg-empty-"));

    expect(await loadProjectConfig(dir, {})).toBeNull();
  });
});
