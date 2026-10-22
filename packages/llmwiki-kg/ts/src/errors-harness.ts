/**
 * @file packages/llmwiki-kg/ts/src/errors-harness.ts
 * @description Shared fixtures and helpers for the split `errors-*` test files.
 *
 * The original `errors.test.ts` kept its oracle-fixture loading, Zod mapping
 * helper and corpus constants in the same file as ten `describe` blocks. Splitting
 * the blocks by concern requires those helpers to live in one place: this module
 * is that place. It is not a test file, so it is not collected by the runner.
 */
import { readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";

import { expect } from "vitest";
import { z } from "zod";

import { toFastApiValidationError } from "./errors.js";
import type { LocPrefix, PydanticErrorDetail } from "./errors.js";

/** Directory of the oracle fixtures, resolved from this file. */
export const ORACLE_DIR = fileURLToPath(new URL("../oracle/contracts/", import.meta.url));

export interface CorpusCase {
  readonly id: string;
  readonly body: unknown;
}

export interface ExpectedResult {
  readonly id: string;
  readonly status: number;
  readonly response: unknown;
}

export function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, `file://${ORACLE_DIR}`), "utf8")) as T;
}

export const CORPUS = readJson<{ cases: CorpusCase[] }>("validation-422-corpus.json").cases;

export const EXPECTED = readJson<{ results: ExpectedResult[] }>("validation-422-expected.json").results;

/** Looks up the oracle's recorded response for a corpus case. */
export function oracleResult(id: string): ExpectedResult {
  const found = EXPECTED.find((result) => result.id === id);
  if (found === undefined) {
    throw new Error(`oracle fixture is missing a result for case "${id}"`);
  }
  return found;
}

/** Parses `body` with `schema` and maps the failure, or throws if it passes. */
export function mapFailure(schema: z.ZodType, body: unknown, loc: LocPrefix = "body"): PydanticErrorDetail[] {
  const parsed = schema.safeParse(body);
  if (parsed.success) {
    throw new Error("expected the schema to reject the input");
  }
  return [...toFastApiValidationError(parsed.error, loc, body).body.detail];
}

/** Maps a failure and asserts it produced exactly one detail entry. */
export function onlyDetail(schema: z.ZodType, body: unknown, loc: LocPrefix = "body"): PydanticErrorDetail {
  const details = mapFailure(schema, body, loc);
  expect(details).toHaveLength(1);
  const [first] = details;
  if (first === undefined) {
    throw new Error("expected one detail entry");
  }
  return first;
}

/** Narrows away `undefined` in tests that require a failing parse. */
export function assertNever(): never {
  throw new Error("expected the schema to reject the input");
}
