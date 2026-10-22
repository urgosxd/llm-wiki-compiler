/**
 * @file packages/llmwiki-kg/ts/src/dto-harness.ts
 * @description Shared helpers for the split `dto-*` test files.
 */
import { expect } from "vitest";
import type { z } from "zod";

export const TS = "2026-10-21T04:01:46.454886Z";
export const UUID_A = "36617342-3b68-4ea7-81b9-5bc562bb81d3";
export const UUID_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

export function parseOk<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`expected a successful parse: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}

export function expectRejected(schema: z.ZodType, value: unknown, label: string): void {
  expect(schema.safeParse(value).success, `expected ${label} to be rejected`).toBe(false);
}
