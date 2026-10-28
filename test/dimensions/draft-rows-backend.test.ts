/**
 * @file test/dimensions/draft-rows-backend.test.ts
 * @description The compile draft loads and persists through rows, touching no file.
 *
 * This is the property that makes `state.json` removable: the draft is the ONLY
 * write chokepoint for compile state (`flush`), and the only read one (`load`).
 * Everything else in the compiler reads the in-memory `WikiState`, so if these two
 * go to rows, no other module needs to change.
 *
 * The root here is a bare temp directory with NO `.llmwiki/`. A file-backed draft
 * would create one; the assertion that the directory stays absent is what proves the
 * row backend was actually used rather than silently falling back.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompileStateDraft } from "../../src/compiler/compile-state-draft.js";
import { createWikiStateRowsBackend } from "../../src/dimensions/wiki/wiki-state-source.js";
import { saveSourceDocument } from "../../src/dimensions/wiki/source-documents-store.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

const IDENTITY = "src://draft";
const COMPILED_AT = "2026-02-01T10:00:00.000Z";

let harness: KgPostgresHarness;
let root: string;

beforeEach(async () => {
  harness = await createKgPostgresHarness(`draft-${randomUUID().slice(0, 8)}`);
  root = await mkdtemp(path.join(os.tmpdir(), "draft-rows-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await harness.cleanup();
});

/** True when the project has a `.llmwiki/` directory. */
async function hasPrivateDir(): Promise<boolean> {
  const entries = await readdir(root).catch(() => [] as string[]);
  return entries.includes(".llmwiki");
}

describe("the compile draft over rows", () => {
  it("loads empty and persists without creating .llmwiki/", async () => {
    const rows = createWikiStateRowsBackend(harness.db, harness.stackId);
    const draft = await CompileStateDraft.load(root, rows);

    expect(draft.read().sources).toEqual({});
    expect(await hasPrivateDir()).toBe(false);

    draft.setFrozen(new Set(["frozen-a"]));
    await draft.flush(root, rows);

    // The assertion that matters: no private dir appeared.
    expect(await hasPrivateDir()).toBe(false);
  });

  it("round-trips a source through load → mutate → flush → load", async () => {
    await saveSourceDocument(harness.db, harness.stackId, {
      title: "Draft", document: `---\ntitle: Draft\n---\n${IDENTITY}`, source: IDENTITY,
    });
    const rows = createWikiStateRowsBackend(harness.db, harness.stackId);

    const first = await CompileStateDraft.load(root, rows);
    first.setSource(IDENTITY, {
      hash: "h-1", concepts: ["c-1"], compiledAt: COMPILED_AT, version: 2,
    } as never);
    await first.flush(root, rows);

    const second = await CompileStateDraft.load(root, rows);
    expect(second.read().sources[IDENTITY]?.concepts).toEqual(["c-1"]);
    // An EMPTY frozen set is omitted rather than stored as `[]`, matching the file
    // format: `state.json` only carries the key once something is frozen.
    expect(second.read().frozenSlugs).toBeUndefined();
  });
});
