/**
 * @file Shared harness for the lock-observability suites.
 *
 * Both suites declared the same per-test wiring: a console spy pair, `setVerbose(false)`,
 * a private temp root, a registry reset and a mock restore. It lives here instead of in
 * each suite. The root is NOT shared: each suite passes its own mkdtemp prefix and gets
 * its own path back through `assignRoot`, so two suites running in one worker still hold
 * two distinct roots — which is the property those suites exist to observe.
 */

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { lockRegistry } from "../../packages/wiki/src/utils/lock-postgres.js";
import { setVerbose } from "../../packages/wiki/src/utils/output.js";

/** What a suite gets back: the captured stdout lines. */
export interface LockObservabilitySuite {
  /** Every stdout line emitted so far, joined per `console.log` call. */
  lines: () => string[];
}

/**
 * Register the calling suite's lock-observability hooks.
 * @param prefix - This suite's own mkdtemp prefix; never shared between suites.
 * @param assignRoot - Receives the fresh root the hooks create for each test.
 * @returns The suite's stdout capture.
 */
export function useLockObservabilitySuite(
  prefix: string,
  assignRoot: (root: string) => void,
): LockObservabilitySuite {
  let root = "";
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    setVerbose(false);
    root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
    assignRoot(root);
  });
  afterEach(async () => {
    lockRegistry.clear();
    setVerbose(false);
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  return { lines: () => log.mock.calls.map((args: unknown[]) => args.join(" ")) };
}
