/**
 * @file packages/llmwiki-kg/ts/src/request-transaction-response.test.ts
 * @description Pin `ResponseRecorder`'s own guarantees: fail closed, record, then replay.
 *
 * ## Why this module needs direct tests at all
 *
 * Every other suite that touches the commit-before-responding change exercises the
 * recorder THROUGH the wrapper, against a real Express app and a real database. That
 * is the right level for asking "does the client see the committed row?", and it is
 * the wrong level for the recorder's most consequential property, because a whole
 * class of its behaviour is invisible from above:
 *
 * - A fail-closed proxy that quietly degrades — `get` returning `undefined` instead
 *   of throwing, `set` accepting any member — produces no symptom in a happy-path
 *   request. The body still arrives; a handler simply dropped a `setHeader`, a
 *   `flushHeaders`, a `sendStatus`. Every wrapper-level test stays green while the
 *   recorder silently stops recording the very call it exists to preserve. Only a
 *   direct assertion that the throw HAPPENS can pin it, which is why one test here
 *   deliberately reads an unsupported member and expects to be refused.
 * - Replay order and argument identity are what make bodies byte-for-byte identical
 *   to the pre-change ones. If `Reflect.apply` were replaced by a call that
 *   re-created arguments, a `Buffer` could arrive as a string or a listener could be
 *   wrapped, and no endpoint-level body comparison would name the cause.
 * - The two mid-replay failure branches (before headers, after headers) differ only
 *   in whether the connection is destroyed. Both end in a rethrow, so a test that
 *   only asserts "it threw" cannot tell them apart, and a regression that drops the
 *   `destroy` would turn a failed body into a plausible short one without failing
 *   any suite above this file.
 * - Deferring `on`/`once` is a non-obvious trade: a listener bound to the recorder
 *   would never fire. The only way to state "registered later, on the real response,
 *   exactly once, same function" is to look at what the real response received.
 *
 * ## Why a hand-written fake instead of Express and supertest
 *
 * The subject is an adapter: it takes a `Response`-shaped object and calls it later.
 * A fake that records `(member, arguments)` is the exact observation the assertions
 * need — counters, ordering, identity — and it needs no socket, no app, no database
 * and no timing, so these tests are deterministic and independent of whether a
 * Postgres container happens to be up. Nothing here asserts against internals: every
 * assertion reads either the proxy handed to the handler or the calls that reached
 * the fake real response.
 *
 * The fake models `headersSent` because the recorder models it, and the recorder
 * reads the REAL response's `headersSent` to decide between "propagate" and "destroy
 * first", which is precisely the distinction the failure tests pin.
 */

import { describe, expect, it } from "vitest";
import type { Response } from "express";

import { ResponseRecorder } from "./request-transaction-response.js";

/** One call the real response received, with the exact arguments it received. */
interface FakeCall {
  readonly member: string;
  readonly args: readonly unknown[];
}

/** How the fake real response should misbehave, by zero-based replay index. */
interface FakeOptions {
  /** Throw instead of completing the call at this zero-based index. */
  readonly failAtIndex?: number;
  /** Start with `headersSent` already true, as a response that already answered does. */
  readonly headersSentOnEntry?: boolean;
}

/** The stand-in for the real `Response`, plus what it observed. */
interface FakeRealResponse {
  readonly response: Response;
  readonly calls: FakeCall[];
  readonly destroyed: unknown[];
  readonly failures: Error[];
  readonly statusCode: () => number;
  readonly headersSent: () => boolean;
}

/** The status a response carries before anything sets one. */
const DEFAULT_STATUS_CODE = 200;

/**
 * Builds a `Response`-shaped fake that records every call it receives.
 *
 * @param options - Which replayed call, if any, must fail; initial `headersSent`.
 * @returns The fake typed as a `Response` plus the calls, destroys and failures.
 */
function createFakeRealResponse(options: FakeOptions = {}): FakeRealResponse {
  const calls: FakeCall[] = [];
  const destroyed: unknown[] = [];
  const failures: Error[] = [];
  const state = {
    statusCode: DEFAULT_STATUS_CODE,
    headersSent: options.headersSentOnEntry ?? false,
  };

  const record = (member: string, args: readonly unknown[]): void => {
    calls.push({ member, args });
    if (options.failAtIndex === calls.length - 1) {
      const failure = new Error(`fake real response failed at "${member}"`);
      failures.push(failure);
      throw failure;
    }
  };

  const fake: Record<string, unknown> = {
    get statusCode(): number {
      return state.statusCode;
    },
    get headersSent(): boolean {
      return state.headersSent;
    },
    get locals(): Record<string, unknown> {
      return { scope: "request" };
    },
    get req(): Record<string, unknown> {
      return { url: "/probe" };
    },
    status: (code: number): void => {
      state.statusCode = code;
      record("status", [code]);
    },
    setHeader: (name: string, value: unknown): void => record("setHeader", [name, value]),
    json: (body: unknown): void => {
      state.headersSent = true;
      record("json", [body]);
    },
    write: (chunk: unknown): void => {
      state.headersSent = true;
      record("write", [chunk]);
    },
    end: (...args: unknown[]): void => {
      state.headersSent = true;
      record("end", args);
    },
    on: (event: string, listener: unknown): void => record("on", [event, listener]),
    once: (event: string, listener: unknown): void => record("once", [event, listener]),
    destroy: (error?: unknown): void => {
      destroyed.push(error);
    },
  };

  return {
    response: fake as unknown as Response,
    calls,
    destroyed,
    failures,
    statusCode: () => state.statusCode,
    headersSent: () => state.headersSent,
  };
}

describe("ResponseRecorder fail-closed member set", () => {
  it("throws naming the member when a handler calls an unsupported method", () => {
    const fake = createFakeRealResponse();
    const recorder = new ResponseRecorder(fake.response);

    expect(() => recorder.response.send("x")).toThrow(/Response member "send"/);

    // The refused call must not have been recorded, so replay has nothing to send.
    recorder.replay();
    expect(fake.calls).toEqual([]);
  });

  it("throws naming the member when a handler assigns an unsupported property", () => {
    const fake = createFakeRealResponse();
    const recorder = new ResponseRecorder(fake.response);
    const target = recorder.response as unknown as Record<string, unknown>;

    expect(() => {
      target.foo = 1;
    }).toThrow(/Response member "foo"/);

    recorder.replay();
    expect(fake.calls).toEqual([]);
  });

  it("throws naming the member when a handler only READS an unsupported property", () => {
    const fake = createFakeRealResponse();
    const recorder = new ResponseRecorder(fake.response);

    // `getHeader` exists on the real Response, which is why silence would be dangerous.
    expect(() => recorder.response.getHeader).toThrow(/Response member "getHeader"/);
  });
});

describe("ResponseRecorder modelled read-back state", () => {
  it("reports statusCode 200 until set, then the set code, and replays an assignment", () => {
    const fake = createFakeRealResponse();
    const recorder = new ResponseRecorder(fake.response);

    expect(recorder.response.statusCode).toBe(DEFAULT_STATUS_CODE);
    recorder.response.status(201);
    expect(recorder.response.statusCode).toBe(201);
    recorder.response.statusCode = 418;
    expect(recorder.response.statusCode).toBe(418);

    recorder.replay();
    expect(fake.statusCode()).toBe(418);
    expect(fake.calls).toEqual([
      { member: "status", args: [201] },
      { member: "status", args: [418] },
    ]);
  });

  it("reports headersSent false until a body call, for both json and write+end", () => {
    const jsonRecorder = new ResponseRecorder(createFakeRealResponse().response);
    expect(jsonRecorder.response.headersSent).toBe(false);
    jsonRecorder.response.json({ ok: true });
    expect(jsonRecorder.response.headersSent).toBe(true);

    const streamRecorder = new ResponseRecorder(createFakeRealResponse().response);
    expect(streamRecorder.response.headersSent).toBe(false);
    streamRecorder.response.write("chunk");
    expect(streamRecorder.response.headersSent).toBe(true);
    streamRecorder.response.end();
    expect(streamRecorder.response.headersSent).toBe(true);
  });
});

describe("ResponseRecorder record-then-replay fidelity", () => {
  it("chains status and json, and replays status then json with those arguments", () => {
    const fake = createFakeRealResponse();
    const recorder = new ResponseRecorder(fake.response);
    const body = { id: "stack-1" };

    const returned = recorder.response.status(201).json(body);
    expect(returned).toBe(recorder.response);

    recorder.replay();
    expect(fake.calls).toEqual([
      { member: "status", args: [201] },
      { member: "json", args: [body] },
    ]);
    expect(fake.statusCode()).toBe(201);
  });

  it("defers on and once until replay, then binds the same listener once each", () => {
    const fake = createFakeRealResponse();
    const recorder = new ResponseRecorder(fake.response);
    const listener = (): void => {};

    recorder.response.on("finish", listener);
    recorder.response.once("close", listener);

    // Nothing may be bound during the transaction: nothing would ever emit here.
    expect(fake.calls).toEqual([]);

    recorder.replay();
    expect(fake.calls.map((call) => call.member)).toEqual(["on", "once"]);
    expect(fake.calls[0]?.args).toEqual(["finish", listener]);
    expect(fake.calls[1]?.args).toEqual(["close", listener]);
    expect(fake.calls[0]?.args[1]).toBe(listener);
    expect(fake.calls[1]?.args[1]).toBe(listener);
  });

  it("replays the Buffer path in order, keeping the buffer by identity", () => {
    const fake = createFakeRealResponse();
    const recorder = new ResponseRecorder(fake.response);
    const chunk = Buffer.from("hi");

    recorder.response.status(200);
    recorder.response.setHeader("x-buffer-kind", "octet-stream");
    recorder.response.setHeader("content-length", "2");
    recorder.response.write(chunk);
    recorder.response.end();

    recorder.replay();
    expect(fake.calls.map((call) => call.member)).toEqual([
      "status",
      "setHeader",
      "setHeader",
      "write",
      "end",
    ]);
    expect(fake.calls[0]?.args).toEqual([200]);
    expect(fake.calls[1]?.args).toEqual(["x-buffer-kind", "octet-stream"]);
    expect(fake.calls[2]?.args).toEqual(["content-length", "2"]);
    const written = fake.calls[3]?.args[0];
    expect(Buffer.isBuffer(written)).toBe(true);
    expect(written).toBe(chunk);
    expect(fake.calls[4]?.args).toEqual([]);
  });

  it("replays nothing when the real response has already sent headers", () => {
    const fake = createFakeRealResponse({ headersSentOnEntry: true });
    const recorder = new ResponseRecorder(fake.response);

    recorder.response.status(500).json({ error: "already answered" });
    recorder.replay();

    expect(fake.calls).toEqual([]);
    expect(fake.statusCode()).toBe(DEFAULT_STATUS_CODE);
  });

  it("keeps every recorded call away from the real response until replay", () => {
    const fake = createFakeRealResponse();
    const recorder = new ResponseRecorder(fake.response);
    const listener = (): void => {};

    recorder.response.setHeader("x-probe", "1");
    recorder.response.status(201).json({ id: "row-1" });
    recorder.response.on("finish", listener);

    expect(fake.calls).toEqual([]);
    expect(fake.statusCode()).toBe(DEFAULT_STATUS_CODE);
    expect(fake.headersSent()).toBe(false);

    recorder.replay();
    expect(fake.calls.map((call) => call.member)).toEqual([
      "setHeader",
      "status",
      "json",
      "on",
    ]);
  });
});

describe("ResponseRecorder mid-replay failure", () => {
  it("rethrows without destroying when the failure lands before headers are sent", () => {
    const fake = createFakeRealResponse({ failAtIndex: 0 });
    const recorder = new ResponseRecorder(fake.response);

    recorder.response.status(201).json({ id: "row-1" });

    expect(() => recorder.replay()).toThrow(/fake real response failed at "status"/);
    expect(fake.headersSent()).toBe(false);
    expect(fake.destroyed).toEqual([]);
  });

  it("destroys the connection with that error and rethrows when headers are already out", () => {
    const fake = createFakeRealResponse({ failAtIndex: 2 });
    const recorder = new ResponseRecorder(fake.response);

    recorder.response.status(200);
    recorder.response.write(Buffer.from("partial"));
    recorder.response.end();

    expect(() => recorder.replay()).toThrow(/fake real response failed at "end"/);
    expect(fake.destroyed).toHaveLength(1);
    expect(fake.destroyed[0]).toBe(fake.failures[0]);
  });
});
