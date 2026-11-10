/**
 * @file test/sdk/facade-env-threading.test.ts
 * @description `CreateWikiOptions.env` decides the tenant the SDK facade COMPILES
 * into and the tenant its STATUS describes.
 *
 * ## The condition this pins
 *
 * `createWikiCoreAtRoot` resolves the request environment ONCE (`sdk/core.ts:81`) and
 * forwards it to `ingest`/`ingestText`, `search`, `query`, `getPage` and `listPages`.
 * `compile` did not forward it — it called `compileAndReport(root, opts)`, which
 * resolves `options.env ?? process.env` — and `status` called `collectStatus(root)`
 * with no environment at all. So a host bound to Stack A that served a request for
 * Stack B recorded B's compile under A (or under the process' own state file when the
 * process is bound to nothing) and answered B's status from A.
 *
 * A mixed answer is the part that makes this a data-integrity defect rather than a
 * wrong number: one status object carrying another tenant's `lastCompiledAt` and
 * `pendingChanges` beside this tenant's `sources` describes two Stacks at once.
 *
 * ## What is pinned
 *
 *  - the compile's state rows land in the Stack the handle names, and the other
 *    Stack's rows do not change;
 *  - `status()` answers for the handle's own Stack, proven by the one-tenant
 *    invariant `status().pages.total === listPages().pages.length` and
 *    `status().sources === listSources().sources.length`, checked on BOTH handles
 *    against corpora of different sizes so an ambient read cannot satisfy it by
 *    coincidence.
 *
 * ## Why the two Stacks are provisioned per test
 *
 * The defect is only observable when the Stack the process serves differs from the
 * Stack the handle names, so both have to exist and be told apart by `stack_id`. The
 * shared lifecycle fixture (`createProbeStack`) owns provision and teardown; the
 * corpora are written by the real `ingestText`/`compile`, so the rows, the projected
 * `sources/` files and the compile state are the ones a caller actually gets.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";
import type { WikiStatus } from "../../packages/wiki/src/status/collect.js";
import type { Page } from "../../packages/wiki/src/pages/list.js";
import type { SourceRecord } from "../../packages/wiki/src/sources/store.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import { seedConceptPage } from "../fixtures/mcp-stack-rows.js";

/** A facade handle, as `createWiki` returns it. */
type Wiki = ReturnType<typeof createWiki>;

/** Body long enough to clear the minimum source length the ingest enforces. */
function bodyFor(title: string): string {
  return `${title} body long enough to clear the minimum source length the ingest enforces.`;
}

/** A page body in the shape the compiler writes and every reader parses. */
function pageBody(title: string): string {
  return (
    `---\ntitle: ${title}\nsummary: ${title} summary\n---\n\n` +
    `Body long enough that the empty-page rule has nothing to say.\n`
  );
}

/** A handle bound to `stack`, addressing `root`. */
function wikiFor(root: string, stack: ProbeStack): Wiki {
  return createWiki({ root, env: stack.env() });
}

/** The status of a handle, in the shape a consumer reads. */
async function statusOf(wiki: Wiki): Promise<WikiStatus> {
  return (await wiki.status()) as WikiStatus;
}

/** The pages a handle lists for its own Stack. */
async function pagesOf(wiki: Wiki): Promise<Page[]> {
  return ((await wiki.listPages()) as { pages: Page[] }).pages;
}

/** The sources a handle lists for its own Stack. */
async function sourcesOf(wiki: Wiki): Promise<SourceRecord[]> {
  return ((await wiki.listSources()) as { sources: SourceRecord[] }).sources;
}

/**
 * How many rows `table` holds for `stack`.
 *
 * The query, verbatim:
 * `select count(*)::int as n from <table> where stack_id = '<stackId>'`
 *
 * Filtered by `stack_id` in SQL rather than by a tenant policy: the test role OWNS
 * these tables, so `set_config('app.stack_id', …)` does not narrow a plain count and
 * an unscoped query would silently return every Stack's rows in the run database.
 */
async function rowsOf(stack: ProbeStack, table: string): Promise<number> {
  const [row] = await stack.harness.db.execute(
    `select count(*)::int as n from ${table} where stack_id = '${stack.harness.stackId}'`,
  );
  return Number((row as { n: number }).n);
}

/** Run `fn` with the shipped keyless provider selected, restoring the selection after. */
async function keylessly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.LLMWIKI_PROVIDER;
  process.env.LLMWIKI_PROVIDER = "offline";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.LLMWIKI_PROVIDER;
    else process.env.LLMWIKI_PROVIDER = saved;
  }
}

/** The two Stacks and the two project roots their handles address. */
interface Tenants {
  /** The Stack the process serves, as a single-tenant deployment would be bound. */
  readonly bound: ProbeStack;
  /** The Stack a request names, reachable only through `CreateWikiOptions.env`. */
  readonly requested: ProbeStack;
  readonly boundRoot: string;
  readonly requestedRoot: string;
  release(): Promise<void>;
}

/** Provision both tenants, each with its own temp project root outside the worktree. */
async function provisionTenants(): Promise<Tenants> {
  const bound = await createProbeStack("sdk-env-thread-bound");
  const requested = await createProbeStack("sdk-env-thread-requested");
  const boundRoot = await mkdtemp(path.join(tmpdir(), "sdk-env-thread-bound-"));
  const requestedRoot = await mkdtemp(path.join(tmpdir(), "sdk-env-thread-requested-"));
  return {
    bound,
    requested,
    boundRoot,
    requestedRoot,
    release: async () => {
      await bound.harness.cleanup();
      await requested.harness.cleanup();
      await rm(boundRoot, { recursive: true, force: true });
      await rm(requestedRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Make the bound tenant LIVE: one compiled source, plus one still pending.
 *
 * The pending source is the point. It gives a compile aimed at the WRONG tenant real
 * work to do there, so "the other Stack did not change" measures routing rather than
 * an idle run, and no ambient state can answer for the requested tenant's status.
 *
 * @param tenants - The pair to arrange.
 * @returns The bound Stack's compile-state row count, to compare against later.
 */
async function withBoundTenantLive(tenants: Tenants): Promise<number> {
  const stackA = wikiFor(tenants.boundRoot, tenants.bound);
  await stackA.ingestText({ title: "Alpha", text: bodyFor("Alpha") });
  await keylessly(() => stackA.compile());
  await stackA.ingestText({ title: "Alpha Pending", text: bodyFor("Alpha Pending") });
  return rowsOf(tenants.bound, "wiki.source_compile_state");
}

/**
 * Ingest one source into the REQUESTED tenant and compile it through that handle.
 *
 * @param tenants - The pair to arrange.
 * @returns The handle that ran the compile, for a status read afterwards.
 */
async function compileIntoRequested(tenants: Tenants): Promise<Wiki> {
  const stackB = wikiFor(tenants.requestedRoot, tenants.requested);
  await stackB.ingestText({ title: "Beta", text: bodyFor("Beta") });
  await keylessly(() => stackB.compile());
  return stackB;
}

/** Fill one Stack's corpus through the real ingest, then give it compiled page rows. */
async function fill(wiki: Wiki, stack: ProbeStack, titles: string[]): Promise<void> {
  for (const title of titles) {
    await wiki.ingestText({ title, text: bodyFor(title) });
    await seedConceptPage(stack.harness, title.toLowerCase(), pageBody(title));
  }
}

// One pair of tenants per test: the defect only shows when the Stack the process
// serves differs from the Stack the handle names, so both must exist and be told
// apart by `stack_id`. The shared lifecycle fixture owns provision and teardown.
let tenants: Tenants;
let saved: NodeJS.ProcessEnv;

beforeEach(async () => {
  tenants = await provisionTenants();
  saved = { ...process.env };
});

afterEach(async () => {
  process.env = saved;
  await tenants.release();
});

describe("SDK facade compile and status honour CreateWikiOptions.env", () => {
  it("records the compile state in the Stack the handle names", async () => {
    Object.assign(process.env, tenants.bound.env());
    const boundBefore = await withBoundTenantLive(tenants);
    const stackB = await compileIntoRequested(tenants);

    // The compiled source is recorded in the Stack the handle named...
    expect(await rowsOf(tenants.requested, "wiki.source_compile_state")).toBe(1);
    // ...and the tenant the process serves was not touched by a compile that named B.
    expect(await rowsOf(tenants.bound, "wiki.source_compile_state")).toBe(boundBefore);
    // The compile really ran for B, so the B-bound status reports it: another
    // tenant's timestamp must not be what makes this non-null.
    expect((await statusOf(stackB)).lastCompiledAt).not.toBeNull();
  }, 180_000);

  it("describes one Stack: status agrees with the handle's own listings", async () => {
    Object.assign(process.env, tenants.bound.env());
    const stackA = wikiFor(tenants.boundRoot, tenants.bound);
    const stackB = wikiFor(tenants.requestedRoot, tenants.requested);
    // Different corpora, so a read of the ambient Stack answers a different number
    // than this handle's own listings do.
    await fill(stackA, tenants.bound, ["Alpha"]);
    await fill(stackB, tenants.requested, ["Beta", "Gamma"]);

    for (const [label, wiki] of [["A", stackA], ["B", stackB]] as const) {
      const status = await statusOf(wiki);
      // One status object, one Stack: both counters agree with the lists this SAME
      // handle returns, whichever tenant the process happens to serve.
      expect({ stack: label, pages: status.pages.total }).toEqual({
        stack: label,
        pages: (await pagesOf(wiki)).length,
      });
      expect({ stack: label, sources: status.sources }).toEqual({
        stack: label,
        sources: (await sourcesOf(wiki)).length,
      });
    }
  }, 180_000);
});

// PRESERVE: the documented DEFAULT this change must not move.
describe("SDK facade with no env and no Stack configured", () => {
  it("keeps reading and writing the file backend", async () => {
    delete process.env.AKS_STACK_ID;

    const wiki = createWiki({ root: tenants.boundRoot });
    await wiki.ingestText({ title: "Local", text: bodyFor("Local") });
    await keylessly(() => wiki.compile());

    const status = await statusOf(wiki);
    expect(status.stateStatus).toBe("ok");
    expect(status.sources).toBe(1);
    expect((await sourcesOf(wiki)).length).toBe(1);
    expect(status.pages.total).toBe((await pagesOf(wiki)).length);
  }, 180_000);
});
