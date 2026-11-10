/**
 * @file packages/api/src/serve-bind.test.ts
 * @description Proves the shutdown path `registerShutdown` installs is still there
 * after the first stop signal — the property `process.once` broke when a repeated
 * SIGTERM arrived during a close that had not finished.
 *
 * ## Why the defect is pinned here, at the unit level
 *
 * A repeated SIGTERM only kills a process through the kernel's default
 * disposition, and that is not reachable deterministically end to end. Measured on
 * the real launcher: two signals sent back to back coalesce into one pending
 * signal; a listener the test registers itself becomes the sink for the second one;
 * and once no extra listener exists, `close()` resolves and `process.exit(0)` runs
 * before the queued signal is delivered (10/10 and 5/5 clean exits against the
 * defect). So the runnable, timing-free observable is the property that MAKES a
 * repeated signal safe: the handler is still registered after the first signal was
 * consumed, and a second dispatch is ignored instead of re-entering `close()` —
 * which rejects and would exit 1, a different way to break the same contract.
 *
 * ## What keeps a dispatch from killing the test worker
 *
 * `close` returns a promise that never settles, so the shutdown routine never
 * reaches `process.exit` and nothing here stubs or mocks it.
 * `process.emit(signal)` dispatches synchronously to whatever is registered — the
 * same listener set a real signal lands on. Cleanup removes only the listeners a
 * case added: never `removeAllListeners`, which would strip listeners the test
 * runner itself owns.
 *
 * ## The launcher case is contract coverage, not a defect reproduction
 *
 * `stays on the graceful path when SIGTERM arrives twice` pins the observable end
 * to end (no signal, exit code 0) and is green with AND without the fix. The unit
 * cases above are what fail against `process.once`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useViewerProcessLifecycle } from "../../../test/fixtures/run-cli-server.js";
import { registerShutdown } from "./serve-bind.js";

/** The signals `registerShutdown` owns; cleanup undoes exactly these. */
const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/** One registered signal listener, as Node stores it. */
type SignalListener = (signal: NodeJS.Signals) => void;

/** The listeners registered for one signal right now. */
function signalListeners(signal: NodeJS.Signals): SignalListener[] {
  return process.listeners(signal) as unknown as SignalListener[];
}

/** The listener set each owned signal had before a case ran. */
type SignalSnapshot = ReadonlyMap<NodeJS.Signals, SignalListener[]>;

/** Snapshot the listener sets, so cleanup can remove only what a case added. */
function snapshotSignalListeners(): SignalSnapshot {
  return new Map(SIGNALS.map((signal) => [signal, signalListeners(signal)]));
}

/** Remove only the listeners a case added, never a blanket `removeAllListeners`. */
function restoreSignalListeners(before: SignalSnapshot): void {
  for (const signal of SIGNALS) {
    const prior = before.get(signal) ?? [];
    for (const listener of signalListeners(signal)) {
      if (!prior.includes(listener)) process.removeListener(signal, listener);
    }
  }
}

/** A `close` that never settles: the shutdown path stays inside `close()` forever. */
function neverClosing(): { close: () => Promise<void>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    close: () => {
      calls += 1;
      return new Promise<void>(() => {});
    },
  };
}

describe("the shutdown path a repeated stop signal lands on", () => {
  it("keeps a SIGTERM handler registered after the first signal is consumed", () => {
    const before = snapshotSignalListeners();
    try {
      registerShutdown(neverClosing().close);
      process.emit("SIGTERM");
      expect(
        signalListeners("SIGTERM").length,
        "a repeated SIGTERM must still find the shutdown handler, not fall through to the kernel's default action and kill the process",
      ).toBeGreaterThanOrEqual(1);
    } finally {
      restoreSignalListeners(before);
    }
  });

  it("ignores a second SIGTERM instead of re-entering close()", () => {
    const before = snapshotSignalListeners();
    try {
      const shutdown = neverClosing();
      registerShutdown(shutdown.close);
      process.emit("SIGTERM");
      process.emit("SIGTERM");
      expect(
        shutdown.calls(),
        "a second signal must be ignored rather than re-entering close(), which rejects and would exit 1 — a different way to break the same stop contract",
      ).toBe(1);
    } finally {
      restoreSignalListeners(before);
    }
  });
});

describe("the launcher's repeated-SIGTERM contract", () => {
  const viewers = useViewerProcessLifecycle();
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "api-repeated-sigterm-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stays on the graceful path when SIGTERM arrives twice", async () => {
    const handle = await viewers.start(root);
    const settled = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      handle.process.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect(handle.stdout, "the child must reach readiness, or it never met the stop path this case measures").toContain("Host ready at");
    handle.process.kill("SIGTERM");
    handle.process.kill("SIGTERM");
    const outcome = await settled;
    expect(outcome.signal, "a repeated SIGTERM must stay on the graceful path, not fall through to the default action").toBeNull();
    expect(outcome.code, "a repeated SIGTERM must still exit 0, as the container's stop path requires").toBe(0);
  });
});
