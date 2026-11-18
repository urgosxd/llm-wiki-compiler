/**
 * @file test/dimensions/kg-ingest-item1.test.ts
 * @description Item 1 of `odd/tasks/kg-ingest-speed-only.md` (T1 and T2) in ONE suite: the
 * baseline measurement of one fixture document, and the detect-only run that must cost
 * nothing and still describe that same document.
 *
 * ## Why both concerns live in one file
 *
 * S7 fixes the measurement: one fixture document, one provider, one config, for every
 * before/after on this branch. The detect-only assertions are only meaningful against the
 * numbers of the REAL ingest of that same document — the chunk count a dry run reports is
 * compared with the count the real path produced — so the two concerns measure one document
 * from one instrument. Two sibling files doing that were measuring the same thing twice,
 * which is the duplication this consolidation removes; it is not a matter of style.
 *
 * ## What the detect-only tests are for
 *
 * `dryRun` was declared on the dimension and read only by `commit` and `forget`, so a
 * detect-only run performed the full `chunkAndEmbed` and `extractGraphFromChunks` and
 * skipped only the write. It spent the whole budget and reported success — a flag that
 * lies, which is the one outcome S4 and S10 refuse.
 *
 * Two assertions carry that, and BOTH are mandatory. The chat count alone is not enough:
 * `chunkAndEmbed` chunks and then calls `embedTexts`, so a dry run that reused it would
 * spend exactly one embedding request and land on the measured baseline's
 * `embeddingRequests: 1` for a four-chunk document. That single paid request is invisible
 * in every count except the embedding count nobody would be asserting on, which is why the
 * embedding count is asserted here next to the chat count.
 *
 * ## What a dry run must still know, and how this file proves it knows it
 *
 * A report is worthless if its chunk count is invented, so the count the dry run reports is
 * compared with the count the REAL path produced for the same document — the measured
 * ingest in this file, which goes through `chunkAndEmbed` exactly as an ingest does. S2
 * forbids changing how many chunks a document yields, so those two numbers must be equal;
 * if they are not, the dry run is describing a different program.
 *
 * ## What the instrument test is for
 *
 * Not a feature: the INSTRUMENT. `test/fixtures/kg-ingest-measure.ts` reduces one real
 * ingest to the numbers S7 requires, and every later item on this branch is judged by
 * comparing its numbers with these. An instrument that is quietly wrong is worse than no
 * instrument, because a baseline it mis-measures becomes the reference every "it got
 * faster" claim is checked against — so this file pins the properties the numbers must
 * have before any of them is trusted, and prints the values themselves.
 *
 * ## Why the measured ingest comes first, and the capture is then cleared
 *
 * The real ingestion is memoized across the cases (it is the same fixture document and the
 * same scripted provider), and each detect-only case clears the recorded requests
 * immediately before measuring, so `expect(chatRequestCount()).toBe(0)` is an ABSOLUTE zero
 * and not a delta that could hide a request already spent.
 *
 * ## Why the real database, and what is stubbed
 *
 * The graph hash is read from rows Postgres actually holds, so a mocked store would hash the
 * mock. The suite is therefore guarded by the house database-skip pattern
 * (`test/fixtures/kg-postgres.ts`), skipped exactly as its siblings are when there is
 * genuinely no database.
 *
 * The provider is stubbed at the network edge by `test/fixtures/kg-provider-fetch.ts`, the
 * same cut `kg-runtime-e2e.test.ts` makes: everything from that boundary inward is shipped
 * code, and nothing here costs money or depends on an account. That stub is also the
 * counter — it records what was asked for, and its URL says which service was asked.
 *
 * ## Why the lock spy is hoisted HERE and not inside the instrument
 *
 * `vi.mock` is hoisted above the imports of the module that declares it, and the mock only
 * reaches modules loaded afterwards. Declared in the instrument it arrived too late — this
 * file imports `services/ingest/service.js` for its dimension list — and the first measured
 * run reported `lockHeldMs: 0` while the lock was demonstrably held across the provider
 * calls. A silent zero is indistinguishable from "the lock took no time", which is the one
 * conclusion this branch must never draw by accident, so the spy is hoisted in the suite,
 * before anything in its graph loads, and the recorded spans are passed to the instrument as
 * a required argument. This registration cannot move into an imported module: relocating it
 * reproduces exactly that measured, silent zero.
 */

import "./kg-runtime-provider-env.js";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AKS_DATABASE_URL_ENV_VAR,
  AKS_STACK_ID_ENV_VAR,
  DIMENSIONS_ENV_VAR,
} from "../../packages/wiki/src/dimensions/activation.js";
import { createKgDimension } from "../../packages/wiki/src/dimensions/kg/index.js";
import type { Dimension, DimensionInput } from "../../packages/wiki/src/dimensions/types.js";
import { INGEST_DIMENSIONS } from "../../packages/wiki/src/services/ingest/service.js";
import type { AcquireLockOptions } from "../../packages/wiki/src/utils/lock.js";
import { measureKgIngest, type IngestMeasurement } from "../fixtures/kg-ingest-measure.js";
import {
  capturedRequests,
  chatRequestCount,
  clearCapturedRequests,
  embeddingRequestCount,
  installKgProviderStub,
  uninstallKgProviderStub,
} from "../fixtures/kg-provider-fetch.js";
import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";

/**
 * Durations, in milliseconds, of every production mutation-lock call, in call order.
 *
 * `vi.hoisted` because the `vi.mock` factory below is hoisted above the imports: a plain
 * `const` would still be in its temporal dead zone when the factory runs.
 */
const lockSpans = vi.hoisted(() => ({ recorded: [] as number[] }));

/**
 * The production mutation lock, wrapped so its hold duration is observable.
 *
 * Delegates to the real implementation on every call — the `busy` branch and the throwing
 * branch included — so the ingest under measurement takes the SAME lock it takes in
 * production, and the recorded span is the interval a second mutation would have been
 * refused. The `finally` records the failure case too: a lock that was held and then lost
 * still blocked whoever was waiting. A suite that measured without this wrapper would
 * report a plausible-looking zero.
 */
vi.mock("../../packages/wiki/src/utils/mutation-lock.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../packages/wiki/src/utils/mutation-lock.js")>();
  return {
    ...actual,
    async tryWithOrdinaryMutationLock<T>(
      root: string,
      mutation: () => Promise<T>,
      options?: AcquireLockOptions,
    ) {
      const startedAt = performance.now();
      try {
        return await actual.tryWithOrdinaryMutationLock(root, mutation, options);
      } finally {
        lockSpans.recorded.push(performance.now() - startedAt);
      }
    },
  };
});

const harness = await createKgPostgresHarness("kg-ingest-item1");
const { db, stackId, reachable } = harness;

/** Outside the worktree, and removed below: the wiki writes its projection into it. */
const root = await mkdtemp(path.join(tmpdir(), "kg-ingest-item1-"));

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await harness.cleanup();
});

/**
 * The provider edge, installed before every case and removed after it.
 *
 * Per case rather than once for the file, so a case that asserts an ABSOLUTE zero starts
 * from an empty capture, and the counts the instrument reports are a slice of the live
 * capture belonging to THAT run alone. Removing it afterwards leaves the process as the file
 * found it, so whatever runs next cannot inherit a stub that answers its requests.
 */
beforeEach(() => {
  clearCapturedRequests();
  installKgProviderStub();
});

afterEach(() => {
  uninstallKgProviderStub();
});

/** Long enough for a real ingest with a real extraction budget: well over one minute. */
const TEST_TIMEOUT_MS = 180_000;

/** One sentence, repeated far past the chunk budget; see {@link LONG_BODY}. */
const SENTENCE = "The gateway routes embedding traffic for the office.";

/**
 * A body the chunker cannot fit into one chunk.
 *
 * The default budget is 1024 tokens and per-chunk counters cannot be told apart on a
 * single-chunk document, so this repeats one short sentence far past that — the house idiom
 * at `packages/llmwiki-kg/ts/src/routes/ingest-ontology.test.ts:95-98`. Only the body is
 * chunked (`packages/wiki/src/dimensions/kg/index.ts` calls `chunkAndEmbed(input.body, …)`),
 * so this is the one input every number in this file depends on.
 */
const LONG_BODY = Array.from(
  { length: 200 },
  (_, index) => `${SENTENCE} ${String(index)}.`,
).join(" ");

/** The document title, constant so every run here addresses the SAME source identity. */
const TITLE = "KG ingest item 1 fixture";

/**
 * The graph hash the branch recorded BEFORE this change, on this fixture document.
 *
 * A literal on purpose: S2's whole claim is that the extraction did not move, so a value
 * recomputed from the new code would prove nothing. If this differs, the change altered what
 * the model saw and the correct response is to stop, not to update the literal.
 */
const BASELINE_GRAPH_HASH = "99cbdad5faa2b45cd90a9ddebab289dbdc5bf5e90f447dbfb99ed3575f46d30c";

/**
 * The request cap a dry run reports when the environment configures none.
 *
 * A literal for the same reason as {@link BASELINE_GRAPH_HASH}: it pins the documented
 * default (`LLMWIKI_KG_MAX_EXTRACTION_REQUESTS` unset) where a reader can see it.
 */
const DOCUMENTED_REQUEST_CAP = 1000;

/** The environment a deployment runs both dimensions in, for this suite's Stack. */
function ingestEnv(): NodeJS.ProcessEnv {
  return {
    [AKS_DATABASE_URL_ENV_VAR]: DATABASE_URL,
    [DIMENSIONS_ENV_VAR]: INGEST_DIMENSIONS.join(","),
    [AKS_STACK_ID_ENV_VAR]: stackId,
  };
}

/**
 * The detect-only dimension, bound to this suite's Stack.
 *
 * `loadOntology` is stubbed rather than read: the default reader would open the graph
 * database for a run that must not touch it at all, and this Stack stores no declaration, so
 * the stub answers exactly what the database would.
 *
 * @returns The dimension under test, in detect-only mode.
 */
function detectOnlyDimension(): Dimension {
  return createKgDimension({
    stackId,
    stackName: "dry run fixture",
    dryRun: true,
    loadOntology: async () => undefined,
  });
}

/** The document a detect-only run is asked to describe, built as an ingest builds one. */
const INPUT: DimensionInput = {
  source: "https://example.test/dry-run",
  title: TITLE,
  document: `# ${TITLE}\n\n${LONG_BODY}\n`,
  body: LONG_BODY,
};

/**
 * One measurement of the fixture document.
 *
 * The provider's answers come from the stub the case installed, not from this file: they are
 * the ingest's INPUT and not part of what is being timed.
 *
 * @returns The measured numbers for one ingest of {@link LONG_BODY}.
 */
async function measureOnce(): Promise<IngestMeasurement> {
  return await measureKgIngest({
    root,
    db,
    stackId,
    env: ingestEnv(),
    title: TITLE,
    body: LONG_BODY,
    lockSpans: lockSpans.recorded,
    providerRequests: capturedRequests(),
  });
}

/** The one memoized real ingest of this file: same document, same provider, same config. */
let measured: IngestMeasurement | undefined;

/**
 * Measure one REAL ingest of {@link LONG_BODY}, once for the whole file.
 *
 * Memoized so the cases do not pay the fixture more than once; the counts are fixed at the
 * moment of the measurement, so a later `clearCapturedRequests()` cannot change them.
 *
 * @returns The measured numbers for one ingest of {@link LONG_BODY}.
 */
async function realIngest(): Promise<IngestMeasurement> {
  measured ??= await measureOnce();
  return measured;
}

describe.skipIf(!reachable)("the kg dimension's detect-only run", () => {
  it("sends no chat and no embedding request, and reports what it would have sent", async () => {
    // The real path first: its chunk count is the independent answer this dry run has to
    // match, and it costs provider requests that must not be mistaken for the dry run's.
    const real = await realIngest();
    // Empties the capture and keeps the stub installed, so both zeros below are absolute
    // and not a delta that could hide a request spent earlier.
    clearCapturedRequests();
    const prepared = await detectOnlyDimension().prepare(INPUT);
    const committed = await detectOnlyDimension().commit(prepared);

    expect(chatRequestCount()).toBe(0);
    expect(embeddingRequestCount()).toBe(0);
    // Printed as well as asserted: S10 asks for the report itself, and a green tick with the
    // string hidden is not something the branch document can quote.
    console.log(`kg-dry-run-report ${committed.summary}`);
    expect(committed.summary).toBe(
      `kg:dry-run(${real.chunkCount} chunks, 0 entities, ` +
        `would send ${real.chunkCount} chat requests, 1 embedding request, ` +
        `within the ${DOCUMENTED_REQUEST_CAP} request cap)`,
    );
  }, TEST_TIMEOUT_MS);

  it("reports the same chunk count the real path produced", async () => {
    const real = await realIngest();
    clearCapturedRequests();

    const prepared = await detectOnlyDimension().prepare(INPUT);

    // The dry run descends from `prepare` with no chunk rows, so the count it reported is
    // the only place the would-be document is still visible; the summary carries it.
    // S2: identical boundaries, therefore identical count.
    expect(prepared.unchanged).toBe(false);
    const committed = await detectOnlyDimension().commit(prepared);
    expect(committed.summary).toContain(`${real.chunkCount} chunks`);
  }, TEST_TIMEOUT_MS);

  it("leaves real extraction byte-identical to the branch baseline", async () => {
    const real = await realIngest();
    console.log(`kg-ingest-preserve ${JSON.stringify(real)}`);

    // S2's comparison anchor, unchanged: same entities, same relationships, same graph.
    expect(real.graphHash).toBe(BASELINE_GRAPH_HASH);
    // S2's "same per-chunk calls": one chat request per chunk, as before this change.
    expect(real.chatRequests).toBe(real.chunkCount);
    // The paid embedding half still ran for a real ingest, so this is not a cached run.
    expect(real.embeddingRequests).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(!reachable)("the kg ingest measurement instrument", () => {
  it("reports a stable graph hash and one model call per chunk", async () => {
    const first = await realIngest();
    const second = await measureOnce();

    // The baseline itself, printed rather than implied: S7 asks for the numbers, and a green
    // tick with no numbers is not a baseline anyone can compare against.
    console.log(`kg-ingest-baseline ${JSON.stringify(first)}`);

    // More than one chunk, or nothing about per-chunk behaviour is observable.
    expect(first.chunkCount).toBeGreaterThan(1);
    // S2's "same per-chunk calls": exactly one model call per chunk, sequentially.
    expect(first.chatRequests).toBe(first.chunkCount);
    // The paid embedding half of `prepare` ran, so this is not a cached shortcut.
    expect(first.embeddingRequests).toBeGreaterThan(0);
    // A SHA-256 digest, not a hash of nothing: the shape is asserted apart from stability.
    expect(first.graphHash).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic on the same content, which is what makes it a comparison anchor. The
    // second run is a fresh ingest, so this compares two runs and not one number with itself.
    expect(second.graphHash).toBe(first.graphHash);
  }, TEST_TIMEOUT_MS);
});
