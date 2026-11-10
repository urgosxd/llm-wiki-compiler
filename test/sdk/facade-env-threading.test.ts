/**
 * @file test/sdk/facade-env-threading.test.ts
 * @description `CreateWikiOptions.env` decides the tenant the SDK facade COMPILES
 * into, the tenant its STATUS describes, and the corpus its LINT inspects.
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
 *    coincidence;
 *  - `lint()`/`lintByTier()` name the empty page of the handle's OWN Stack under both
 *    ambient conditions that used to break them: a process serving another Stack
 *    (which answered with that Stack's page) and a process serving none (which walked
 *    an empty `wiki/` and reported nothing).
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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";
import type { WikiStatus } from "../../packages/wiki/src/status/collect.js";
import type { Page } from "../../packages/wiki/src/pages/list.js";
import type { SourceRecord } from "../../packages/wiki/src/sources/store.js";
import type { LintResult, LintSummary } from "../../packages/wiki/src/linter/types.js";
import type { TieredLintReportV1 } from "../../packages/wiki/src/linter/tiers.js";
import { AKS_STACK_ID_ENV_VAR } from "../../packages/wiki/src/dimensions/activation.js";
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

/**
 * A page body SHORT enough that the `empty-page` rule fires on it.
 *
 * The rule's threshold is 50 characters, so `short` is below it and a page seeded with
 * this body is one deterministic finding the test can name.
 */
function hollowPageBody(title: string): string {
  return `---\ntitle: ${title}\nsummary: ${title} summary\n---\n\nshort\n`;
}

/** The page slugs `empty-page` findings name, read from the path a rule reports. */
function emptyPageSlugs(results: readonly LintResult[]): string[] {
  return results
    .filter((result) => result.rule === "empty-page")
    .map((result) => path.basename(result.file, ".md"))
    .sort();
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

/**
 * Both tenant handles, with the process bound to the Stack a single-tenant deployment
 * would serve.
 *
 * Every test here needs the SAME arrangement — the ambient Stack is A, the handles
 * address A and B — and each copy is a chance to bind the wrong one, which is exactly
 * how a test of this defect can pass while measuring nothing.
 *
 * @returns A handle for the ambient Stack A and a handle for the requested Stack B.
 */
function handlesBoundToAmbientA(): { stackA: Wiki; stackB: Wiki } {
  Object.assign(process.env, tenants.bound.env());
  return {
    stackA: wikiFor(tenants.boundRoot, tenants.bound),
    stackB: wikiFor(tenants.requestedRoot, tenants.requested),
  };
}

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
    const { stackA, stackB } = handlesBoundToAmbientA();
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

    // `lint` keeps reading the file corpus too: one page written to disk, named as
    // the only empty page, and no database anywhere in the answer.
    await mkdir(path.join(tenants.boundRoot, "wiki", "concepts"), { recursive: true });
    const hollowPath = path.join(tenants.boundRoot, "wiki", "concepts", "hollow.md");
    await writeFile(hollowPath, hollowPageBody("Hollow"), "utf-8");
    expect(emptyPageSlugs(((await wiki.lint()) as LintSummary).results)).toEqual(["hollow"]);
  }, 180_000);
});

// `lint`/`lintByTier` DO have a row-aware path — `resolveLintCorpus` resolves the run's
// pages through `withRawPageSource(root, env, …)` — so a dropped `env` is a real defect,
// not an inert argument. Both ambient conditions are pinned because they fail
// DIFFERENTLY: an ambient Stack makes the handle answer for another tenant, and no
// ambient Stack falls back to a `wiki/` tree the Stack does not have.
describe("SDK facade lint honours CreateWikiOptions.env", () => {
  it("reports the empty pages of the Stack the handle names, not the ambient one", async () => {
    const { stackA, stackB } = handlesBoundToAmbientA();
    await seedConceptPage(tenants.bound.harness, "hollow-a", hollowPageBody("Hollow A"));
    await seedConceptPage(tenants.requested.harness, "hollow-b", hollowPageBody("Hollow B"));

    for (const [label, wiki, own] of [
      ["A", stackA, "hollow-a"],
      ["B", stackB, "hollow-b"],
    ] as const) {
      const summary = (await wiki.lint()) as LintSummary;
      expect({ stack: label, slugs: emptyPageSlugs(summary.results) }).toEqual({ stack: label, slugs: [own] });
      const tiered = (await wiki.lintByTier()) as TieredLintReportV1;
      expect({ stack: label, slugs: emptyPageSlugs(tiered.deterministic) }).toEqual({ stack: label, slugs: [own] });
    }
  }, 180_000);

  it("reports the Stack the handle names when the ambient names no Stack", async () => {
    delete process.env.AKS_STACK_ID;
    const stackB = wikiFor(tenants.requestedRoot, tenants.requested);
    await seedConceptPage(tenants.requested.harness, "hollow-b", hollowPageBody("Hollow B"));

    expect(emptyPageSlugs(((await stackB.lint()) as LintSummary).results)).toEqual(["hollow-b"]);
  }, 180_000);
});

// INERT, and pinned as such: `getSource` answers from `sources/` whatever Stack the
// handle names, because it has no row-aware path a Stack id could reach. Proven
// through `createWiki` only. A future threading change would have to open a database
// for the named Stack and answer from it, which this handle's env cannot do.
describe("SDK facade getSource is inert to CreateWikiOptions.env", () => {
  it("returns the on-disk source whether or not the handle names a Stack", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sdk-getsource-inert-"));
    try {
      await mkdir(path.join(root, "sources"), { recursive: true });
      const text = bodyFor("Note");
      await writeFile(path.join(root, "sources", "note.md"), text, "utf-8");

      const stackBound = createWiki({ root, env: { [AKS_STACK_ID_ENV_VAR]: "no-stack-behind-this-id" } });
      const fileBound = createWiki({ root });

      const fromStackBound = (await stackBound.getSource("note.md")) as SourceRecord;
      const fromFileBound = (await fileBound.getSource("note.md")) as SourceRecord;

      expect(fromStackBound).toEqual(fromFileBound);
      expect(fromStackBound.body).toBe(text);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
