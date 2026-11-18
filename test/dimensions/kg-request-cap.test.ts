/**
 * @file test/dimensions/kg-request-cap.test.ts
 * @description T3 of `odd/tasks/kg-ingest-speed-only.md`: the spend cap refuses, and
 * every way of misconfiguring it is an error rather than "no cap".
 *
 * ## Why every rejection is pinned, including `empty`
 *
 * `test/provider-timeout.test.ts` pins zero and negative for the timeout parser it
 * models, and stops there. For a SPEND cap the two remaining cases are exactly the ones
 * an operator would write: a non-numeric value (`=unlimited`, `=1000 requests`) and a
 * declared-but-empty line, which is how a `.env` leaves a setting unset while still
 * listing it. Empty must mean UNSET — silently unlimited is not a value this variable
 * has, and neither is zero, which would refuse every document including the first.
 *
 * ## Why the rejections are driven through `prepare`
 *
 * A parser test can show that a string is refused; only the dimension can show that the
 * refusal is a configuration error naming the variable AND that it lands before any
 * provider request. Each of the two provider counts is read around every case, so
 * "refused" also means "nothing was spent".
 *
 * ## Why this file names nothing from the KG core
 *
 * Two things it used to borrow from there are now taken from the wiki side instead, and
 * neither is a loss:
 *
 *   - the configuration error is asserted by the NAME it declares for itself rather than
 *     with `instanceof`, because importing the class would cross the `wiki → kg` boundary
 *     that `no-restricted-imports` counts for `test/**` and whose ratchet accepts no new
 *     allowance for a test file. The name is the class's own declaration, so this still
 *     pins WHICH error was raised, not merely that something was thrown;
 *   - the chunk count is taken from the dimension's own detect-only report — the count
 *     the production chunker produced inside the adapter — instead of from a direct call
 *     to the chunker, which lives on the KG side. {@link reportedChunkCount} states why
 *     that number is still derived from production code and not a literal.
 *
 * The provider edge is stubbed by `test/fixtures/kg-provider-fetch.ts`, so no case here
 * reaches a provider or costs money; nothing in this file needs a database.
 */

import "./kg-runtime-provider-env.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createKgDimension } from "../../packages/wiki/src/dimensions/kg/index.js";
import {
  ExtractionRequestCapError,
  KG_EXTRACTION_REQUEST_CAP_DEFAULT,
  KG_EXTRACTION_REQUEST_CAP_ENV_VAR,
  resolveExtractionRequestCap,
} from "../../packages/wiki/src/dimensions/kg/request-cap.js";
import type { Dimension } from "../../packages/wiki/src/dimensions/types.js";
import {
  chatRequestCount,
  clearCapturedRequests,
  embeddingRequestCount,
  installKgProviderStub,
  uninstallKgProviderStub,
} from "../fixtures/kg-provider-fetch.js";

/**
 * The provider edge, installed before every case and removed after it.
 *
 * Every "nothing was spent" assertion in this file is ABSOLUTE, so the capture starts empty
 * for each case instead of being read as a delta: a request left behind by an earlier case
 * would have to be subtracted, and that subtraction is what hides a real one. The cap
 * variable is cleared here as well as after, so a case can never inherit a value from the
 * case before it.
 */
beforeEach(() => {
  clearCapturedRequests();
  installKgProviderStub();
  delete process.env[KG_EXTRACTION_REQUEST_CAP_ENV_VAR];
});

afterEach(() => {
  uninstallKgProviderStub();
  delete process.env[KG_EXTRACTION_REQUEST_CAP_ENV_VAR];
});

/** One sentence, repeated far past the chunk budget; see {@link MULTI_CHUNK_BODY}. */
const SENTENCE = "The gateway routes embedding traffic for the office.";

/** A body that cannot fit in one chunk: the unit the cap is counted in is chunks. */
const MULTI_CHUNK_BODY = Array.from(
  { length: 200 },
  (_, index) => `${SENTENCE} ${String(index)}.`,
).join(" ");

/** The document a cap breach is measured on, built as an ingest builds one. */
const INPUT = {
  source: "https://example.test/cap",
  title: "Cap fixture",
  document: `# Cap\n\n${MULTI_CHUNK_BODY}\n`,
  body: MULTI_CHUNK_BODY,
};

/** What {@link reportedChunkCount} has learned, memoized: it costs a tokenisation pass. */
let reportedChunks: number | undefined;

/**
 * How many chunks {@link MULTI_CHUNK_BODY} yields, as the DIMENSION reports it.
 *
 * The number comes from a detect-only run's own report, which is the count the production
 * chunker produced INSIDE the adapter — the same count a cap breach must name. It is not a
 * literal, so it cannot drift from the chunker; and it is not a direct call to the chunker
 * either, because that function lives on the KG side of the `wiki → kg` boundary. S9
 * freezes chunk boundaries, and the dry-run suite pins this count against the real path's,
 * so a report that disagreed with the extracted chunks would fail there.
 *
 * Memoized because every case needs the same number and each derivation re-splits the body.
 *
 * @returns The chunk count the cap is counted in.
 */
async function reportedChunkCount(): Promise<number> {
  if (reportedChunks === undefined) {
    const preview = await dimension(true).prepare(INPUT);
    const committed = await dimension(true).commit(preview);
    reportedChunks = chunksNamedIn(committed.summary);
  }
  return reportedChunks;
}

/**
 * The leading count in a `kg:dry-run(<n> chunks, …)` report.
 *
 * Throws rather than returning a default: a report that does not carry its count is the
 * failure this helper exists to notice, not a case to absorb.
 *
 * @param summary - The summary a detect-only `commit` rendered.
 * @returns The chunk count it reports.
 */
function chunksNamedIn(summary: string): number {
  const named = /^kg:dry-run\((\d+) chunks/.exec(summary)?.[1];
  if (named === undefined) throw new Error(`the report names no chunk count: ${summary}`);
  return Number(named);
}

/**
 * The name an error declares for itself.
 *
 * See the file header: the class lives in the KG core, so its identity is asserted through
 * this name to keep the test on the wiki side of the boundary.
 *
 * @param error - Whatever was thrown.
 * @returns Its `name`, or its string form when it is not an `Error`.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

/**
 * The dimension under test, in whichever mode the case needs.
 *
 * @param dryRun - True for the detect-only path, absent for the real one.
 * @returns A dimension bound to a Stack that stores no ontology declaration.
 */
function dimension(dryRun?: boolean): Dimension {
  return createKgDimension({
    stackId: "aaaaaaaa-0000-4000-8000-00000000aaaa",
    stackName: "cap fixture",
    ...(dryRun === true ? { dryRun: true } : {}),
    loadOntology: async () => undefined,
  });
}

/** Configure the cap through the environment the dimension reads. */
function configureCap(value: string): void {
  process.env[KG_EXTRACTION_REQUEST_CAP_ENV_VAR] = value;
}

/**
 * Run one `prepare` under a configured value and return the error it refused with.
 *
 * A resolved `prepare` is a failure of this helper, not a pass: the case exists because
 * the cap must refuse, and a silent success is the defect class T3 removes.
 *
 * @param value - Value to configure `LLMWIKI_KG_MAX_EXTRACTION_REQUESTS` with.
 * @param dryRun - True to drive the detect-only path instead of the real one.
 * @returns Whatever `prepare` threw.
 */
async function refusalFor(value: string, dryRun?: boolean): Promise<unknown> {
  configureCap(value);
  return await dimension(dryRun).prepare(INPUT).then(
    () => {
      throw new Error("prepare resolved, so the cap was not enforced");
    },
    (error: unknown) => error,
  );
}

/** Both provider counts, asserted together wherever nothing may be spent. */
function expectNothingSpent(): void {
  expect(chatRequestCount()).toBe(0);
  expect(embeddingRequestCount()).toBe(0);
}

/**
 * Prepare the document and assert an admitted run spent what it should.
 *
 * The two admitted paths — a blank variable and a variable set exactly at the count —
 * differ only in the configuration that let them through, so the assertions that the run
 * really extracted are stated once: one batched embedding request for the document, then
 * one chat request per chunk, which is the quantity the cap bounds.
 */
async function expectAdmittedExtraction(): Promise<void> {
  const chunkCount = await reportedChunkCount();
  const prepared = await dimension().prepare(INPUT);

  expect(prepared.unchanged).toBe(false);
  expect(embeddingRequestCount()).toBe(1);
  expect(chatRequestCount()).toBe(chunkCount);
}

describe("the cap resolution chain", () => {
  it("uses the documented default when the variable is unset", () => {
    expect(resolveExtractionRequestCap({})).toEqual({
      kind: "capped",
      cap: KG_EXTRACTION_REQUEST_CAP_DEFAULT,
    });
  });

  it("treats an empty or blank value as unset, not as unlimited", () => {
    const capped = { kind: "capped", cap: KG_EXTRACTION_REQUEST_CAP_DEFAULT };

    expect(resolveExtractionRequestCap({ [KG_EXTRACTION_REQUEST_CAP_ENV_VAR]: "" })).toEqual(capped);
    expect(resolveExtractionRequestCap({ [KG_EXTRACTION_REQUEST_CAP_ENV_VAR]: "   " })).toEqual(
      capped,
    );
  });

  it("returns a configured positive whole number", () => {
    expect(resolveExtractionRequestCap({ [KG_EXTRACTION_REQUEST_CAP_ENV_VAR]: "7" })).toEqual({
      kind: "capped",
      cap: 7,
    });
  });
});

describe("a misconfigured cap is a configuration error, raised before any request", () => {
  it("refuses a non-numeric value, naming the variable", async () => {
    const error = await refusalFor("unlimited");

    expect(errorName(error)).toBe("ConfigValidationError");
    expect(String(error)).toContain(KG_EXTRACTION_REQUEST_CAP_ENV_VAR);
    expectNothingSpent();
  });

  it("refuses zero, naming the variable", async () => {
    const error = await refusalFor("0");

    expect(errorName(error)).toBe("ConfigValidationError");
    expect(String(error)).toContain(KG_EXTRACTION_REQUEST_CAP_ENV_VAR);
    expectNothingSpent();
  });

  it("refuses a negative value, naming the variable", async () => {
    const error = await refusalFor("-5");

    expect(errorName(error)).toBe("ConfigValidationError");
    expect(String(error)).toContain(KG_EXTRACTION_REQUEST_CAP_ENV_VAR);
    expectNothingSpent();
  });

  it("admits a real run when the variable is left blank", async () => {
    // Empty means unset, so the default applies and the document is extracted.
    configureCap("");

    await expectAdmittedExtraction();
  });
});

describe("the extraction request cap", () => {
  it("costs one tokenisation pass, never a request, to count a document", async () => {
    // Printed, never asserted on time: this branch may only move speed, so the CPU the cap
    // door adds to every real run is reported rather than bounded. The door runs the same
    // single tokenisation pass a real run pays for its second chunking, and it sends
    // nothing — which is the assertion that belongs to a spend cap.
    const startedAt = performance.now();
    const prepared = await dimension(true).prepare(INPUT);
    const elapsedMs = performance.now() - startedAt;
    const chunkCount = await reportedChunkCount();

    console.log(`kg-chunk-count-cost ${elapsedMs.toFixed(3)}ms for ${String(chunkCount)} chunks`);
    expect(prepared.unchanged).toBe(false);
    expectNothingSpent();
  });

  it("refuses a real run above the cap before any request is sent", async () => {
    const chunkCount = await reportedChunkCount();
    const error = await refusalFor("1");

    expect(error).toBeInstanceOf(ExtractionRequestCapError);
    // The configured cap and the actual count, both named: the operator needs the
    // distance between them to decide what to raise the cap to.
    expect(String(error)).toContain(KG_EXTRACTION_REQUEST_CAP_ENV_VAR);
    expect(String(error)).toContain(`is set to 1: this document yields ${String(chunkCount)}`);
    expectNothingSpent();
  });

  it("refuses a detect-only run above the cap too, sending nothing", async () => {
    const error = await refusalFor("1", true);

    expect(error).toBeInstanceOf(ExtractionRequestCapError);
    expectNothingSpent();
  });

  it("admits a real run at the cap and extracts one chunk per request", async () => {
    configureCap(String(await reportedChunkCount()));

    // At the cap the run is admitted, and the cap counts chat requests: one per chunk.
    await expectAdmittedExtraction();
  });
});
