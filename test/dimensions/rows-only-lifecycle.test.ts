/**
 * @file test/dimensions/rows-only-lifecycle.test.ts
 * @description A lifecycle transition writes an ENTITY page, which a Stack cannot store.
 *
 * ## Why this refuses instead of storing a row
 *
 * `applyLifecycleLocked` builds `{ kind: "page", target: { entityType, slug } }` and
 * writes it through `applyPageMutationLocked`. An entity target carries a namespace
 * the profile declares (`papers`, `experiments`, …), and
 * `wiki.pages.page_directory` admits only `concepts` and `queries`
 * (`src/dimensions/wiki/schema.sql:73`) — so passing the row sink fails on
 * `pages_page_directory_check`, exactly as `applyTypedCandidate` does.
 *
 * The human decision for this feature is that no entity page belongs to the wiki
 * dimension, and `entity_pages` is the KG's page cache, not wiki storage. With no row
 * to write, the transition must fail closed rather than silently write a file that no
 * Stack reader opens.
 *
 * ## What must NOT change
 *
 * The file-backed project keeps writing `wiki/<entityType>/<slug>.md` — that is a
 * real page there. A test pins it, so the refusal cannot leak onto the file path.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { transitionLifecycle, EntityPageNotRowBackedError } from "../../src/trust/lifecycle-transition.js";
import { buildResearchLiteProject } from "../fixtures/profile-fixtures.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";

/**
 * An `ideas` entity page in its initial state.
 *
 * `ideas` is the type the research-lite fixture gives a lifecycle FSM
 * (`status: proposed → testing → tested → validated|failed`). `papers` is used by
 * the Stack cases only because the refusal fires before any lifecycle lookup; this
 * case has to actually TRANSITION, so it needs a type that declares one.
 */
const IDEA_SLUG = "lifecycle-idea";
const IDEA_BODY = "---\ntitle: Lifecycle Idea\nstatus: proposed\n---\n\n# Idea\n\nBody.\n";

/** A `papers` page: used by the Stack cases, whose refusal precedes any FSM lookup. */
const PAPER_SLUG = "lifecycle-paper";
const PAPER_BODY = "---\ntitle: Lifecycle Paper\nvenue: NeurIPS\n---\n\n# Paper\n\nBody.\n";

/** Roots created by a case, cleaned up afterwards. */
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Provision a profile project with one `papers` page on disk (no lifecycle). */
async function paperProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rows-lifecycle-"));
  roots.push(root);
  await buildResearchLiteProject(root);
  await mkdir(path.join(root, "wiki", "papers"), { recursive: true });
  await writeFile(path.join(root, "wiki", "papers", `${PAPER_SLUG}.md`), PAPER_BODY);
  return root;
}

/** Provision a profile project with one `ideas` page in its initial state. */
async function ideaProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "file-lifecycle-"));
  roots.push(root);
  await buildResearchLiteProject(root);
  await mkdir(path.join(root, "wiki", "ideas"), { recursive: true });
  await writeFile(path.join(root, "wiki", "ideas", `${IDEA_SLUG}.md`), IDEA_BODY);
  return root;
}

describe("a lifecycle transition on a Stack", () => {
  it("refuses, because an entity page has no wiki row", async () => {
    await withStack(async (root) => {
      await expect(transitionLifecycle(root, "papers", PAPER_SLUG, "published"))
        .rejects.toThrow(EntityPageNotRowBackedError);
    });
  });

  it("names the constraint rather than failing with a raw database error", async () => {
    await withStack(async (root) => {
      // `pages_page_directory_check` is the reason; a message that omits it sends the
      // next reader back to rediscover the schema the way this work did.
      await expect(transitionLifecycle(root, "papers", PAPER_SLUG, "published"))
        .rejects.toThrow(/entity-pages-not-row-backed/);
    });
  });
});

/**
 * Provision a Stack, install it, and run `body` against a fresh profile project.
 *
 * Skips silently when no test database is reachable, which is the convention this
 * suite's siblings use; the file-backed case below needs no database and always runs.
 *
 * @param body - Work to run with the Stack bound.
 */
async function withStack(body: (root: string) => Promise<void>): Promise<void> {
  const harness = await createKgPostgresHarness(`life-${randomUUID().slice(0, 8)}`);
  const saved = { ...process.env };
  process.env.AKS_STACK_ID = harness.stackId;
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    if (!harness.reachable) return;
    await body(await paperProject());
  } finally {
    process.env = saved;
    await harness.cleanup();
  }
}

describe("a lifecycle transition with no Stack", () => {
  it("still writes the entity page as a FILE", async () => {
    const saved = process.env.AKS_STACK_ID;
    delete process.env.AKS_STACK_ID;
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const root = await ideaProject();

      await transitionLifecycle(root, "ideas", IDEA_SLUG, "testing");

      const onDisk = await readFile(path.join(root, "wiki", "ideas", `${IDEA_SLUG}.md`), "utf8");
      expect(onDisk).toContain("status: testing");
      expect(existsSync(path.join(root, "wiki", "ideas", `${IDEA_SLUG}.md`))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.AKS_STACK_ID = saved;
    }
  });
});
