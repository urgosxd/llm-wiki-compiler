/**
 * @file packages/llmwiki-kg/ts/src/errors-corpus.test.ts
 * @description Corpus replay against the recorded oracle 422 responses.
 */

import { describe, expect, it } from "vitest";

import { StackCreate } from "./dto.js";
import { toFastApiValidationError } from "./errors.js";

import { CORPUS, oracleResult } from "./errors-harness.js";

describe("corpus replay against the recorded oracle responses", () => {
  it("has a recorded oracle response for every corpus case", () => {
    expect(CORPUS.length).toBeGreaterThan(0);
    for (const corpusCase of CORPUS) {
      expect(oracleResult(corpusCase.id).id).toBe(corpusCase.id);
    }
  });

  // The two 201 cases exist to prove the corpus itself is honest: they are
  // bodies the oracle accepted, so a mapper that rejected them would be wrong.
  const accepted = CORPUS.filter((corpusCase) => oracleResult(corpusCase.id).status === 201);
  const rejected = CORPUS.filter((corpusCase) => oracleResult(corpusCase.id).status === 422);

  it("covers both accepted and rejected cases", () => {
    expect(accepted.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
  });

  it.each(accepted.map((corpusCase) => [corpusCase.id, corpusCase] as const))(
    "accepts %s, which the oracle answered 201 for",
    (_id, corpusCase) => {
      const parsed = StackCreate.safeParse(corpusCase.body);
      expect(parsed.success, `expected ${corpusCase.id} to parse`).toBe(true);
    },
  );

  it.each(rejected.map((corpusCase) => [corpusCase.id, corpusCase] as const))(
    "reproduces the oracle's 422 body for %s",
    (id, corpusCase) => {
      const expected = oracleResult(id);
      const parsed = StackCreate.safeParse(corpusCase.body);
      expect(parsed.success).toBe(false);
      if (parsed.success) {
        return;
      }

      const mapped = toFastApiValidationError(parsed.error, "body", corpusCase.body);

      // Compared against the fixture, never against a hardcoded string, so this
      // test stays honest if the corpus is ever regenerated.
      expect(mapped.status).toBe(422);
      expect(mapped.body).toEqual(expected.response);
    },
  );
});
