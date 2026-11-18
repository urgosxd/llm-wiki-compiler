/**
 * @file test/lock-private-dir-real-fault.test.ts
 * @description S5 against the REAL filesystem: which failures the lock refuses on,
 * and what it says about each one.
 *
 * The mocked suite (`lock-private-dir-error-discrimination.test.ts`) pins the error
 * classes; this one pins the operator-facing lines with real `chmod`/`symlink`
 * faults — the surface the defect was reported on. The two `chmod` cases cannot deny
 * anything to root, so they are SKIPPED under uid 0 rather than silently "passing":
 * a root run is NOT coverage for them. The escape case needs no privilege and always
 * runs.
 *
 * The root pair, the message capture and the escape wording come from
 * `test/fixtures/lock-private-dir-suite.ts`: they are the same three things the mocked
 * suite needs, and the wording in particular is one fact about the product, not a
 * literal each file is free to re-copy.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { chmod, mkdir, readdir, symlink } from "fs/promises";
import path from "path";
import {
  resolveConfinedPrivateDir,
  resolveExistingConfinedPrivateDir,
  PrivateDirConfinementError,
} from "../packages/wiki/src/utils/private-dir.js";
import { readPendingMarker } from "../packages/wiki/src/utils/pending-embeddings.js";
import { LLMWIKI_DIR } from "../packages/wiki/src/utils/constants.js";
import {
  acquireWithLogs,
  ESCAPE_REFUSAL,
  lockRefusal,
  privateDirRoots,
} from "./fixtures/lock-private-dir-suite.js";

/** `chmod` denies nothing to root, so the atomic-permission cases assert nothing there. */
const asRoot = process.getuid?.() === 0;

const roots = privateDirRoots("lock-real-fault-");

beforeEach(async () => {
  await roots.setup();
});

afterEach(async () => {
  await roots.teardown();
});

describe("S5 — a real permission failure at the lock surface", () => {
  it.skipIf(asRoot)("reports EACCES (not an escape) when `.llmwiki` cannot be created", async () => {
    await chmod(roots.root, 0o555); // read-only project root, no `.llmwiki` yet
    try {
      const { locked, printed } = await acquireWithLogs(roots.root);
      expect(printed).toMatch(/Lock directory unavailable \(EACCES\): .*mkdir/);
      expect(printed).not.toContain("escapes project root");
      expect(locked).toBe(false);
      expect(await readdir(roots.root)).not.toContain(LLMWIKI_DIR);
    } finally {
      await chmod(roots.root, 0o755); // restore before teardown removes the tree
    }
  });

  it.skipIf(asRoot)("resolves an unreadable `.llmwiki` and the read path says unavailable", async () => {
    const privateDir = path.join(roots.root, LLMWIKI_DIR);
    await mkdir(privateDir, { recursive: true });
    await chmod(privateDir, 0o000); // exists but unreadable/unsearchable
    try {
      // The resolvers judge the PATH, not its contents: they must resolve, so the
      // fault stays where it belongs — each consumer's own leaf read.
      await expect(resolveConfinedPrivateDir(roots.root)).resolves.toBe(privateDir);
      await expect(resolveExistingConfinedPrivateDir(roots.root)).resolves.toBe(privateDir);
      // `env: {}` keeps the rows backend out; this is the file-marker read.
      const marker = await readPendingMarker(roots.root, undefined, {});
      expect(marker.status).toBe("unavailable");
    } finally {
      await chmod(privateDir, 0o755);
    }
  });
});

describe("S5 — a real escaping symlink keeps the escape report", () => {
  it("refuses with the unchanged wording, writes nothing out of tree, and both resolvers reject", async () => {
    await symlink(roots.outsideDir, path.join(roots.root, LLMWIKI_DIR), "dir");

    expect(await lockRefusal(roots.root)).toEqual(ESCAPE_REFUSAL);
    expect(await readdir(roots.outsideDir)).toEqual([]); // nothing written through the link

    for (const resolve of [resolveConfinedPrivateDir, resolveExistingConfinedPrivateDir]) {
      await expect(resolve(roots.root)).rejects.toBeInstanceOf(PrivateDirConfinementError);
      await expect(resolve(roots.root)).rejects.toThrow(
        "private dir rejected: path escapes project root: .llmwiki",
      );
    }
  });
});
