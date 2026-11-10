/**
 * Tests for durable pending-candidate lifecycle helpers.
 *
 * Pending candidates already on disk remain readable and deletable by slug: the store
 * outlives the writers that produced them. The canonicalisation cases that used to live
 * here went with `writeCandidate`, which was the only caller of that reconciler — nothing
 * writes a candidate record any more, so there is nothing left to canonicalise.
 */

import { describe, it, expect } from "vitest";
import {
  deleteCandidateBySlug,
  listLinkResolvablePendingSlugs,
  readCandidateBySlug,
} from "../packages/wiki/src/compiler/candidates.js";
import { seedPendingCandidate } from "./fixtures/candidate-queue.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

function draft(slug: string, body: string) {
  return {
    title: slug,
    slug,
    summary: `Summary for ${slug}.`,
    sources: ["source.md"],
    body,
  };
}

describe("pending candidate lifecycle", () => {
  it("lists and deletes a planted pending candidate by slug", async () => {
    const id = await seedPendingCandidate(root.dir, draft("topic", "body"));
    expect(await readCandidateBySlug(root.dir, process.env, "topic")).toMatchObject({ id });
    expect(await listLinkResolvablePendingSlugs(root.dir, process.env)).toEqual(new Set(["topic"]));

    expect(await deleteCandidateBySlug(root.dir, process.env, "topic")).toBe(true);
    expect(await readCandidateBySlug(root.dir, process.env, "topic")).toBeNull();
    expect(await deleteCandidateBySlug(root.dir, process.env, "topic")).toBe(false);
  });
});
