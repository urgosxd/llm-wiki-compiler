/**
 * @file test/fixtures/stack-status-fixtures.ts
 * @description The Stack-scoped seeding the `wiki_status` suites share: one probe
 * Stack per test, its pages stored as ROWS, and its pending candidates stored as ROWS.
 *
 * ## Why these fixtures are shared
 *
 * Two suites assert the same contract from two different distances: the in-process
 * `test/mcp-server.test.ts` drives the registered handlers, and
 * `test/mcp-stdio.test.ts` spawns the real `llmwiki serve` binary and speaks JSON-RPC
 * to it. Both need the same three things — a Stack this test owns exclusively, a
 * concept page written into it, and pending candidates written into it — and both
 * assert that `wiki_status` counts the corpus of the Stack the CALL names.
 *
 * Written twice, that setup drifts. The drift is not cosmetic: the earlier versions
 * seeded a candidate FILE under `.llmwiki/candidates/`, which is the queue of a
 * project that has no Stack at all, so the suites kept passing while measuring
 * something other than the contract they claimed to pin. One definition means one
 * shape, and a new suite gets the production-shaped writer for free.
 *
 * This module owns DATA (rows in a Stack), not lifecycle: the provisioned Stack and
 * its teardown still come from `test/dimensions/harness-lifecycle.ts`, because the
 * lifecycle is suite scaffolding rather than a fixture.
 *
 * ## Why the counts both suites assert are read from the NAMED Stack
 *
 * `wiki_status` resolves its corpus through the page seams, which read Postgres as
 * soon as a Stack is named, so a fixture row has to land where that read looks: in
 * the named Stack's tables. Both writers below are the ones PRODUCTION uses —
 * `createPageWriteSink(db, stackId)` for pages and `saveStoredCandidate(db, stackId,
 * …)` for the review queue — so a seeded row cannot differ in shape from a row the
 * product wrote. That is what makes a count on the named Stack an honest oracle:
 * the same number would come out of a normal ingest plus compile.
 *
 * A file-backed seed cannot serve that purpose. `wiki/concepts/<slug>.md` would be
 * found either way, so a silent fallback to disk would pass; and a candidate file is
 * counted by the file-backed queue, not by the Stack's rows. Counts are therefore
 * asserted against rows this module put in the named Stack, and the temp project
 * stays empty on purpose in the suites that use it.
 *
 * ## Why the Stack is NOT bound into `process.env` here
 *
 * `stackId` is a required tool argument, so every call names its Stack explicitly and
 * nothing is inherited from the environment. Leaving `AKS_STACK_ID` unset is also
 * what keeps the resource and `readPageRecord` cases in `test/mcp-server.test.ts`
 * honest: those read `wiki/` from DISK, and a bound deployment would make them read
 * rows instead.
 */

import { afterEach, beforeEach } from "vitest";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { saveStoredCandidate } from "../../src/dimensions/wiki/candidate-store.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";

/** One pending candidate to store as a row, with the review fields defaulted. */
export interface PendingCandidateSeed {
  /** Stable candidate identifier the review commands take. */
  readonly id: string;
  /** Slug the approved page would be written to. */
  readonly slug: string;
  /** Human-readable title shown to the reviewer. */
  readonly title: string;
  /** Full page content written verbatim on approval; defaults to a bare body. */
  readonly body?: string;
  /** Short summary carried on the candidate; defaults to `Summary`. */
  readonly summary?: string;
  /** Contributing source filenames; defaults to `["source.md"]`. */
  readonly sources?: readonly string[];
}

/** What a `wiki_status` suite gets: its own Stack, its id, and the rows it needs. */
export interface StatusStackFixture {
  /** The provisioned Stack; `reachable` is false when no test database exists. */
  readonly stack: ProbeStack;
  /** The value a call passes as its required `stackId` argument. */
  readonly stackId: string;
  /** True only when the Stack was actually provisioned. */
  readonly reachable: boolean;
  /**
   * Store one concept page as a ROW in this Stack.
   *
   * @param slug - Page slug.
   * @param title - Page title.
   * @param body - Page body, after the generated frontmatter.
   */
  seedConceptRow(slug: string, title: string, body: string): Promise<void>;
  /**
   * Store pending candidates as ROWs in this Stack.
   *
   * @param seeds - One entry per candidate; review bookkeeping is filled in here.
   */
  seedPendingCandidates(seeds: readonly PendingCandidateSeed[]): Promise<void>;
}

/**
 * Store one concept page through the production page sink.
 *
 * @param stack - The Stack that owns the page.
 * @param slug - Page slug.
 * @param title - Page title.
 * @param body - Page body, after the generated frontmatter.
 */
async function storeConceptRow(
  stack: ProbeStack,
  slug: string,
  title: string,
  body: string,
): Promise<void> {
  await createPageWriteSink(stack.harness.db, stack.harness.stackId)({
    directory: "concepts",
    slug,
    body: `---\ntitle: ${title}\nsummary: seeded for the MCP tool\n---\n\n${body}\n`,
  });
}

/**
 * Store candidates through the production candidate store.
 *
 * `heldReasons` is what makes a candidate PENDING: a stored candidate with no held
 * reason is not awaiting review and would not be counted. `reviewMode: "policy"` is
 * the mode a rule-held candidate gets, which is the queue state under test.
 *
 * @param stack - The Stack that owns the rows.
 * @param seeds - One entry per candidate.
 */
async function storePendingCandidates(
  stack: ProbeStack,
  seeds: readonly PendingCandidateSeed[],
): Promise<void> {
  const generatedAt = new Date().toISOString();
  for (const seed of seeds) {
    await saveStoredCandidate(stack.harness.db, stack.harness.stackId, {
      id: seed.id,
      slug: seed.slug,
      title: seed.title,
      summary: seed.summary ?? "Summary",
      sources: [...(seed.sources ?? ["source.md"])],
      body: seed.body ?? "body",
      generatedAt,
      reviewMode: "policy",
      heldReasons: [{ code: "low-confidence" }],
    });
  }
}

/**
 * Provision a Stack for the current test and bind the seeding helpers to it.
 *
 * @param label - Short suite label; the harness suffixes it with a random id so two
 * suites never share a fixture domain and tear down each other's rows.
 * @returns The fixture for the CURRENT test.
 */
async function createStatusStackFixture(label: string): Promise<StatusStackFixture> {
  const stack = await createProbeStack(label);
  return {
    stack,
    stackId: stack.harness.stackId,
    reachable: stack.harness.reachable,
    seedConceptRow: (slug, title, body) => storeConceptRow(stack, slug, title, body),
    seedPendingCandidates: (seeds) => storePendingCandidates(stack, seeds),
  };
}

/**
 * Register the per-test Stack lifecycle and hand back a getter for the fixture.
 *
 * Call this at MODULE scope, after any `useMcpRoot` call, so the temp project is
 * created (and removed) in the same order the suites had before the extraction. The
 * teardown drops the Stack and closes its client; it cannot reach operator data
 * because it deletes by the one id this test minted.
 *
 * @param label - Short suite label, used only to make a failure readable.
 * @returns A getter for the fixture of the current test.
 */
export function useStatusStackFixture(label: string): () => StatusStackFixture {
  let current: StatusStackFixture | undefined;

  beforeEach(async () => {
    current = await createStatusStackFixture(label);
  });

  afterEach(async () => {
    const fixture = current;
    current = undefined;
    if (fixture === undefined) return;
    await fixture.stack.harness.cleanup();
  });

  return () => {
    if (current === undefined) throw new Error("useStatusStackFixture used outside a test");
    return current;
  };
}
