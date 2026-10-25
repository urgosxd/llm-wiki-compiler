/**
 * @file test/compile-write-dual.test.ts
 * @description The dual-write contract while reads still come from disk.
 *
 * A page sink stores the row, and the file write STILL happens. Dropping the file
 * write before `listPages` reads rows would publish pages nothing can find, so this
 * suite pins that both land with identical content. It is the guard that makes the
 * later "remove the file" step safe to attempt.
 */

import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCompilePageWritesLocked } from "../src/compiler/compile-write.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";

const BODY = "---\ntitle: Dual\n---\n\nbody\n";

let root: string;
let stored: Array<{ directory: string; slug: string; body: string }>;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dual-write-"));
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki/queries"), { recursive: true });
  stored = [];
});

afterEach(async () => {
  await releaseLock(root);
  await rm(root, { recursive: true, force: true });
});

describe("compile page writes with a sink", () => {
  it("stores the row AND still writes the file", async () => {
    const acquired = await acquireLock(root);
    expect(acquired).toBe(true);
    await applyCompilePageWritesLocked(
      root,
      [{ namespace: "concepts", slug: "dual", body: BODY }],
      { pageSink: async (request) => { stored.push(request); } },
    );

    expect(stored).toHaveLength(1);
    expect(stored[0]?.slug).toBe("dual");
    const onDisk = await readFile(path.join(root, "wiki/concepts/dual.md"), "utf-8");
    expect(onDisk).toBe(BODY);
  });

  it("writes only the file when no sink is supplied", async () => {
    await acquireLock(root);
    await applyCompilePageWritesLocked(root, [
      { namespace: "concepts", slug: "fileonly", body: BODY },
    ]);

    expect(stored).toHaveLength(0);
    const onDisk = await readFile(path.join(root, "wiki/concepts/fileonly.md"), "utf-8");
    expect(onDisk).toBe(BODY);
  });
});
