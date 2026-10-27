/**
 * @file test/connectors/legacy-capacity-parity.test.ts
 * @description Ordinary connector runs preserve legacy queue/record support,
 * independently of the bounds on newly introduced direct authority interfaces.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConnector } from "../../src/connectors/run.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { plantConnectorCandidate, plantConnectorCandidateBatch } from "./final6-fixtures.js";
import { activateFixtureConnector, countedFixtureFetch } from "./run-test-fixtures.js";

const root = useTempRoot();

/** Retain an oversized legacy predecessor and its exact original bytes. */
async function largePredecessor() {
  await activateFixtureConnector(root.dir);
  await plantConnectorCandidate(root.dir, "large", { rawSuffix: "x".repeat(5 * 1024 * 1024) });
  const pending = path.join(root.dir, ".llmwiki", "candidates", "large.json");
  return { pending, before: await readFile(pending) };
}

describe("public connector legacy capacity", () => {
  afterEach(() => { delete process.env.LLMWIKI_CONNECTORS; });

  it("supersedes a legacy record larger than the bounded custody limit", async () => {
    const { pending, before } = await largePredecessor();
    const result = await runConnector(root.dir, "fixture", { id: "story-1" }, {
      fetcher: countedFixtureFetch({ value: 0 }),
    });
    expect(result).toMatchObject({ kind: "superseded", archivedIds: ["large"] });
    // BYTE equality, asserted with `equals` rather than `toEqual`.
    //
    // The intent was always "the archived bytes are identical to the predecessor".
    // `toEqual` compares two Buffers element by element, and on this 5 MB fixture
    // that measured 42 155 ms against 1 ms for `equals` -- so the 30 s test timeout
    // fired on the comparison itself, not on the connector. `equals` keeps exactly
    // the same claim and fails with a readable message instead of a megabyte diff.
    const archived = await readFile(path.join(path.dirname(pending), "archive", "large.json"));
    expect(archived.equals(before)).toBe(true);
  });

  it("supersedes 201 selected predecessors when that makes room for one replacement", async () => {
    await activateFixtureConnector(root.dir);
    const ids = await plantConnectorCandidateBatch(root.dir, 201);
    const result = await runConnector(root.dir, "fixture", { id: "story-1" }, {
      fetcher: countedFixtureFetch({ value: 0 }),
    });
    expect(result).toMatchObject({ kind: "superseded", archivedIds: ids });
  });

  it("restores exact large predecessor bytes when replacement staging fails", async () => {
    const { pending, before } = await largePredecessor();
    await expect(runConnector(root.dir, "fixture", { id: "story-1" }, {
      fetcher: countedFixtureFetch({ value: 0 }),
      beforeCandidateStageForTest: async () => { throw new Error("injected staging failure"); },
    })).rejects.toThrow("injected staging failure");
    const restored = await readFile(pending);
    expect(restored.equals(before)).toBe(true);
  });
});
