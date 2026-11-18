/**
 * @file test/fixtures/ingest-job-mirror-suite.ts
 * @description The doubles the durable-mirror suites need in order to watch a write
 * that has not landed yet, defined once.
 *
 * WHY IT IS SHARED. Three suites observe the same thing from three altitudes — the
 * mirror's own bounded flush (`ingest-job-mirror-flush.test.ts`), the registry's
 * shutdown await (`ingest-job-durable-shutdown.test.ts`), and the host's one close path
 * (`server-shutdown-flush.test.ts`). Each needed a timer seam it fires by hand and a
 * handle whose writes stay open, and each wrote its own; `fallow` flagged the copies as
 * clone groups. The copies had already drifted: one seam kept the delays it was asked
 * for and the others did not, so "the bound the host resolved is the one the queue
 * scheduled" was provable in one file and silently unprovable in the other two.
 *
 * NO ASSERTIONS LIVE HERE. The helpers below only put the code under test into the
 * state a case wants; every claim stays in the case that makes it, so a reader can see
 * which test proves what.
 */

import type {
  DurableJobRegistry,
  DurableRegistryOptions,
  MirrorFlushTimers,
} from "../../packages/wiki/src/services/ingest/jobs/durable-registry.js";

/** A terminal reason, kept verbatim from the measured failure record. */
export const TERMINAL_ERROR = "Another mutation holds the project lock; retry.";

/** A timer seam a case fires by hand, plus the delays it was asked for. */
export interface ControlledTimers extends MirrorFlushTimers {
  /** Every delay the flush asked to be scheduled, in order. */
  readonly delays: number[];
  /** Fire every scheduled expiry now. */
  expire(): void;
}

/**
 * Build a timer seam whose expiries happen only when the case says so.
 *
 * Nothing here depends on how fast the machine is: the case decides when the bound
 * expires, so an expiry is an event rather than a race outcome.
 *
 * @returns The seam, with the delays recorded for assertion.
 */
export function controlledTimers(): ControlledTimers {
  const delays: number[] = [];
  const callbacks: (() => void)[] = [];
  return {
    delays,
    schedule(delayMs, onExpire) {
      delays.push(delayMs);
      callbacks.push(onExpire);
      return () => {
        callbacks.length = 0;
      };
    },
    expire() {
      for (const onExpire of callbacks.splice(0)) onExpire();
    },
  };
}

/** A handle whose writes stay open until the case releases them. */
export interface HeldHandle {
  readonly db: DurableRegistryOptions["db"];
  /** Transactions opened so far. */
  entered(): number;
  /** Let every held write through. */
  release(): void;
}

/**
 * What a write reaches when the case only cares that it is still open.
 *
 * Statements answer with no rows and a nested transaction is refused, so the mirror's
 * own bookkeeping runs to completion instead of waiting on a server that is not there.
 */
const UNREACHED_HANDLE = {
  execute: async (): Promise<unknown[]> => [],
  transaction: (): Promise<never> => Promise.reject(new Error("no nested transaction")),
} as unknown as DurableRegistryOptions["db"];

/**
 * Wrap a handle so its writes stay open behind one gate.
 *
 * Reads still go through the REAL handle when one is given, which is what lets a case
 * assert the row is absent while its write is held. With no handle given, the writes
 * reach {@link UNREACHED_HANDLE} instead: the case is then about the gate alone.
 *
 * @param inner - The handle the writes eventually reach; omitted for a gate-only case.
 * @returns The wrapped handle, its entry count, and the release.
 */
export function heldHandle(inner: DurableRegistryOptions["db"] = UNREACHED_HANDLE): HeldHandle {
  let openGate = (): void => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let entered = 0;
  const db = {
    execute: (...args: Parameters<DurableRegistryOptions["db"]["execute"]>) => inner.execute(...args),
    transaction: async (run: Parameters<DurableRegistryOptions["db"]["transaction"]>[0]) => {
      entered += 1;
      await gate;
      return inner.transaction(run);
    },
  };
  return {
    db: db as unknown as DurableRegistryOptions["db"],
    entered: () => entered,
    release: () => openGate(),
  };
}

/**
 * Drive one job to the terminal state the reported hang left behind.
 *
 * The measured record is a job whose ingest failed with {@link TERMINAL_ERROR} and whose
 * compile was skipped, stamped one and two milliseconds after creation so a case can
 * also prove the mirror writes them in that order.
 *
 * @param registry - The registry to create the job in.
 * @returns The job's id, for reading the row back.
 */
export function settleJobToTerminal(registry: DurableJobRegistry): string {
  const job = registry.create("note.md", new Date());
  registry.patchIngest(job.id, { status: "failed", error: TERMINAL_ERROR }, new Date(Date.now() + 1));
  registry.patchCompile(job.id, { status: "skipped" }, new Date(Date.now() + 2));
  return job.id;
}
