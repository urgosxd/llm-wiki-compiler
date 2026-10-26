/**
 * @file test/compile-write-backend.test.ts
 * @description Which backend a compile page write lands in, and which it does not.
 *
 * A sink stores the row and the file is NOT written: the two copies would drift, and
 * the row is meant to BE the page. This suite replaces the earlier "dual write"
 * contract, which pinned both landing while reads still came from disk. Now that
 * every compile read can come from rows, a file written alongside a row is a second
 * copy nothing is required to keep in step.
 *
 * The no-sink case is the one that must stay byte-identical, because it is what every
 * project without a Stack still runs.
 */

import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCompilePageWritesLocked } from "../src/compiler/compile-write.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";

const BODY = "---\ntitle: Backend\n---\n\nbody\n";

let root: string;
let stored: Array<{ directory: string; slug: string; body: string }>;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "page-backend-"));
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki/queries"), { recursive: true });
  stored = [];
});

afterEach(async () => {
  await releaseLock(root);
  await rm(root, { recursive: true, force: true });
});

/** True when a regular file exists at `abs`. */
async function fileExists(abs: string): Promise<boolean> {
  return await readFile(abs, "utf-8").then(() => true, () => false);
}

describe("compile page writes and their backend", () => {
  it("stores the row and writes NO file when a sink is supplied", async () => {
    expect(await acquireLock(root)).toBe(true);
    await applyCompilePageWritesLocked(
      root,
      [{ namespace: "concepts", slug: "backend", body: BODY }],
      { pageSink: async (request) => { stored.push(request); } },
    );

    expect(stored).toHaveLength(1);
    expect(stored[0]?.slug).toBe("backend");
    // The assertion that matters: no second copy is left behind to drift.
    expect(await fileExists(path.join(root, "wiki/concepts/backend.md"))).toBe(false);
  });

  it("writes only the file when no sink is supplied", async () => {
    expect(await acquireLock(root)).toBe(true);
    await applyCompilePageWritesLocked(root, [
      { namespace: "concepts", slug: "fileonly", body: BODY },
    ]);

    expect(stored).toHaveLength(0);
    const onDisk = await readFile(path.join(root, "wiki/concepts/fileonly.md"), "utf-8");
    expect(onDisk).toBe(BODY);
  });
});
