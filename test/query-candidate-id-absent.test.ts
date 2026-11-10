/**
 * @file test/query-candidate-id-absent.test.ts
 * @description Type-level absence proof for the retired `candidateId` field on
 * the public query result. The field promised a staged review proposal that no
 * surface can produce, so it is removed from the type rather than left on it.
 *
 * The assertion is a `@ts-expect-error` directive, which TypeScript only accepts
 * while it suppresses a real error: it passes for the wrong reason exactly once
 * — before the field is removed it is an unused directive and `typecheck:tests`
 * reports it.
 */

import { describe, it } from "vitest";
import type { QueryResult } from "../packages/wiki/src/utils/types.js";

describe("retired query candidate identity", () => {
  it("no longer declares candidateId on a query result", () => {
    const result = {} as QueryResult;
    // @ts-expect-error candidateId is no longer part of a query result
    void result.candidateId;
  });
});
