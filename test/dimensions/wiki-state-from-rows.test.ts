/**
 * @file test/dimensions/wiki-state-from-rows.test.ts
 * @description `state.json` reassembled from two tables, and split back on write.
 *
 * The property that matters is PARITY with the file format: a state written to rows
 * and read back must equal the one written to `state.json` and read back, because
 * ~20 modules read that shape and none of them knows which backend produced it.
 *
 * The extraction cache is the field most likely to be lost silently — it is a cache,
 * so dropping it costs LLM calls and nothing fails. It is asserted explicitly.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readWikiStateFromRows,
  writeWikiStateToRows,
} from "../../src/dimensions/wiki/wiki-state-source.js";
import type { WikiState } from "../../src/utils/types.js";
import { saveSourceDocument } from "../../src/dimensions/wiki/source-documents-store.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

const COMPILED_AT = "2026-02-01T10:00:00.000Z";

/** A state with every field the file format can carry, so nothing is silently lost. */
function fullState(): WikiState {
  return {
    version: 2,
    indexHash: "",
    sources: {
      "src://alpha": {
        hash: "hash-alpha",
        concepts: ["alpha", "alpha-two"],
        compiledAt: COMPILED_AT,
        source: "src://alpha",
        entities: ["concepts/alpha"] as never,
        extraction: {
          fingerprint: "fp-1",
          sourceHash: "hash-alpha",
          concepts: [{ concept: "Alpha", summary: "s", is_new: true }],
        },
      },
    },
    frozenSlugs: ["frozen-one"],
    frozenEntities: ["concepts/frozen-one"] as never,
    promptModifiers: "digest-xyz",
  };
}

let harness: KgPostgresHarness;

/**
 * Seed the DOCUMENT a compile record refers to.
 *
 * `source_compile_state` has a foreign key to `source_documents`, and correctly so:
 * a compile record for a document that does not exist is not a fact worth storing.
 * Writing state therefore requires the corpus row to exist first — which is the real
 * ordering in the product, where ingest runs before compile.
 */
async function seedDocument(identity: string): Promise<void> {
  await saveSourceDocument(harness.db, harness.stackId, {
    title: "Alpha", document: `---\ntitle: Alpha\n---\n${identity}`, source: identity,
  });
}

beforeEach(async () => {
  harness = await createKgPostgresHarness(`state-${randomUUID().slice(0, 8)}`);
});

afterEach(async () => {
  await harness.cleanup();
});

describe("wiki state stored as rows", () => {
  it("reads as a valid empty state on a Stack that never compiled", async () => {
    // Same answer `readState` gave for a missing state.json, so no caller needs a
    // new branch for a fresh Stack.
    const state = await readWikiStateFromRows(harness.db, harness.stackId);
    expect(state.sources).toEqual({});
    expect(state.version).toBe(2);
  });

  it("round-trips a full state without losing a field", async () => {
    await seedDocument("src://alpha");
    await writeWikiStateToRows(harness.db, harness.stackId, fullState());

    expect(await readWikiStateFromRows(harness.db, harness.stackId)).toEqual(fullState());
  });

  it("keeps the reusable extraction cache", async () => {
    await seedDocument("src://alpha");
    await writeWikiStateToRows(harness.db, harness.stackId, fullState());

    const stored = await readWikiStateFromRows(harness.db, harness.stackId);
    expect(stored.sources["src://alpha"]?.extraction?.fingerprint).toBe("fp-1");
  });

  it("deletes the row of a source that is no longer in the state", async () => {
    // A removed source must not leave a compile record behind, or the next run
    // treats a document that no longer exists as already compiled.
    await seedDocument("src://alpha");
    await writeWikiStateToRows(harness.db, harness.stackId, fullState());
    const trimmed = fullState();
    delete trimmed.sources["src://alpha"];
    await writeWikiStateToRows(harness.db, harness.stackId, trimmed);

    expect((await readWikiStateFromRows(harness.db, harness.stackId)).sources).toEqual({});
  });
});
