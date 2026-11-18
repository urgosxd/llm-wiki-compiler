import { describe, expect, it } from "vitest";
import { EACCES_REJECTION, ESCAPE_REFUSAL } from "./lock-private-dir-suite.js";

describe("the shared refusal literals", () => {
  it("keep the three facts each and differ, so neither suite can pass on the other's failure", () => {
    expect(EACCES_REJECTION).toEqual({ isError: true, code: "EACCES", confinementViolation: false });
    expect(ESCAPE_REFUSAL).toEqual({ locked: false, saidEacces: false, saidEscape: true });
  });
});
