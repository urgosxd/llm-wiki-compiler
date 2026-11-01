/**
 * @file packages/llmwiki-kg/ts/src/core/llm/retry.test.ts
 * @description The provider retry policy: what is worth retrying, and what a
 * run that exhausts its attempts reports.
 *
 * The two questions this file answers are the ones that decide whether a broken
 * extraction is VISIBLE. A transient failure that is never retried throws away a
 * document over one bad response; a permanent failure that IS retried delays the
 * same answer while looking like activity. And an exhausted run must keep every
 * failure it saw, because "3 failures" without the reasons is a number an
 * operator cannot act on.
 */

import { describe, expect, it, vi } from "vitest";

import { LlmError } from "./errors.js";
import {
  ProviderUnavailableError,
  TRANSIENT_ATTEMPTS,
  TRANSIENT_BACKOFF_BASE_MS,
  isTransientProviderFailure,
  withProviderRetry,
} from "./retry.js";

/**
 * A failure carrying an HTTP status, shaped exactly as `postJson` raises one.
 *
 * The message format is copied from the real producer
 * (`${endpoint} answered ${status}: ${detail}`), because a test that asserts on
 * a message the code never emits proves nothing about the code.
 */
function statusError(status: number): LlmError {
  const endpoint = "https://gateway.invalid/v1/chat/completions";
  return new LlmError(`${endpoint} answered ${status}: provider detail`, endpoint, status);
}

/** A failure with no status: DNS, TLS, connection refused, aborted request. */
function transportError(): LlmError {
  return new LlmError("request failed: ECONNREFUSED", "https://gateway.invalid/v1/chat");
}

/** A sleep that records instead of waiting, so no test spends wall time. */
function recordingSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
}

describe("the transient attempt budget", () => {
  it("is three, asserted so the constant cannot drift unnoticed", () => {
    // A silently raised budget turns an outage into a long hang; a lowered one
    // turns a recoverable rate limit into a lost document.
    expect(TRANSIENT_ATTEMPTS).toBe(3);
  });

  it("backs off from a positive base, so retries are never a tight loop", () => {
    expect(TRANSIENT_BACKOFF_BASE_MS).toBeGreaterThan(0);
  });
});

describe("isTransientProviderFailure", () => {
  it("treats a transport failure with no status as transient", () => {
    // The commonest real failure: the gateway is unreachable for a moment.
    expect(isTransientProviderFailure(transportError())).toBe(true);
  });

  it("treats 429 as transient, because a rate limit clears", () => {
    expect(isTransientProviderFailure(statusError(429))).toBe(true);
  });

  it("treats 5xx as transient, because the provider may recover", () => {
    expect(isTransientProviderFailure(statusError(500))).toBe(true);
    expect(isTransientProviderFailure(statusError(503))).toBe(true);
  });

  it("treats 401 and 403 as permanent, because a bad credential never clears", () => {
    expect(isTransientProviderFailure(statusError(401))).toBe(false);
    expect(isTransientProviderFailure(statusError(403))).toBe(false);
  });

  it("treats 400 and 404 as permanent, because the request itself is wrong", () => {
    expect(isTransientProviderFailure(statusError(400))).toBe(false);
    expect(isTransientProviderFailure(statusError(404))).toBe(false);
  });

  it("treats a non-provider error as permanent, because nothing says it will clear", () => {
    // A programming error (a TypeError while parsing a response) would fail
    // identically every time, so retrying it only hides the bug.
    const programmingError = new TypeError("cannot read properties of undefined");
    expect(isTransientProviderFailure(programmingError)).toBe(false);
  });
});

describe("withProviderRetry", () => {
  it("returns the first success and stops", async () => {
    const work = vi.fn().mockResolvedValue("ok");

    await expect(withProviderRetry(work, { sleep: async () => {} })).resolves.toBe("ok");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and returns the eventual success", async () => {
    const work = vi
      .fn()
      .mockRejectedValueOnce(statusError(503))
      .mockResolvedValueOnce("recovered");

    await expect(withProviderRetry(work, { sleep: async () => {} })).resolves.toBe("recovered");
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a permanent failure", async () => {
    const work = vi.fn().mockRejectedValue(statusError(401));

    await expect(withProviderRetry(work, { sleep: async () => {} })).rejects.toThrow(/401/);
    // One call: the answer would be identical the second time.
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("stops after the attempt budget and keeps every failure it saw", async () => {
    const work = vi.fn().mockRejectedValue(statusError(500));

    const error = await withProviderRetry(work, { sleep: async () => {} }).catch(
      (caught: unknown) => caught,
    );

    expect(work).toHaveBeenCalledTimes(TRANSIENT_ATTEMPTS);
    // The error type is what lets a caller tell an outage from a bug.
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    // Every attempt is retained: an operator needs the reasons, not a count.
    expect((error as ProviderUnavailableError).failures).toHaveLength(TRANSIENT_ATTEMPTS);
  });

  it("backs off between attempts, and waits more as the outage persists", async () => {
    // Deterministic jitter so growth is the property under test rather than noise.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { delays, sleep } = recordingSleep();
    const work = vi.fn().mockRejectedValue(statusError(503));

    await withProviderRetry(work, { sleep }).catch(() => undefined);

    // Two waits for three attempts, both positive, strictly growing.
    expect(delays).toHaveLength(TRANSIENT_ATTEMPTS - 1);
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    vi.restoreAllMocks();
  });

  it("keeps the endpoint in the exhausted message, unlike a bare rethrow", async () => {
    // The original LlmError already names it; this pins that the wrapper does
    // not replace a diagnosable message with an anonymous one.
    const work = vi.fn().mockRejectedValue(statusError(503));

    const error = await withProviderRetry(work, { sleep: async () => {} }).catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("gateway.invalid");
  });
});
