/**
 * @file test/fixtures/reader-assertions.ts
 * @description Shared assertions for the `DimensionReader` port.
 *
 * WHY THIS IS SHARED. Both dimension suites must prove the SAME contract
 * behaviour: a named lookup returns the thing, and an unknown name reports a
 * `not_found` CODE rather than throwing. That last part is the whole reason the
 * port returns a `{ ok }` result instead of throwing, so it needs to be asserted
 * identically on both sides — if each suite phrased it differently, one could keep
 * passing after the port's failure semantics changed.
 *
 * Sharing it also keeps the two suites from drifting on HOW a coded failure is
 * inspected, which is easy to get subtly wrong (`error.code` read on an `ok: true`
 * result narrows to `undefined` and silently asserts nothing).
 */

import { expect } from "vitest";
import type { DimensionReader } from "../../src/dimensions/read-types.js";

/**
 * Assert that a reader finds a known name AND reports `not_found` for an unknown
 * one, as a code rather than a throw.
 *
 * @param reader - Reader under test.
 * @param knownName - A name the reader is expected to resolve.
 * @param expectedTitle - The entity name the lookup should return.
 * @param unknownName - A name the reader is expected NOT to resolve.
 */
export async function expectNamedLookupContract(
  reader: DimensionReader,
  knownName: string,
  expectedTitle: string,
  unknownName = "Nonexistent",
): Promise<void> {
  const found = await reader.read({ name: knownName });
  expect(found.ok).toBe(true);
  if (found.ok) expect(found.value.entities[0]?.name).toBe(expectedTitle);

  const missing = await reader.read({ name: unknownName });
  // A miss is an EXPECTED answer carrying a code, not a thrown error: each
  // transport renders it differently (HTTP 404, MCP tool error, CLI message).
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.code).toBe("not_found");
}
