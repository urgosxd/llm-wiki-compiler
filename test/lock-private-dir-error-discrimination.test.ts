/**
 * @file test/lock-private-dir-error-discrimination.test.ts
 * @description S5: a permissions failure must surface as a permissions failure.
 *
 * `resolveConfinedPrivateDir` used to wrap EVERY failure of its confinement
 * helpers into `PrivateDirConfinementError`, discarding the underlying code, and
 * `acquireLock`'s catch then flattened whatever it received into "Lock directory
 * escapes project root — refusing to lock." An unreadable `.llmwiki` (EACCES) and
 * a planted escaping symlink therefore produced the SAME operator-facing line.
 *
 * Both are refusals — `acquireLock` keeps returning `false` — but they demand
 * different responses, so the failure class must survive to the surface. The
 * permission failure is INJECTED by mocking `realpath` rather than produced with
 * `chmod`, so this suite's verdict does not depend on the uid it runs under; the
 * real-filesystem counterpart is `lock-private-dir-real-fault.test.ts`. The fault
 * and the root pair are shared through `test/fixtures/private-dir-denial.ts` and
 * `test/fixtures/lock-private-dir-suite.ts`, so both suites inject exactly the same
 * code and read exactly the same operator-facing wording.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { symlink } from "fs/promises";
import path from "path";
import {
  resolveConfinedPrivateDir,
  PrivateDirConfinementError,
} from "../packages/wiki/src/utils/private-dir.js";
import { LLMWIKI_DIR } from "../packages/wiki/src/utils/constants.js";
import { denial } from "./fixtures/private-dir-denial.js";
import {
  acquireWithLogs,
  EACCES_REJECTION,
  ESCAPE_LINE,
  ESCAPE_REFUSAL,
  lockRefusal,
  privateDirRoots,
  resolutionFailure,
} from "./fixtures/lock-private-dir-suite.js";

vi.mock("fs/promises", async (importOriginal) =>
  (await import("./fixtures/private-dir-denial.js")).denyingRealpath(
    await importOriginal<typeof import("fs/promises")>(),
  ),
);

const roots = privateDirRoots("lock-private-error-");

beforeEach(async () => {
  denial.suffix = null;
  await roots.setup();
});

afterEach(async () => {
  denial.suffix = null;
  await roots.teardown();
});

/** Await `promise`, returning the rejection reason instead of throwing it. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`expected a rejection, got ${String(value)}`);
    },
    (error: unknown) => error,
  );
}

describe("S5 — an EACCES is reported as an EACCES, not as a confinement violation", () => {
  it("keeps the EACCES code when the confined dir itself cannot be resolved", async () => {
    denial.suffix = LLMWIKI_DIR;
    expect(await resolutionFailure(resolveConfinedPrivateDir(roots.root))).toEqual(EACCES_REJECTION);
  });

  it("says EACCES on the lock surface and never borrows the escape wording", async () => {
    denial.suffix = LLMWIKI_DIR;
    const { locked, printed } = await acquireWithLogs(roots.root);
    expect(locked).toBe(false);
    expect(printed).toContain("EACCES");
    expect(printed).not.toContain("escapes project root");
  });
});

describe("S5 — a genuine escape stays a confinement violation", () => {
  it("reports the confinement class, preserves the cause, and keeps the wording", async () => {
    await symlink(roots.outsideDir, path.join(roots.root, LLMWIKI_DIR), "dir");
    const error = await rejectionOf(resolveConfinedPrivateDir(roots.root));
    expect(error).toBeInstanceOf(PrivateDirConfinementError);
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);

    expect(await lockRefusal(roots.root)).toEqual(ESCAPE_REFUSAL);
  });

  it("refuses both failures with different messages (a permission case is distinguishable)", async () => {
    const escaped = privateDirRoots("lock-private-escape-");
    await escaped.setup();
    try {
      denial.suffix = LLMWIKI_DIR;
      const denied = await acquireWithLogs(roots.root);
      denial.suffix = null;
      await symlink(escaped.outsideDir, path.join(escaped.root, LLMWIKI_DIR), "dir");
      const confined = await acquireWithLogs(escaped.root);

      expect([denied.locked, confined.locked]).toEqual([false, false]);
      expect(denied.printed).not.toBe(confined.printed);
      expect(denied.printed).toContain("EACCES");
      expect(confined.printed).toContain(ESCAPE_LINE);
    } finally {
      await escaped.teardown();
    }
  });
});
