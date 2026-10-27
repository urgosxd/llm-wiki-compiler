/**
 * @file test/fixtures/stack-env.ts
 * @description Run a test body under a freshly provisioned Stack.
 *
 * The wiki stores its markers, cursor and candidates in Postgres for a Stack-backed
 * project. A test that exercises any of those has to name a Stack or the run throws
 * before reaching its assertion -- so the same four lines (provision, install env,
 * restore, tear down) were being retyped per file, and every retype is a chance to
 * leak a Stack into the next test.
 *
 * ## Why the environment is restored, not merely set
 *
 * `process.env` is shared by every test in the worker. Assigning a Stack and walking
 * away would make an unrelated suite run against a Stack it never asked for, which
 * shows up as a failure somewhere else entirely. The snapshot/restore in `finally`
 * is what keeps the blast radius to the test that asked.
 */

import { afterEach, beforeEach } from "vitest";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";

/**
 * Provision a Stack, run `body` with its environment installed, then restore.
 *
 * @param label - Short suite name, used only to make a failure readable.
 * @param body - Receives the Stack environment (`AKS_STACK_ID` + database URL).
 */
export async function withStackEnv(
  label: string,
  body: (env: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const probe = await createProbeStack(label);
  const env = probe.env();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, env);
    await body(env);
  } finally {
    process.env = saved;
    await probe.harness.cleanup();
  }
}

/**
 * Install a Stack for the whole file, via `beforeEach`/`afterEach`.
 *
 * Preferred over wrapping every `it` body when a file's tests ALL need a Stack:
 * one provision per test, no chance of forgetting one, and no re-indentation of the
 * whole file. Call at the top level of the file.
 *
 * @param label - Short suite name, used only to make a failure readable.
 */
export function useStackEnv(label: string): void {
  let cleanup: (() => Promise<void>) | undefined;
  let saved: NodeJS.ProcessEnv | undefined;

  beforeEach(async () => {
    const probe = await createProbeStack(label);
    saved = { ...process.env };
    Object.assign(process.env, probe.env());
    cleanup = () => probe.harness.cleanup();
  });

  afterEach(async () => {
    if (saved !== undefined) process.env = saved;
    saved = undefined;
    const run = cleanup;
    cleanup = undefined;
    await run?.();
  });
}

/**
 * Run `body` with BOTH a temp project root and a freshly provisioned Stack.
 *
 * The temp root exists because these suites write real files (markers, candidates,
 * profiles) and must not touch the checkout. The pairing was retyped in three files,
 * each with its own `finally`, and fallow flagged the copies as a clone group; one
 * copy means a suite cannot forget the `rm` and leave a directory behind.
 *
 * @param label - Short suite name, used for both the temp prefix and the Stack.
 * @param body - Receives the absolute temp root; the Stack is installed in `process.env`.
 */
export async function withProjectRoot(
  label: string,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), `${label}-`));
  try {
    await withStackEnv(label, () => body(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
