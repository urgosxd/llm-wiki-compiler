/**
 * @file test/kg-typecheck-ratchet.test.ts
 * @description The KG package has its own `tsconfig.json`, and neither root
 * `tsc` (which includes only `src/**`) nor `fallow` (which ignores
 * `packages/llmwiki-kg/**`) ever reads it. This ratchet is what makes that
 * configuration's diagnostics visible: the diagnostics it already has are
 * pinned, a new one fails, and a fixed one fails too so an allowance can only
 * shrink and never rot into slack for the next mistake.
 *
 * The comparison is exercised through the script's exported entry point rather
 * than through its stored baseline, so the assertions hold for the same function
 * the gate itself calls.
 */
import { describe, expect, it } from "vitest";
import { compareKgDiagnostics } from "../scripts/kg-typecheck.js";

/** One unused import, the shape every entry in the current baseline has. */
const UNUSED_IMPORT = {
  file: "routes/aks/traverse.ts",
  line: 6,
  code: 6133,
  message: "'sql' is declared but its value is never read.",
};

/** The baseline key the fixture diagnostic is allowed under. */
const ALLOWED = { "routes/aks/traverse.ts TS6133": 1 };

describe("the KG package diagnostic ratchet", () => {
  it("accepts a diagnostic set equal to the baseline", () => {
    expect(compareKgDiagnostics([UNUSED_IMPORT], ALLOWED)).toEqual([]);
  });

  it("rejects a new diagnostic and names its file, line and TypeScript code", () => {
    const newDiagnostic = {
      file: "routes/ingest.ts",
      line: 42,
      code: 2322,
      message: "Type 'string' is not assignable to type 'number'.",
    };
    const errors = compareKgDiagnostics([newDiagnostic], {});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("routes/ingest.ts:42");
    expect(errors[0]).toContain("TS2322");
    expect(errors[0]).toContain("pnpm run typecheck:kg:update");
  });

  it("rejects a diagnostic added on top of a baselined one in the same file", () => {
    const errors = compareKgDiagnostics([UNUSED_IMPORT, { ...UNUSED_IMPORT, line: 7 }], ALLOWED);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("routes/aks/traverse.ts:7");
    expect(errors[0]).toContain("TS6133");
  });

  it("rejects a diagnostic that disappeared, so the baseline cannot rot", () => {
    const errors = compareKgDiagnostics([], ALLOWED);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("routes/aks/traverse.ts TS6133");
    expect(errors[0]).toContain("pnpm run typecheck:kg:update");
  });

  it("tolerates a decrease while updating the baseline, but never an increase", () => {
    expect(compareKgDiagnostics([], ALLOWED, true)).toEqual([]);
    expect(compareKgDiagnostics([UNUSED_IMPORT, { ...UNUSED_IMPORT, line: 7 }], ALLOWED, true))
      .toHaveLength(1);
  });
});
