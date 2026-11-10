/**
 * @file packages/api/src/host/port-invocation.test.ts
 * @description The dimensions port is USED by the api ingest path, not merely
 * accepted by it.
 *
 * WHY THIS FILE EXISTS. Every other proof of this seam is a proof of REFUSAL: a
 * caller that received no port gets `MissingDimensionsPortError`. A port that is
 * threaded all the way down and then never invoked passes every one of those tests,
 * because the refusal fires before the missing invocation would have happened. That
 * is the decorative consumer this slice exists to disprove, and the only way to
 * catch it is to hand the REAL path a recording port and assert three things: that
 * `resolve` was called, that the request it received is the one the ingest actually
 * stated, and that the dimensions it returned are the ones the ingest wrote through.
 *
 * WHERE THE PATH IS DRIVEN. `POST /api/ingest` over a real `startHost` listener, not
 * an internal call. The wiring under test IS the wiring between the entry point and
 * the shared function, so a test that skipped either end would prove only that the
 * fake works.
 *
 * WHY THE DIMENSIONS ARE REAL. The recording port delegates to the production port
 * and wraps whatever it returns, so the run writes actual rows in this suite's own
 * Stack and the assertion is about the object the ingest was handed, not about a
 * mock's return value.
 *
 * WHY THE DATABASE IS UNAVOIDABLE HERE. `writeToDimensions` resolves the Stack
 * through a real query before it asks for dimensions, so the invocation cannot be
 * observed on a path that has no database. `provisionEnvStack` gives this file a
 * Stack of its own and exports the environment the ingest path reads; when no
 * database is reachable every case here is skipped rather than silently green.
 */
import { afterAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MissingDimensionsPortError } from "@repo/foundation";
import type { DimensionsPort, DimensionsRequest } from "@repo/foundation";
import type { resolveDimensions } from "@repo/wiki/dimensions-activation";
import { createJobRegistry } from "@repo/wiki/job-registry";
import { startMCPServer } from "@repo/wiki/mcp";
import { buildViewerSnapshot } from "@repo/wiki/viewer-snapshot";
import { createDimensionsPort } from "../dimensions/port.js";
import { handleApiRequest } from "./api.js";
import { startHost } from "./server.js";
import { provisionEnvStack } from "../../../../test/fixtures/env-stack.js";
import { scratchProjectRoot } from "../../../../test/fixtures/host-scratch.js";

/** wiki's own dimension type, reached through the resolver rather than by name. */
type PortDimension = ReturnType<typeof resolveDimensions>[number];

/** Enough body text to clear the minimum content length the ingest enforces. */
const BODY = "A document ingested through the api route, long enough to be accepted as a source.";

/** The suite's Stack, exported to the environment the ingest path reads. */
const env = await provisionEnvStack("api-port-invocation");

afterAll(() => env.cleanup());

/** A port plus the evidence of what the ingest did with it. */
interface RecordingPort {
  /** The port handed to the host. */
  readonly port: DimensionsPort<PortDimension>;
  /** Every request `resolve` received, in call order. */
  readonly requests: DimensionsRequest[];
  /** Names of the dimensions whose `commit` actually ran, in call order. */
  readonly committed: string[];
}

/**
 * Build a port that records its calls and still does the real work.
 *
 * `resolve` delegates to the production port, so the dimensions that reach the
 * coordinator are the ones a shipped host would get; each one is wrapped so a
 * `commit` proves the ingest wrote THROUGH the object this port returned rather
 * than through a copy it resolved for itself.
 *
 * @returns The port and the lists it appends to.
 */
function recordingPort(): RecordingPort {
  const requests: DimensionsRequest[] = [];
  const committed: string[] = [];
  const real = createDimensionsPort();
  return {
    requests,
    committed,
    port: {
      resolve(request: DimensionsRequest) {
        requests.push(request);
        return real.resolve(request).map((dimension) => ({
          ...dimension,
          commit: (prepared: Parameters<typeof dimension.commit>[0], scope?: Parameters<typeof dimension.commit>[1]) => {
            committed.push(dimension.name);
            return dimension.commit(prepared, scope);
          },
        }));
      },
    },
  };
}

/**
 * Send one synchronous ingest at a host and return the status and the decoded body.
 *
 * @param root - Project root the host mutates.
 * @param dimensionsPort - The port the host should be given, when the case injects one.
 * @returns The HTTP status and the parsed response body.
 */
async function ingestThroughHost(
  root: string,
  dimensionsPort?: DimensionsPort<PortDimension>,
): Promise<{ status: number; body: { writeStatus?: string; filename?: string } }> {
  const source = path.join(root, "recorded-source.txt");
  await writeFile(source, BODY, "utf8");
  const handle = await startHost({
    viewerSnapshot: await buildViewerSnapshot(root),
    port: 0,
    projectRoot: root,
    includeGraph: false,
    ...(dimensionsPort === undefined ? {} : { dimensionsPort }),
  });
  try {
    const response = await fetch(`http://${handle.host}:${handle.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, compile: false }),
    });
    return { status: response.status, body: (await response.json()) as never };
  } finally {
    await handle.close();
  }
}

/** A request body the async route accepts, handed to `handleApiRequest` directly. */
function postIngestRequest(): IncomingMessage {
  const body = JSON.stringify({ source: "/tmp/never-fetched.md", compile: false, async: true });
  return {
    url: "/api/ingest",
    method: "POST",
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  } as unknown as IncomingMessage;
}

/** The smallest response object `writeJsonError` can write to. */
interface CapturedResponse extends ServerResponse {
  /** Everything passed to `end`, joined. */
  payload: string;
}

/**
 * Build a response that captures its status and body.
 *
 * @returns The capturing response.
 */
function capturingResponse(): CapturedResponse {
  const captured = {
    statusCode: 0,
    headersSent: false,
    payload: "",
    setHeader: () => captured,
    end: (chunk?: unknown) => {
      captured.headersSent = true;
      captured.payload += typeof chunk === "string" ? chunk : "";
      return captured;
    },
  };
  return captured as unknown as CapturedResponse;
}

describe.skipIf(!env.reachable)("the port the api ingest path receives", () => {
  it("calls the port with the request the ingest stated and writes through what it returned", async () => {
    const root = await scratchProjectRoot("api-port-invocation-");
    const recording = recordingPort();

    const { status, body } = await ingestThroughHost(root, recording.port);

    expect(status).toBe(200);
    // 1. CALLED. A threaded-but-never-invoked port is decorative, and this is the
    // assertion a loud-failure suite cannot make.
    expect(recording.requests).toHaveLength(1);
    const received = recording.requests[0] as DimensionsRequest;
    // 2. The request carries what the ingest itself resolved and is bound to.
    expect(received.root).toBe(root);
    expect(received.env.AKS_STACK_ID).toBe(env.stackId);
    expect(received.env.LLMWIKI_DIMENSIONS).toBe("wiki");
    expect(received.stackId).toBe(env.stackId);
    expect(received.only).toEqual(["wiki", "kg"]);
    expect(received.db).toBeDefined();
    // 3. The dimensions it returned are the ones the ingest used: the wiki
    // dimension this port handed over is the one that committed the write.
    expect(recording.committed).toEqual(["wiki"]);
    expect(body.writeStatus).toBe("created");
  }, 120_000);

  it("resolves internally, and writes, when the host was given no port", async () => {
    // The other half of the contract: an ABSENT port means "resolve internally",
    // never "throw" and never "write nothing". A host built without one therefore
    // still ingests, which is what keeps every existing caller working.
    const root = await scratchProjectRoot("api-port-absent-");

    const { status, body } = await ingestThroughHost(root);

    expect(status).toBe(200);
    expect(body.writeStatus).toBe("created");
    expect(body.filename).toBeDefined();
  }, 120_000);
});

describe("a caller that needs dimensions and received no port", () => {
  it("refuses the api ingest route before it mints a job", async () => {
    const root = await scratchProjectRoot("api-port-refusal-");
    const ingestJobs = createJobRegistry();
    const res = capturingResponse();

    const handled = await handleApiRequest(root, postIngestRequest(), res, { ingestJobs });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(500);
    const envelope = JSON.parse(res.payload) as { error: { code: string; message: string } };
    expect(envelope.error.message).toContain(
      'LLMWIKI_DIMENSIONS enables "wiki", "kg" but no DimensionsPort was supplied to resolve it.',
    );
    // Rejected input leaves stored state unchanged: no job was created, so nothing
    // will ever run untracked and no poller can find phantom work.
    expect(ingestJobs.list()).toHaveLength(0);
  });

  it("refuses to build the stdio MCP server", async () => {
    // The `serve` mode of the container entry constructs its server here, so a
    // wiring mistake is refused at construction instead of mid-ingest.
    await expect(startMCPServer({ root: "/tmp/never-served", version: "0" })).rejects.toBeInstanceOf(
      MissingDimensionsPortError,
    );
  });
});
