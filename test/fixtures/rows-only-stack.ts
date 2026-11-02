/**
 * @file test/fixtures/rows-only-stack.ts
 * @description Run a body against a freshly provisioned Stack plus a temp project.
 *
 * The `rows-only-*` suites all need the same four things: a Stack, its id in
 * `process.env.AKS_STACK_ID`, a temporary project directory, and quiet console
 * output because the command under test prints. Repeating that per file is how the
 * first versions of these suites drifted — and `fallow` flags the duplicate blocks
 * anyway.
 *
 * ## Why the Stack id is restored, not merely set
 *
 * `process.env` is shared by every test in the worker. Leaving `AKS_STACK_ID`
 * assigned would make an unrelated suite run against a Stack it never asked for,
 * which surfaces as a failure somewhere else entirely.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { createKgPostgresHarness, type KgPostgresHarness } from "./kg-postgres.js";

/** What a `withRowsStack` body receives. */
export interface RowsStackContext {
  /** Temporary project root the body may write into. */
  readonly root: string;
  /** The provisioned Stack. */
  readonly harness: KgPostgresHarness;
}

/**
 * Provision a Stack and a temp project, then run `body` with the Stack installed.
 *
 * The body is SKIPPED when no test database is reachable, which is the convention
 * the sibling dimension suites use. The file-backed halves of those suites need no
 * database and run separately, so a missing Postgres never hides them.
 *
 * @param label - Short suite label, recorded on the Stack for debuggability.
 * @param body - Work to run with the Stack bound and the project ready.
 */
export async function withRowsStack(
  label: string,
  body: (context: RowsStackContext) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), `rows-${label}-`));
  const harness = await createKgPostgresHarness(`${label}-${randomUUID().slice(0, 8)}`);
  const saved = { ...process.env };
  process.env.AKS_STACK_ID = harness.stackId;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    if (!harness.reachable) return;
    await body({ root, harness });
  } finally {
    process.env = saved;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    await harness.cleanup();
  }
}
