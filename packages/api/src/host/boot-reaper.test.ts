/**
 * @file packages/api/src/host/boot-reaper.test.ts
 * @description The reaper runs at HOST BOOT, and a boot can never be blocked or broken by it.
 *
 * WHY THIS FILE EXISTS. `reaper.ts` settles abandoned rows; nothing was calling it. The case it
 * exists for is a RESTART — a container comes back, and the rows its dead predecessor owned would
 * say `running` forever. So the wiring is: run once, after the registry exists and before the
 * listener accepts work.
 *
 * THE TWO FAILURES THIS FILE IS HERE TO CATCH, and both are outages rather than stale rows:
 *
 *  - a host that does not start because the reaper could not reach its database. A reaper that
 *    blocks boot is worse than the row it was clearing, so the call is bounded and its errors are
 *    reported and swallowed;
 *  - a host that does not start because there is no database at all. The explicit file mode has
 *    nowhere durable to reap from, so it reaps nothing and says nothing.
 *
 * WHAT IS *NOT* HERE. The settle policy itself — the bound, the refusals, idempotency, the version
 * guard — is proved in `test/services/ingest-job-reaper.test.ts`, where a Stack can be inspected
 * row by row. This file proves the WIRING and the containment, and it asserts the stored row only
 * to show that what the unit proves is what a started host actually does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { buildViewerSnapshot } from "@repo/wiki/viewer-snapshot";
import { readIngestJob, saveIngestJob } from "@repo/wiki/job-store";
import { isSettled } from "@repo/wiki/job-registry";
import { createKgPostgresHarness, type KgPostgresHarness } from "../../../../test/fixtures/kg-postgres.js";
import { createEnvSnapshot } from "../../../../test/fixtures/env-snapshot.js";
import { scratchProjectRoot } from "../../../../test/fixtures/host-scratch.js";
import { runningJobRow } from "../../../../test/fixtures/ingest-job-rows.js";
import { wikiReachable } from "../../../../test/fixtures/stack-harness.js";
import { reapAbandonedJobsAtBoot, startHost } from "./server.js";

/** Id of the row a "dead process" left behind. Shape `ing_<ULID>`, as the registry mints them. */
const JOB_ID = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0BW";

/** A timestamp far past the one-second bound every case pins, so no case waits for one. */
const LONG_AGO = "2020-01-01T00:00:00.000Z";

/** An address that is never dialled successfully: only the bound can end a wait on it. */
const BLACK_HOLE = "postgresql://probe:probe@192.0.2.1:5432/probe";

/** Every variable a case here decides, restored afterwards. */
const ENV_KEYS = [
  "AKS_DATABASE_URL",
  "AKS_STACK_ID",
  "LLMWIKI_INGEST_JOB_STUCK_AFTER_MS",
  "LLMWIKI_INGEST_JOB_FLUSH_TIMEOUT_MS",
] as const;

/** The one table this suite cannot run without; probed through the shared helper. */
const harnessReachable = await wikiReachable("host-boot-reaper");

/** One case's environment control and the reports it captured from the sink. */
interface BootCase {
  readonly env: ReturnType<typeof createEnvSnapshot>;
  readonly lines: string[];
}

/**
 * A case's environment control and the array its reports are captured into.
 *
 * @returns A fresh case scope; call `env.restore()` in the case's `finally`.
 */
function useBootCase(): BootCase {
  return { env: createEnvSnapshot(ENV_KEYS), lines: [] };
}

/**
 * Capture every line the ingest-job sink writes, so "it reported this" is observable.
 *
 * @param lines - Array the lines are appended to.
 */
function captureReports(lines: string[]): void {
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
}

/**
 * Build the viewer snapshot with NO database configured.
 *
 * The snapshot is the viewer's frozen content, not the thing under test, and building it against
 * a database would resolve a Stack of its own — which is why it is built here, in file mode,
 * BEFORE the case hands the host the database it wants reaped.
 *
 * @param boot - The case's environment control.
 * @param root - Project root the snapshot is built from.
 * @returns The frozen snapshot.
 */
async function fileModeSnapshot(
  boot: BootCase,
  root: string,
): Promise<Awaited<ReturnType<typeof buildViewerSnapshot>>> {
  boot.env.setEnv({ AKS_DATABASE_URL: "" });
  return buildViewerSnapshot(root);
}

/**
 * Provision a Stack and a scratch root for one case, and hand back their cleanup.
 *
 * @param label - Case label, so a leaked Stack is traceable to the case that leaked it.
 * @returns The Stack's harness, the project root, and the release.
 */
async function provision(
  label: string,
): Promise<{ harness: KgPostgresHarness; root: string; release: () => Promise<void> }> {
  const harness = await createKgPostgresHarness(`boot-reap-${label}-${Date.now()}`);
  const root = await scratchProjectRoot(`boot-reap-${label}-`);
  return {
    harness,
    root,
    release: async () => {
      await harness.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!harnessReachable)("reaping at host boot", () => {
  it("settles the row a dead process left behind, and names it in the report", async () => {
    const boot = useBootCase();
    const provisioned = await provision("settle");
    captureReports(boot.lines);
    try {
      const viewerSnapshot = await fileModeSnapshot(boot, provisioned.root);
      boot.env.setEnv({
        AKS_DATABASE_URL: provisioned.harness.url,
        AKS_STACK_ID: "",
        LLMWIKI_INGEST_JOB_STUCK_AFTER_MS: "1000",
      });
      await saveIngestJob(provisioned.harness.db, provisioned.harness.stackId, runningJobRow(JOB_ID, LONG_AGO));

      const handle = await startHost({ viewerSnapshot, port: 0, includeGraph: false });

      // The reap is AWAITED before the listener serves, so the row is settled by the time
      // `startHost` resolves: no client can catch the host mid-reap.
      const stored = await readIngestJob(provisioned.harness.db, provisioned.harness.stackId, JOB_ID);
      expect(stored !== undefined && isSettled(stored)).toBe(true);
      expect(stored?.ingest.error).toBe(
        `abandoned: no update since ${LONG_AGO}; the process that owned it stopped`,
      );
      // Still there, and still explaining itself: settling is not deleting.
      expect(stored?.source).toBe("note.md");
      // The operator is told WHICH row moved, on the sink every ingest-job report uses.
      expect(boot.lines.join("")).toContain("boot reaper settled 1 abandoned job(s)");
      expect(boot.lines.join("")).toContain(JOB_ID);

      await handle.close();
    } finally {
      await provisioned.release();
      boot.env.restore();
    }
  }, 60_000);

});

describe.skipIf(!harnessReachable)("a boot whose reap cannot reach its database", () => {
  it("still starts, reports instead of blocking, and serves", async () => {
    const boot = useBootCase();
    const provisioned = await provision("unreachable");
    captureReports(boot.lines);
    try {
      const viewerSnapshot = await fileModeSnapshot(boot, provisioned.root);
      boot.env.setEnv({
        AKS_DATABASE_URL: BLACK_HOLE,
        AKS_STACK_ID: "",
        LLMWIKI_INGEST_JOB_STUCK_AFTER_MS: "1000",
        // The bound is what ends the wait: the address above never answers.
        LLMWIKI_INGEST_JOB_FLUSH_TIMEOUT_MS: "150",
      });

      const handle = await startHost({ viewerSnapshot, port: 0, includeGraph: false });

      // A bound, not a connection timeout: the case's own timeout is far below the driver's, so
      // a reap that ignored its bound would fail here rather than pass slowly.
      expect(handle.port).toBeGreaterThan(0);
      expect(boot.lines.join("")).toContain("boot reaper");
      await handle.close();
    } finally {
      await provisioned.release();
      boot.env.restore();
    }
    // The deadline is the point: the driver's own connect timeout is 10 s, so a reap that ignored
    // its bound could not finish this case in time. Only the bound ends the wait inside 5 s.
  }, 5_000);
});

describe("a boot with no database configured", () => {
  it("reaps nothing, and says nothing, when no database is configured", async () => {
    const boot = useBootCase();
    captureReports(boot.lines);
    try {
      const outcome = await reapAbandonedJobsAtBoot({ AKS_DATABASE_URL: "" });

      // The explicit file mode: nowhere durable to reap from, so the boot neither reaps nor
      // reports. A line here would claim a read this host never made.
      expect(outcome).toBeUndefined();
      expect(boot.lines).toEqual([]);
    } finally {
      boot.env.restore();
    }
  }, 20_000);
});
