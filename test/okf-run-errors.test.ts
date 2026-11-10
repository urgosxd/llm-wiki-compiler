// test/okf-run-errors.test.ts
import { describe, it, expect } from "vitest";
import { LockUnavailableError } from "../packages/wiki/src/import/run-errors.js";

describe("OKF run errors", () => {
  it("is a distinguishable Error subclass with a message", () => {
    const lock = new LockUnavailableError();
    expect(lock).toBeInstanceOf(Error);
    expect(lock).toBeInstanceOf(LockUnavailableError);
    expect(lock.message).toMatch(/lock/i);
  });
});
