/**
 * @file test/sdk/ingest-dimensions-port.test.ts
 * @description The port `CreateWikiOptions.dimensionsPort` names is INVOKED, and the
 * refusal for a missing one lives at the internal seam only.
 *
 * ## Why "the port is accepted" is not the claim
 *
 * `CreateWikiOptions.dimensionsPort` is optional, so a facade that destructured it and
 * never forwarded it would compile, typecheck and pass every existing suite while
 * resolving the dimensions from the ambient path instead. A port that is accepted and
 * never called is the decorative consumer this slice exists to disprove, and the only
 * observable that separates the two is a recording fake that is asked what request it
 * received.
 *
 * ## Why the fake throws after recording
 *
 * The row a real dimension would write is not the subject; the REQUEST is. Throwing
 * keeps the assertion on the request the ingest resolved — root, environment, Stack
 * and handle — and stops the call before any row exists to read back. Asserting stored
 * rows as well would let a passing test hide which of the two paths produced them.
 *
 * ## Why the request is asserted member by member
 *
 * An ingest that called the port with a fresh `process.env` or an unresolved Stack
 * would still be "called exactly once". Each member asserted here is one the ingest
 * path already resolved, so a passing test says the port answered the same question
 * the internal resolution would have.
 *
 * ## What the second test proves, and what it refuses to claim
 *
 * `MissingDimensionsPortError` is proven EXECUTED, at the internal seam that requires a
 * port: `startMCPServer` refuses before a transport is connected. It is NOT proven
 * reachable from the published surface, and this file says so rather than dressing an
 * internal proof as a public one: `CreateWikiOptions.dimensionsPort` is optional, so no
 * `createWiki` call can be required to supply one and the refusal cannot fire there by
 * design. The public half of the pair is the observable that omission SUCCEEDS.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MissingDimensionsPortError } from "@repo/foundation";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";
import { startMCPServer } from "../../packages/wiki/src/mcp/server.js";
import type { DimensionsPort, DimensionsRequest } from "../../packages/wiki/src/sdk/compiler-composition.js";
import type { Dimension } from "../../packages/wiki/src/dimensions/types.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";

/** Enough body text to clear the minimum source length the ingest enforces. */
const BODY = "Body long enough to clear the minimum source length the ingest enforces.";

/** The ingest ceiling `ingestSource` states to the port: every shipped dimension. */
const INGEST_CEILING = ["wiki", "kg"];

/**
 * A port that records the request it received and THEN refuses.
 *
 * Throwing keeps the assertion about the REQUEST: the ingest cannot reach a write, so
 * no stored row can be mistaken for evidence of which resolution path ran.
 *
 * @param received - Sink the request is pushed into, in call order.
 * @returns A port typed against the published shape, not the engine's.
 */
function recordingPort(received: DimensionsRequest[]): DimensionsPort<Dimension> {
  return {
    resolve: (request) => {
      received.push(request);
      throw new Error("the recording port refuses once it has recorded the request");
    },
  };
}

/**
 * The value a promise rejected with, or `undefined` when it resolved.
 *
 * @param promise - Promise whose outcome is being inspected instead of propagated.
 * @returns The rejection reason, or `undefined`.
 */
async function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

describe("SDK ingest invokes the supplied dimensions port", () => {
  let probe: ProbeStack;
  let root: string;

  beforeEach(async () => {
    probe = await createProbeStack("sdk-port");
    root = await mkdtemp(path.join(tmpdir(), "sdk-port-ingest-"));
  });

  afterEach(async () => {
    await probe.harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("calls the supplied port once with the request the ingest resolved", async () => {
    const source = path.join(root, "note.md");
    await writeFile(source, BODY, "utf-8");
    const env = probe.env();
    const received: DimensionsRequest[] = [];
    const port = recordingPort(received);

    const failure = await settled(createWiki({ root, env, dimensionsPort: port }).ingest({ source }));

    expect(received).toHaveLength(1);
    expect(received[0].only).toEqual(INGEST_CEILING);
    expect(received[0].root).toBe(root);
    expect(received[0].env).toBe(env);
    expect(received[0].stackId).toBe(probe.harness.stackId);
    expect(typeof received[0].db).toBe("object");
    expect(failure).toBeInstanceOf(Error);
  }, 60_000);

  it("refuses a missing port at the internal seam, never at the published one", async () => {
    // EXECUTED, at the INTERNAL seam: `startMCPServer` is the API-owned entry point
    // that requires a port, and it refuses before any transport is connected.
    const refusal = await settled(startMCPServer({ root, version: "0.0.0-published-entry-test" }));
    expect(refusal).toBeInstanceOf(MissingDimensionsPortError);
    expect(refusal).toHaveProperty("name", "MissingDimensionsPortError");

    // UNREACHABLE FROM THE PUBLISHED SURFACE, BY DESIGN. `createWiki` supplies the
    // composed default, so no public call is ever required to pass a port and the class
    // asserted above cannot surface through `CreateWikiOptions`. What is observed here
    // is the public half: omission SUCCEEDS where the required seam REFUSES.
    const ingested = createWiki({ root, env: probe.env() }).ingestText({
      title: "No Port Supplied",
      text: BODY,
    });
    await expect(ingested).resolves.toBeDefined();
  }, 60_000);
});
