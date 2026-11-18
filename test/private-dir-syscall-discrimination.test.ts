/**
 * @file test/private-dir-syscall-discrimination.test.ts
 * @description S5: a syscall fault is NOT relabelled as a confinement violation.
 *
 * Scope, stated plainly: the fault is INJECTED by mocking `realpath`, because on a
 * real filesystem the resolver's probes reach an unreadable dir as a successful
 * `realpath` (mode `000` still resolves) and the fault appears at each consumer's
 * own leaf read (see `lock-private-dir-real-fault.test.ts` case 2). So this file
 * pins the INTENDED SEMANTICS of the re-check — `code` survives, the class does not
 * become `PrivateDirConfinementError` — and does not claim filesystem reachability.
 *
 * The injection is `test/fixtures/private-dir-denial.ts`, shared with the lock-surface
 * suite: one definition of "an EACCES on realpath" for every file that injects one.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { mkdir } from "fs/promises";
import path from "path";
import {
  resolveExistingConfinedPrivateDir,
} from "../packages/wiki/src/utils/private-dir.js";
import { LLMWIKI_DIR } from "../packages/wiki/src/utils/constants.js";
import { denial } from "./fixtures/private-dir-denial.js";
import { EACCES_REJECTION, resolutionFailure } from "./fixtures/lock-private-dir-suite.js";
import { tempRootTracker } from "./temp-roots.js";

vi.mock("fs/promises", async (importOriginal) =>
  (await import("./fixtures/private-dir-denial.js")).denyingRealpath(
    await importOriginal<typeof import("fs/promises")>(),
  ),
);

const roots = tempRootTracker();
let root = "";

beforeEach(async () => {
  denial.suffix = null;
  root = await roots.create("private-dir-syscall-");
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true }); // must EXIST to reach the re-check
});

afterEach(async () => {
  denial.suffix = null;
  await roots.cleanup();
});

describe("S5 — the read resolver keeps a syscall fault identifiable", () => {
  it("rejects with code EACCES and not as a confinement violation", async () => {
    denial.suffix = LLMWIKI_DIR;
    expect(await resolutionFailure(resolveExistingConfinedPrivateDir(root))).toEqual(EACCES_REJECTION);
  });

  it("accepts a plain in-tree `.llmwiki` (regression on the same call)", async () => {
    // No injection: `.llmwiki` is a plain dir and the resolver must accept it.
    await expect(resolveExistingConfinedPrivateDir(root)).resolves.toBe(path.join(root, LLMWIKI_DIR));
  });
});
