/**
 * @file scripts/ratchet-baseline.ts
 * @description The stored-allowance document both diagnostic ratchets keep, and
 * the validation that decides whether it may be trusted.
 *
 * `scripts/typecheck-tests.ts` pins the test tree's diagnostics and
 * `scripts/kg-typecheck.ts` pins the KG package's. They store the SAME document:
 * a version, the TypeScript version and configuration digest it was taken under,
 * and one positive integer per key (`<file> TS<code>`). They must also refuse the
 * same things — a missing or mismatched version, a non-object `counts`, an entry
 * that is not a positive safe integer — because a value that is not a count is
 * not an allowance, and silently accepting one would either hide a real
 * diagnostic or hold slack the next mistake spends.
 *
 * The shape and the check therefore live here once. The message stays the
 * caller's, because each ratchet names its own baseline file to the reader.
 */

/** One stored allowance set: the document shape every ratchet writes and reads. */
export interface RatchetBaseline {
  version: 1;
  typescript: string;
  configuration: string;
  counts: Record<string, number>;
}

/**
 * Validate a stored baseline before treating any of it as an allowance.
 *
 * @param text - The baseline file's contents.
 * @param invalidMessage - The caller's diagnosis, naming the file it read.
 * @returns The baseline, with `counts` proven to be positive integers.
 * @throws Error carrying `invalidMessage` when the document cannot be trusted.
 */
export function parseRatchetBaseline(text: string, invalidMessage: string): RatchetBaseline {
  const value = JSON.parse(text) as Partial<RatchetBaseline> | null;
  if (
    !value ||
    value.version !== 1 ||
    typeof value.typescript !== "string" ||
    typeof value.configuration !== "string" ||
    !value.counts ||
    typeof value.counts !== "object" ||
    Array.isArray(value.counts) ||
    !Object.values(value.counts).every((count) => Number.isSafeInteger(count) && count > 0)
  ) {
    throw new Error(invalidMessage);
  }
  return value as RatchetBaseline;
}
