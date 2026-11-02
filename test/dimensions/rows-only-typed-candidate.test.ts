/**
 * @file test/dimensions/rows-only-typed-candidate.test.ts
 * @description An entity page has NO storage on a Stack, and must say so.
 *
 * ## What was measured
 *
 * `applyTypedCandidate` planned and applied with no `ApplyOptions`, so the executor
 * took its file branch and wrote `wiki/<entityType>/<slug>.md` — a file nothing on a
 * Stack reads, because the corpus is `wiki.pages`.
 *
 * The obvious fix — pass the row sink — does not work, and the database says why:
 *
 *     PostgresError: new row for relation "pages" violates check constraint
 *     "pages_page_directory_check"
 *     detail: Failing row contains (..., papers, row-only-paper, ...)
 *
 * `wiki.pages.page_directory` admits only `concepts` and `queries`
 * (`src/dimensions/wiki/schema.sql:73`), and that closed set is deliberate: an
 * entity page does not belong to the wiki dimension. `entity_pages` is not the
 * answer either — it is the KG's on-demand page cache keyed by `ontology_entities`,
 * in the `public` schema, generated from the graph.
 *
 * ## So the contract is refusal, not storage
 *
 * There is nowhere to put the page, and the honest response is a typed error rather
 * than a file that silently diverges from the corpus. The FILE-backed project is
 * untouched: it still lands `wiki/<entityType>/<slug>.md`, which is a real page
 * there.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { applyTypedCandidate, TypedPageNotRowBackedError } from "../../src/trust/promote.js";
import { buildResearchLiteProject } from "../fixtures/profile-fixtures.js";
import type { ReviewCandidate } from "../../src/utils/types.js";

const ENTITY_TYPE = "papers";
const SLUG = "row-only-paper";
const BODY = "---\ntitle: Row Only Paper\nvenue: NeurIPS\n---\n\n# Row Only Paper\n\nBody.\n";

/** One typed candidate, as review staging would produce it. */
function typedCandidate(): ReviewCandidate {
  return {
    id: `row-only-${SLUG}`,
    title: SLUG,
    slug: SLUG,
    summary: "",
    sources: [],
    body: BODY,
    createdAt: new Date().toISOString(),
    targetEntityType: ENTITY_TYPE,
  } as ReviewCandidate;
}

describe("applying a typed candidate on a Stack", () => {
  let root: string;
  let harness: KgPostgresHarness;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "rows-typed-"));
    await mkdir(path.join(root, "wiki"), { recursive: true });
    harness = await createKgPostgresHarness(`typed-${randomUUID().slice(0, 8)}`);
    savedEnv = { ...process.env };
    process.env.AKS_STACK_ID = harness.stackId;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.env = savedEnv;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    await harness.cleanup();
  });

  it("refuses the write instead of silently creating a file", async () => {
    await buildResearchLiteProject(root);

    await expect(applyTypedCandidate(root, typedCandidate())).rejects.toThrow(
      TypedPageNotRowBackedError,
    );
  });

  it("names the constraint that makes storage impossible", async () => {
    await buildResearchLiteProject(root);

    // The message has to say WHY, or the next reader re-discovers the CHECK the
    // same way this work did.
    await expect(applyTypedCandidate(root, typedCandidate())).rejects.toThrow(
      /entity-pages-not-row-backed: papers\/row-only-paper/,
    );
  });

  it("leaves no page file behind when it refuses", async () => {
    await buildResearchLiteProject(root);

    await applyTypedCandidate(root, typedCandidate()).catch(() => undefined);

    // The defect being replaced: it used to write this file and report success.
    expect(existsSync(path.join(root, "wiki", ENTITY_TYPE, `${SLUG}.md`))).toBe(false);
  });
});

describe("applying a typed candidate with no Stack", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "file-typed-"));
    await mkdir(path.join(root, "wiki"), { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("still writes the entity page as a FILE", async () => {
    // The file backend is unchanged: that path is real there, and freezing it is
    // part of the contract.
    const saved = process.env.AKS_STACK_ID;
    delete process.env.AKS_STACK_ID;
    try {
      await buildResearchLiteProject(root);
      await applyTypedCandidate(root, typedCandidate());
      expect(existsSync(path.join(root, "wiki", ENTITY_TYPE, `${SLUG}.md`))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.AKS_STACK_ID = saved;
    }
  });
});
