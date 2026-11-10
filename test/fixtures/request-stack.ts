/**
 * @file test/fixtures/request-stack.ts
 * @description One request/ambient Stack PAIR, its environment pair, and the seed corpus
 * the cross-tenant compile suites share.
 *
 * ## Why the lifecycle lives here
 *
 * Three suites assert the same invariant from three directions — the advisory lock
 * (`test/compile-request-stack-lock.test.ts`), the derived artefacts
 * (`test/compile-request-stack-derived-env.test.ts`) and the candidate/pages seams
 * (`test/compile-request-stack-candidate-env.test.ts`): the Stack the REQUEST names gets
 * the effect, and a DIFFERENT Stack left ambient in `process.env` is byte-identical
 * afterwards. Each had grown its own copy of the same ~40 lines — two provisioned Stacks,
 * a scratch root, the `savedEnv` snapshot, the `beforeEach` that binds the ambient
 * environment, and the `afterEach` that releases the lock registry, unstubs env, restores
 * `process.env` and removes the root. `fallow` measured those copies as three clone
 * groups, and the copy is the risk it always is: the teardown line that releases a leaked
 * advisory lock is exactly the line a divergent copy drops, and the symptom of dropping
 * it is a stall in an unrelated later file rather than a failure here.
 *
 * ## Why the AMBIENT Stack is provisioned for real
 *
 * A missing ambient Stack fails loudly on the foreign key instead of performing the
 * cross-tenant write these suites measure, so the defect would be unobservable. Every
 * label is suffixed with a fresh `randomUUID()` by `provisionStack`, because the test
 * container is long-lived: a row or a session-level advisory lock leaked by an earlier
 * probe outlives the run that leaked it, and a shared id would let that leak masquerade
 * as this suite's subject.
 *
 * ## Why {@link REQUEST_STACK_DSN} is resolved at MODULE LOAD
 *
 * Load-bearing ordering, not style. `perRunDatabase()` publishes the suite database's URL
 * into `process.env.AKS_DATABASE_URL`, and the `savedEnv` snapshot below therefore holds
 * the SUITE url, which `afterEach` puts back. Resolving the DSN lazily inside `beforeEach`
 * would instead snapshot the shared server URL the worker was seeded with and restore
 * THAT after every test — undoing the per-run redirect for everything that runs later in
 * the same worker.
 *
 * @example
 * const stacks = useRequestStacks({ request: "r", ambient: "a", root: "r-" });
 * it("writes to the request's Stack alone", async () => {
 *   const before = await snapshotTenantRows(stacks.ambient.harness, stacks.ambientStackId);
 *   await compileAndReport(stacks.root, { env: stacks.env });
 *   assertTenantUnchanged(before, await snapshotTenantRows(stacks.ambient.harness,
 *     stacks.ambientStackId), "Stack B (ambient)");
 * });
 */

import { rm } from "node:fs/promises";

import { afterEach, beforeEach, expect, vi } from "vitest";

import { saveStoredCandidate } from "../../packages/wiki/src/dimensions/wiki/candidate-store.js";
import type { ReviewCandidate } from "../../packages/wiki/src/utils/types.js";
import type { PendingCandidateSeed } from "./candidate-queue.js";
import { createPageWriteSink } from "../../packages/wiki/src/dimensions/wiki/page-write-sink.js";
import { lockRegistry } from "../../packages/wiki/src/utils/lock-postgres.js";
import { scratchProjectRoot } from "./host-scratch.js";
import type { KgPostgresHarness } from "./kg-postgres.js";
import { perRunDatabase } from "./per-run-database.js";
import { provisionStack, type ProvisionedStack } from "./stack-harness.js";

/** Variable the dimension layer resolves a Stack's tenant id from. */
const STACK_ID_ENV_VAR = "AKS_STACK_ID";

/** Variable the dimension layer reads its database connection from. */
const DATABASE_URL_ENV_VAR = "AKS_DATABASE_URL";

/** This process's own database; provisioning fails loudly rather than skipping. */
export const REQUEST_STACK_DSN: string = (await perRunDatabase()).url;

/** Labels for one request/ambient Stack pair, each a short suite name. */
export interface RequestStackLabels {
  /** Label of the Stack a request will NAME (Stack A). */
  readonly request: string;
  /** Label of the Stack left AMBIENT in `process.env` (Stack B). */
  readonly ambient: string;
  /** Prefix for the scratch project root handed to the code under test. */
  readonly root: string;
}

/** A provisioned request/ambient pair, reachable from every test body. */
export interface RequestStacks {
  /** The Stack the request NAMES through {@link env}. */
  readonly request: ProvisionedStack;
  /** The Stack `process.env` names — the tenant a displaced write would land in. */
  readonly ambient: ProvisionedStack;
  /** The scratch project root the code under test is pointed at. */
  readonly root: string;
  /** {@link request}'s tenant id. */
  readonly requestStackId: string;
  /** {@link ambient}'s tenant id. */
  readonly ambientStackId: string;
  /** An environment naming {@link request}. A fresh object per read. */
  readonly env: NodeJS.ProcessEnv;
  /** An environment naming {@link ambient}. A fresh object per read. */
  readonly ambientEnv: NodeJS.ProcessEnv;
}

/**
 * Read a value the `beforeEach` below has not assigned yet.
 *
 * Reached only by reading the pair at MODULE scope, which would silently capture
 * `undefined` and turn every assertion into a comparison against nothing.
 *
 * @param value - The provisioned value, still absent before the first `beforeEach`.
 * @param what - Which field was read early, for the failure message.
 * @returns The same value, narrowed to be present.
 * @throws When the fixture has not been set up yet.
 */
function provisioned<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `request-stack fixture: ${what} was read before beforeEach provisioned it` +
        " — read the pair inside a test body",
    );
  }
  return value;
}

/**
 * Provision a request/ambient Stack pair for the enclosing suite and tear it down after
 * every test.
 *
 * Call it in the `describe` body, not at module scope: the hooks it registers belong to
 * that suite. The returned object is stable — its fields are filled by `beforeEach` and
 * read by the test bodies.
 *
 * @param labels - Short suite names for the two Stacks and the scratch root.
 * @returns The pair, with an environment naming each Stack.
 */
export function useRequestStacks(labels: RequestStackLabels): RequestStacks {
  let request: ProvisionedStack | undefined;
  let ambient: ProvisionedStack | undefined;
  let root: string | undefined;
  const savedEnv = {
    stackId: process.env[STACK_ID_ENV_VAR],
    dsn: process.env[DATABASE_URL_ENV_VAR],
  };

  beforeEach(async () => {
    request = await provisionStack(labels.request);
    ambient = await provisionStack(labels.ambient);
    root = await scratchProjectRoot(labels.root);
    // The AMBIENT Stack is a different, REAL Stack on purpose: a missing one would fail
    // loudly on the foreign key instead of performing the cross-tenant write measured here.
    expect(ambient.harness.stackId).not.toBe(request.harness.stackId);
    process.env[STACK_ID_ENV_VAR] = ambient.harness.stackId;
    process.env[DATABASE_URL_ENV_VAR] = REQUEST_STACK_DSN;
  });

  afterEach(async () => {
    // A leaked entry is a live reserved connection holding a session-level lock.
    for (const held of lockRegistry.values()) void held.release().catch(() => {});
    lockRegistry.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const [name, value] of [
      [STACK_ID_ENV_VAR, savedEnv.stackId],
      [DATABASE_URL_ENV_VAR, savedEnv.dsn],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await request?.release();
    await ambient?.release();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  const requestId = (): string => provisioned(request, "request").harness.stackId;
  const ambientId = (): string => provisioned(ambient, "ambient").harness.stackId;

  return {
    get request() {
      return provisioned(request, "request");
    },
    get ambient() {
      return provisioned(ambient, "ambient");
    },
    get root() {
      return provisioned(root, "root");
    },
    get requestStackId() {
      return requestId();
    },
    get ambientStackId() {
      return ambientId();
    },
    get env() {
      return { [STACK_ID_ENV_VAR]: requestId(), [DATABASE_URL_ENV_VAR]: REQUEST_STACK_DSN };
    },
    get ambientEnv() {
      return { [STACK_ID_ENV_VAR]: ambientId(), [DATABASE_URL_ENV_VAR]: REQUEST_STACK_DSN };
    },
  };
}

/**
 * A page body carrying `title` in its frontmatter, so the row store records it.
 *
 * @param title - The page title to encode.
 * @returns Frontmatter plus body, the shape {@link seedConceptPage} writes.
 */
function pageBody(title: string): string {
  return `---\ntitle: ${title}\ntags:\n  - search\n---\n\nbody\n`;
}

/**
 * Write one concept page straight into a Stack's page rows.
 *
 * Seeding through the store rather than through a compile keeps each case's subject the
 * seam it is measuring: a read case needs the same slug in two tenants under two titles
 * to tell a correct read from an always-ambient or always-empty one, and it needs no
 * compile of its own to get there.
 *
 * @param harness - A handle on the database the Stack lives in.
 * @param stackId - The Stack to write the page into.
 * @param slug - The page's slug inside `concepts`.
 * @param title - The title stored in the page's frontmatter.
 */
export async function seedConceptPage(
  harness: KgPostgresHarness,
  stackId: string,
  slug: string,
  title: string,
): Promise<void> {
  await createPageWriteSink(harness.db, stackId)({ directory: "concepts", slug, body: pageBody(title) });
}

/**
 * Write the SAME slug into both Stacks under two DIFFERENT titles.
 *
 * The three-way question every read case in these suites asks — did the REQUEST's tenant
 * answer, did the AMBIENT one answer, or did nobody answer — is only observable when both
 * tenants hold the slug: the ambient title proves a displaced read, the request title
 * proves a read that returned nothing would not have passed either.
 *
 * @param stacks - The provisioned pair.
 * @param slug - The page slug both tenants receive.
 * @param requestTitle - `title` stored in the request Stack's copy.
 * @param ambientTitle - `title` stored in the ambient Stack's copy.
 */
export async function seedSharedPage(
  stacks: RequestStacks,
  slug: string,
  requestTitle: string,
  ambientTitle: string,
): Promise<void> {
  await seedConceptPage(stacks.request.harness, stacks.requestStackId, slug, requestTitle);
  await seedConceptPage(stacks.ambient.harness, stacks.ambientStackId, slug, ambientTitle);
}

/**
 * A minimal record for seeding one tenant's candidate queue directly, bypassing a compile.
 *
 * @param title - The candidate's title.
 * @param slug - The candidate's slug, which is also what `readCandidateBySlug` looks up.
 * @returns A pending record the store's validator accepts.
 */
export function draftFor(title: string, slug: string): PendingCandidateSeed {
  return { title, slug, summary: "S.", sources: ["ref.md"], body: `# ${title}\n\nbody\n` };
}

/**
 * Plant one pending candidate straight into a Stack's ROW queue.
 *
 * The row store is writable only through `saveStoredCandidate`, and the production
 * writer that used to call it is retired. Seeding through the dimensions store keeps
 * each case's subject the seam it measures — which tenant's queue is read — without a
 * writer, and without a file the row-backed store would never look at.
 *
 * @param harness - The Stack's provisioned harness, whose `db` the row is written to.
 * @param stackId - The Stack that owns the candidate.
 * @param seed - The record's fields; `id` defaults to the slug plus a row marker.
 * @returns The record exactly as stored, including its id.
 */
export async function seedCandidateRow(
  harness: KgPostgresHarness,
  stackId: string,
  seed: PendingCandidateSeed,
): Promise<ReviewCandidate> {
  const candidate: ReviewCandidate = {
    ...seed,
    id: seed.id ?? `${seed.slug}-row`,
    generatedAt: seed.generatedAt ?? "2026-01-01T00:00:00.000Z",
    reviewMode: seed.reviewMode ?? "forced",
    heldReasons: seed.heldReasons ?? [{ code: "manual-review-requested" }],
  };
  await saveStoredCandidate(harness.db, stackId, candidate);
  return candidate;
}

/**
 * The document the stub page body cites, written where the provenance rule looks.
 *
 * `checkPageBrokenCitations` resolves `^[topic.md]` against `<root>/sources`, not against
 * the tenant's `wiki.source_documents` rows, so a row-only fixture reports a broken
 * citation for every generated page. One line is enough: the citation carries no line
 * span, so only the document's existence is consulted.
 */
export const PROVENANCE_CITED_SOURCE = {
  filename: "topic.md",
  text: "# Topic source\n\nCited text.\n",
};

