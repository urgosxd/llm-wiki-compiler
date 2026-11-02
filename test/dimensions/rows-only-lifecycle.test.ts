/**
 * @file test/dimensions/rows-only-lifecycle.test.ts
 * @description A lifecycle transition writes an ENTITY page, which a Stack cannot store.
 *
 * ## Why this refuses instead of storing a row
 *
 * `applyLifecycleLocked` builds `{ kind: "page", target: { entityType, slug } }` and
 * writes it through `applyPageMutationLocked`. An entity target carries a namespace
 * the profile declares (`papers`, `ideas`, …), and `wiki.pages.page_directory`
 * admits only `concepts` and `queries` (`src/dimensions/wiki/schema.sql:73`) — so
 * passing the row sink fails on `pages_page_directory_check`, exactly as
 * `applyTypedCandidate` does.
 *
 * The human decision for this feature is that no entity page belongs to the wiki
 * dimension, and `entity_pages` is the KG's page cache, not wiki storage. With no
 * row to write, the transition must fail closed rather than silently write a file
 * that no Stack reader opens.
 *
 * ## What must NOT change
 *
 * The file-backed project keeps writing `wiki/<entityType>/<slug>.md` — that is a
 * real page there. A test pins it, so the refusal cannot leak onto the file path.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  transitionLifecycle,
  EntityPageNotRowBackedError,
} from "../../src/trust/lifecycle-transition.js";
import { buildResearchLiteProject } from "../fixtures/profile-fixtures.js";
import { withRowsStack } from "../fixtures/rows-only-stack.js";

/**
 * A `papers` page, used by the Stack cases.
 *
 * `papers` has no lifecycle FSM in the fixture, which is fine here: the refusal is
 * a Stack check that runs BEFORE any transition is looked up, so the page never
 * needs to be transitionable. The file case below needs a real FSM and uses `ideas`.
 */
const PAPER_SLUG = "lifecycle-paper";
const PAPER_BODY = "---\ntitle: Lifecycle Paper\nvenue: NeurIPS\n---\n\n# Paper\n\nBody.\n";

/** An `ideas` page in its initial state; `ideas` declares the fixture's FSM. */
const IDEA_SLUG = "lifecycle-idea";
const IDEA_BODY = "---\ntitle: Lifecycle Idea\nstatus: proposed\n---\n\n# Idea\n\nBody.\n";

/** Roots created by the file case, cleaned up afterwards. */
const fileRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of fileRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * Provision a profile project with one page on disk.
 *
 * @param namespace - Entity namespace, e.g. `papers`.
 * @param slug - Page slug.
 * @param body - Page markdown.
 * @returns The project root.
 */
async function pageProject(namespace: string, slug: string, body: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `lifecycle-${namespace}-`));
  fileRoots.push(root);
  await buildResearchLiteProject(root);
  await mkdir(path.join(root, "wiki", namespace), { recursive: true });
  await writeFile(path.join(root, "wiki", namespace, `${slug}.md`), body);
  return root;
}

describe("a lifecycle transition on a Stack", () => {
  it("refuses, because an entity page has no wiki row", async () => {
    await withRowsStack("life", async () => {
      const project = await pageProject("papers", PAPER_SLUG, PAPER_BODY);

      await expect(transitionLifecycle(project, "papers", PAPER_SLUG, "published"))
        .rejects.toThrow(EntityPageNotRowBackedError);
    });
  });

  it("names the constraint rather than failing with a raw database error", async () => {
    await withRowsStack("life-name", async () => {
      const project = await pageProject("papers", PAPER_SLUG, PAPER_BODY);

      // `pages_page_directory_check` is the reason; a message that omits it sends the
      // next reader back to rediscover the schema the way this work did.
      await expect(transitionLifecycle(project, "papers", PAPER_SLUG, "published"))
        .rejects.toThrow(/entity-pages-not-row-backed/);
    });
  });
});

describe("a lifecycle transition with no Stack", () => {
  it("still writes the entity page as a FILE", async () => {
    const saved = process.env.AKS_STACK_ID;
    delete process.env.AKS_STACK_ID;
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const project = await pageProject("ideas", IDEA_SLUG, IDEA_BODY);

      await transitionLifecycle(project, "ideas", IDEA_SLUG, "testing");

      const onDisk = await readFile(path.join(project, "wiki", "ideas", `${IDEA_SLUG}.md`), "utf8");
      expect(onDisk).toContain("status: testing");
      expect(existsSync(path.join(project, "wiki", "ideas", `${IDEA_SLUG}.md`))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.AKS_STACK_ID = saved;
    }
  });
});
