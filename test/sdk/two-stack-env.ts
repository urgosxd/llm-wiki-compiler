/**
 * @file test/sdk/two-stack-env.ts
 * @description The arrangement every SDK Stack-versus-ambient proof repeats: two Stacks
 * with one distinguishable page each, a temp root with no `wiki/` tree, and the ambient
 * binding that makes the defect observable.
 *
 * ## Why this is shared rather than copied per suite
 *
 * Every SDK door that resolves a Stack from an ENVIRONMENT needs the same four things,
 * and each copy is a chance to arrange something else:
 *
 *   - the page must witness the tenant. `alpha-a` exists only in the Stack the process
 *     serves, `alpha-b` only in the Stack the handle names, and each body names its own
 *     slug, so a leaked page is readable in whatever field the door reports;
 *   - the root must hold no `wiki/` tree, so no answer can come from a disk scan;
 *   - the process must serve the OTHER Stack, because a door that agrees with the
 *     ambient environment by accident proves nothing;
 *   - the reachability check must THROW rather than skip. A suite that reports green
 *     with no database is the false green this fixture exists to prevent.
 *
 * Written once, a suite body is left with the part that actually differs: the call it
 * pins and the fields it reads back.
 */

import { expect, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";
import type { Wiki } from "../../packages/wiki/src/sdk/types.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import { seedConceptPage } from "../fixtures/mcp-stack-rows.js";
import { createDimensionsDatabase } from "../../packages/wiki/src/dimensions/activation.js";
import { appendJournalEntry } from "../../packages/wiki/src/dimensions/wiki/activity-log-store.js";

/** The slug that exists ONLY in the Stack the process serves. */
const AMBIENT_SLUG = "alpha-a";

/** The slug that exists ONLY in the Stack the caller's handle names. */
const BOUND_SLUG = "alpha-b";

/** Two Stacks whose pages are distinguishable, plus the root both handles address. */
export interface TwoStacks {
  /** The Stack the process is bound to, as a single-tenant deployment would be. */
  readonly ambient: ProbeStack;
  /** The Stack a request names, reachable only through the handle's options. */
  readonly bound: ProbeStack;
  /** Temp project root with no `wiki/` tree, outside the worktree. */
  readonly root: string;
  /** Drop both Stacks, the temp root, and the stubbed environment. */
  release(): Promise<void>;
}

/** A page body in the shape the compiler writes, naming its own slug. */
function pageBody(title: string, slug: string): string {
  return `---\ntitle: ${title}\nsummary: only this Stack holds ${slug}\n---\n\nOnly this Stack holds ${slug}.\n`;
}

/**
 * Provision both Stacks, seed one page into each, and make a temp root.
 *
 * @param label - Short suite name; the Stacks and the root are prefixed with it.
 * @returns The pair, ready for {@link requireReachable} and {@link bindProcessTo}.
 */
export async function createTwoStacks(label: string): Promise<TwoStacks> {
  const ambient = await createProbeStack(`${label}-ambient`);
  const bound = await createProbeStack(`${label}-bound`);
  const root = await mkdtemp(path.join(os.tmpdir(), `${label}-`));
  await seedConceptPage(ambient.harness, AMBIENT_SLUG, pageBody("Alpha A", AMBIENT_SLUG));
  await seedConceptPage(bound.harness, BOUND_SLUG, pageBody("Alpha B", BOUND_SLUG));
  return {
    ambient,
    bound,
    root,
    release: async () => {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
      await ambient.harness.cleanup();
      await bound.harness.cleanup();
    },
  };
}

/**
 * Append one journal entry to the Stack `stack` owns.
 *
 * Written through the store the OKF export READS -- `appendJournalEntry`, the same seam
 * `test/fixtures/mcp-stack-rows.ts` inspects through -- so a seeded entry cannot differ
 * in shape from one the product wrote. The handle is opened from `stack.env()` rather
 * than from the ambient environment deliberately: an environment carrying no
 * `AKS_DATABASE_URL` falls back to the vendored PRODUCTION port, which is the trap
 * `test/fixtures/test-database.ts` exists to close.
 *
 * @param stack - The Stack whose journal gains the entry.
 * @param description - Heading detail, which is the text an OKF `log.md` carries.
 * @param at - When the operation happened; distinct dates keep a failure readable.
 */
export async function appendStackJournalEntry(
  stack: ProbeStack,
  description: string,
  at: Date,
): Promise<void> {
  const handle = createDimensionsDatabase(stack.env());
  try {
    await appendJournalEntry(handle.db, stack.harness.stackId, {
      operation: "ingest",
      description,
      details: [],
      at,
    });
  } finally {
    await handle.close();
  }
}

/**
 * Fail the case when this worker never reached a database.
 *
 * Deliberately an assertion and never a skip: without a database the cross-tenant proof
 * is void, and a void proof reported as passed is worse than a red one.
 *
 * @param two - The pair whose reachability the case depends on.
 */
export function requireReachable(two: TwoStacks): void {
  expect(
    two.ambient.harness.reachable && two.bound.harness.reachable,
    "no database reached this worker: the cross-tenant proof is void",
  ).toBe(true);
}

/**
 * Bind the PROCESS to `stack` with retrieval offline, so provider credentials name no
 * Stack and no call leaves the machine.
 *
 * @param stack - The Stack the process itself serves for the rest of this case.
 */
export function bindProcessTo(stack: ProbeStack): void {
  vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
  vi.stubEnv("AKS_DATABASE_URL", String(stack.env().AKS_DATABASE_URL));
  vi.stubEnv("AKS_STACK_ID", stack.harness.stackId);
}

/**
 * Assert the root holds no `wiki/` tree, so no answer this case reads can come from disk.
 *
 * @param root - The project root the handles address.
 */
export async function expectNoWikiTree(root: string): Promise<void> {
  await expect(readdir(path.join(root, "wiki"))).rejects.toThrow(/ENOENT/);
}

/**
 * Open a case the way every Stack-versus-ambient proof opens it, and hand back the facade
 * handle bound to the OTHER Stack.
 *
 * The three statements are load-bearing and are ordered for it: the reachability assertion
 * (a run with no database proves nothing, so it must fail rather than skip), the empty
 * tree (no answer may come from a disk read), and the ambient binding (a door that agrees
 * with the process by accident must not pass). Written once, a suite body keeps only the
 * call it pins and the fields it reads back.
 *
 * @param two - The pair, released by the calling suite.
 * @returns A `createWiki` handle whose `env` names `two.bound`.
 */
export async function handleOnBoundStack(two: TwoStacks): Promise<Wiki> {
  requireReachable(two);
  await expectNoWikiTree(two.root);
  bindProcessTo(two.ambient);
  return createWiki({ root: two.root, env: two.bound.env() });
}

/**
 * Open a case as the documented DEFAULT: a handle that names NO environment.
 *
 * `CreateWikiOptions.env` is optional and omitting it addresses the AMBIENT Stack, which
 * is the contract this pair of proofs must leave exactly as it was. Opening the default
 * case through one helper is also what keeps the PRESERVE case of every door's suite a
 * statement about that door instead of a second copy of the same three lines.
 *
 * @param two - The pair, released by the calling suite.
 * @returns A `createWiki` handle with no `env`, i.e. bound to `two.ambient`.
 */
export function handleOnAmbientStack(two: TwoStacks): Wiki {
  requireReachable(two);
  bindProcessTo(two.ambient);
  return createWiki({ root: two.root });
}
