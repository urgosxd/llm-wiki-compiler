/**
 * @file test/dimensions/compile-config-store.test.ts
 * @description The Stack-scoped half of state.json, stored as a row.
 *
 * The property that matters is not "a row round-trips". It is that a Stack which
 * has NEVER compiled reads as empty rather than throwing, `""` and NULL stay
 * distinct, and one Stack's frozen set is invisible to another — the last one
 * proven by a RAW query with no stack predicate, because the dimension's own reads
 * would pass whether or not RLS works.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_COMPILE_CONFIG,
  readCompileConfig,
  writeCompileConfig,
} from "../../src/dimensions/wiki/compile-config-store.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

let harness: KgPostgresHarness;

beforeEach(async () => {
  harness = await createKgPostgresHarness(`cfg-${randomUUID().slice(0, 8)}`);
});

afterEach(async () => {
  await harness.cleanup();
});

describe("compile config as a row", () => {
  it("reads as empty on a Stack that never compiled", async () => {
    // A fresh Stack has no row. That is the normal state, not a fault, and a caller
    // forced to handle `undefined` would invent its own empty value per site.
    expect(await readCompileConfig(harness.db, harness.stackId)).toEqual(EMPTY_COMPILE_CONFIG);
  });

  it("round-trips frozen sets and the modifier digest", async () => {
    await writeCompileConfig(harness.db, harness.stackId, {
      frozenSlugs: ["alpha", "beta"],
      frozenEntities: ["concepts/alpha"],
      promptModifiers: "abc123",
    });

    expect(await readCompileConfig(harness.db, harness.stackId)).toEqual({
      frozenSlugs: ["alpha", "beta"],
      frozenEntities: ["concepts/alpha"],
      promptModifiers: "abc123",
    });
  });

  it("keeps an empty digest distinct from never having compiled", async () => {
    // "" means "a compile ran and selected none"; NULL means "none has run". The
    // compiler treats them the same TODAY, but collapsing them here would erase the
    // only evidence that a compile happened.
    await writeCompileConfig(harness.db, harness.stackId, {
      frozenSlugs: [], frozenEntities: [], promptModifiers: "",
    });

    const stored = await readCompileConfig(harness.db, harness.stackId);
    expect(stored.promptModifiers).toBe("");
    expect(stored.promptModifiers).not.toBeNull();
  });

  it("overwrites rather than duplicating on a second write", async () => {
    await writeCompileConfig(harness.db, harness.stackId, {
      frozenSlugs: ["first"], frozenEntities: [], promptModifiers: "one",
    });
    await writeCompileConfig(harness.db, harness.stackId, {
      frozenSlugs: ["second"], frozenEntities: [], promptModifiers: "two",
    });

    expect((await readCompileConfig(harness.db, harness.stackId)).frozenSlugs).toEqual(["second"]);
  });
});
