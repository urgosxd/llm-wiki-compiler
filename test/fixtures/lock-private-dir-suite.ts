/**
 * @file test/fixtures/lock-private-dir-suite.ts
 * @description The project-root pair, the "what did the lock SAY" capture and the
 * rejection classification that the S5 private-dir suites share.
 *
 * WHY IT IS SHARED. Three suites ask the same questions of the same surface — does
 * `acquireLock` refuse, which line does it print about the refusal, and which class did
 * the resolver throw — and each wrote its own root pair, its own `console.log` capture,
 * its own copy of the escape wording and its own three-line reading of the failure;
 * `fallow` flagged the copies as clone groups. The wording had already drifted out of
 * being one fact: "the message the operator sees" was a string literal in three files,
 * so a reworded report would have left a suite asserting a line the product no longer
 * prints.
 *
 * NO ASSERTIONS LIVE HERE. The helpers below OBSERVE — they capture what was printed,
 * which class was thrown, which errno code survived — and hand it back as data. What
 * must be true of that observation stays in the case that claims it, so a reader can
 * still see which test proves what.
 */

import { vi } from "vitest";
import { PrivateDirConfinementError } from "../../packages/wiki/src/utils/private-dir.js";
import { acquireLock } from "../../packages/wiki/src/utils/lock.js";
import {
  cleanupRootWithOutside,
  makeRootWithOutside,
  type RootWithOutside,
} from "../trust/fixture.js";

/** The one line `acquireLock` prints when `.llmwiki` escapes the project root. */
export const ESCAPE_LINE = "Lock directory escapes project root — refusing to lock.";

/** A project root paired with an out-of-tree dir, provisioned and retired by hooks. */
export interface PrivateDirRoots {
  /** The project root the current case runs against. */
  readonly root: string;
  /** The out-of-tree directory an escaping symlink points at. */
  readonly outsideDir: string;
  /** Create the pair. Call from `beforeEach`. */
  setup(): Promise<void>;
  /** Retire the pair. Call from `afterEach`, whatever the case did. */
  teardown(): Promise<void>;
}

/**
 * Make the `beforeEach`/`afterEach` pair both private-dir suites stand up.
 *
 * Keeping one copy means the teardown cannot drift from the setup, which is what leaves
 * a root behind for the next file in the same worker.
 *
 * @param prefix - tmp-dir name prefix; the outside dir reuses it.
 * @returns The pair, readable once `setup` has run.
 */
export function privateDirRoots(prefix: string): PrivateDirRoots {
  let pair: RootWithOutside | undefined;
  return {
    get root(): string {
      return pair?.root ?? "";
    },
    get outsideDir(): string {
      return pair?.outsideDir ?? "";
    },
    async setup(): Promise<void> {
      pair = await makeRootWithOutside(prefix);
    },
    async teardown(): Promise<void> {
      if (pair !== undefined) await cleanupRootWithOutside(pair);
      pair = undefined;
    },
  };
}

/**
 * Run `acquireLock` on `target` and capture the lines it printed.
 *
 * `env: {}` keeps the advisory-lock backend out of the way: these suites are about the
 * FILE-lock path's private-dir resolution, never a database.
 *
 * @param target - The project root to lock.
 * @returns Whether the lock was granted, and everything it printed.
 */
export async function acquireWithLogs(target: string): Promise<{ locked: boolean; printed: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    return { locked: await acquireLock(target, { env: {} }), printed: lines.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

/** What a refused lock attempt said, as facts rather than text each case re-parses. */
export interface LockRefusal {
  /** Whether the lock was granted. */
  readonly locked: boolean;
  /** Whether the report named the errno code. */
  readonly saidEacces: boolean;
  /** Whether the report claimed the directory escapes the project root. */
  readonly saidEscape: boolean;
}

/** The refusal a GENUINE escape must produce: refused, the escape wording, no errno code. */
export const ESCAPE_REFUSAL: LockRefusal = {
  locked: false,
  saidEacces: false,
  saidEscape: true,
};

/**
 * Refuse-and-classify: attempt the file lock on `target` and report what it said.
 *
 * @param target - The project root to lock.
 * @returns The three facts a case can disagree with.
 */
export async function lockRefusal(target: string): Promise<LockRefusal> {
  const { locked, printed } = await acquireWithLogs(target);
  return {
    locked,
    saidEacces: printed.includes("EACCES"),
    saidEscape: printed.includes(ESCAPE_LINE),
  };
}

/** How one private-dir resolver rejected, as facts rather than a resolution to re-read. */
export interface ResolverRejection {
  /** Whether it rejected with an `Error` at all. */
  readonly isError: boolean;
  /** The errno code the rejection carried, if it carried one. */
  readonly code: string | undefined;
  /** Whether the rejection was the confinement violation itself. */
  readonly confinementViolation: boolean;
}

/** The rejection an injected `EACCES` must produce: an errno failure, not a confinement one. */
export const EACCES_REJECTION: ResolverRejection = {
  isError: true,
  code: "EACCES",
  confinementViolation: false,
};

/**
 * Await a resolution and classify its rejection.
 *
 * A RESOLVED promise is a failure of the case, not a result: every caller here asserts
 * on a refusal, so silently returning a success shape would make the case pass on a
 * product that stopped refusing.
 *
 * @param resolution - The resolver's promise.
 * @returns The class, the errno code and whether it was the confinement violation.
 */
export async function resolutionFailure(resolution: Promise<unknown>): Promise<ResolverRejection> {
  const error = await resolution.then(
    (value) => {
      throw new Error(`expected a rejection, got ${String(value)}`);
    },
    (reason: unknown) => reason,
  );
  return {
    isError: error instanceof Error,
    code: (error as NodeJS.ErrnoException | undefined)?.code,
    confinementViolation: error instanceof PrivateDirConfinementError,
  };
}
