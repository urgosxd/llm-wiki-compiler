/**
 * @file test/dimensions/rm-rows-e2e.test.ts
 * @description `llmwiki rm` deletes ROWS, end to end, on a Stack-backed project.
 *
 * The unit test next door (`page-delete-seam.test.ts`) proves the seam works when a
 * remover is HANDED to `deleteWikiPagesLocked`. That is not the bug that shipped:
 * nothing handed one over. `applyRemovalLocked` called `deleteWikiPagesLocked` with
 * no options, so on a Stack it unlinked `wiki/concepts/<slug>.md` — a file that does
 * not exist — and `assertUnlinked` read ENOENT as success. `rm` reported the page
 * deleted while the row survived.
 *
 * Dropping the `withPageRemover` wiring from `removal.ts` leaves every existing rm
 * test green, because none of them runs with a Stack. This suite is the one that
 * fails when the wiring is removed, so it is what actually pins the fix.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { planRemoval, applyRemovalLocked } from "../../src/sources/removal.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import { createDimensionsDatabase } from "../../src/dimensions/activation.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { getStoredPage } from "../../src/dimensions/wiki/page-store.js";
import { writeStateFor } from "../../src/dimensions/wiki/page-source-seam.js";
import { saveSourceDocument } from "../../src/dimensions/wiki/source-documents-store.js";
import type { WikiState } from "../../src/utils/types.js";

/** The row-store directory value, which is NOT the `wiki/concepts` path. */
const CONCEPT_DIRECTORY = "concepts";

/**
 * A two-source project whose pages live as ROWS.
 *
 * `bad.md` owns `junk` alone and co-owns `shared` with the still-live `good.md`, so
 * the removal must delete one row and keep the other — the same distinction the file
 * suite makes, but with nothing on disk to delete.
 *
 * @returns The project root; the caller owns cleanup.
 */
async function rowsProject(stackId: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rm-rows-"));
  await mkdir(path.join(root, "sources"), { recursive: true });
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  for (const name of ["bad", "good"]) {
    await writeFile(path.join(root, `sources/${name}.md`), `---\ntitle: ${name}\n---\nbody`, "utf-8");
  }
  const state: WikiState = {
    version: 1,
    indexHash: "h",
    sources: {
      "bad.md": { hash: "a", concepts: ["junk", "shared"], compiledAt: "2026-01-01T00:00:00Z" },
      "good.md": { hash: "b", concepts: ["shared"], compiledAt: "2026-01-01T00:00:00Z" },
    },
  };
  // The seed must go to the ACTIVE backend. `applyRemovalLocked` reads state through
  // `readStateClassifiedFor`, which reads ROWS on a Stack -- writing `state.json`
  // here would leave the row state empty, the plan with nothing to delete, and the
  // test passing for the wrong reason.
  // `source_compile_state` has a FOREIGN KEY onto `source_documents`, so the source
  // rows must exist before the state that references them.
  const db = createDimensionsDatabase(process.env);
  try {
    for (const name of ["bad", "good"]) {
      await saveSourceDocument(db.db, stackId, { title: name, document: `body ${name}`, source: `${name}.md` });
    }
  } finally {
    await db.close();
  }
  await writeStateFor(root, state);
  return root;
}

describe("llmwiki rm on a Stack-backed project", () => {
  it("deletes the row of a page the source owned alone", async () => {
    const probe = await createProbeStack(`rm-${randomUUID().slice(0, 8)}`);
    const saved = { ...process.env };
    let root = "";
    try {
      // The env must be set BEFORE the project is built: the seed goes to whichever
      // backend is active, and building first would seed the file backend while the
      // removal reads rows.
      Object.assign(process.env, probe.env());
      root = await rowsProject(probe.harness.stackId);
      const sink = createPageWriteSink(probe.harness.db, probe.harness.stackId);
      for (const slug of ["junk", "shared"]) {
        await sink({ directory: CONCEPT_DIRECTORY, slug, body: `---\ntitle: ${slug}\n---\nbody\n` });
      }

      const plan = await planRemoval(root, "bad");
      expect(plan).not.toBeNull();
      const applied = await applyRemovalLocked(root, plan!);

      expect(applied.deleted).toEqual(["junk"]);
      // The deleted page's row is gone...
      expect(await getStoredPage(probe.harness.db, probe.harness.stackId, "concepts", "junk"))
        .toBeUndefined();
      // ...and the co-owned page's row SURVIVES, which is the maintainer's primary
      // concern: removing one source must never take a shared concept with it.
      expect(await getStoredPage(probe.harness.db, probe.harness.stackId, "concepts", "shared"))
        .toBeDefined();
    } finally {
      process.env = saved;
      if (root !== "") await rm(root, { recursive: true, force: true });
      await probe.harness.cleanup();
    }
  });
});
