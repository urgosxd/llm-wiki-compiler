/**
 * @file test/dimensions/candidate-slug-safety-rows.test.ts
 * @description Slug hardening survives the move to rows.
 *
 * ## What is still worth testing, and what is not
 *
 * `candidate-id-safety.test.ts` covers two different things under one name. Ten of
 * its cases are about FILE NAMES: reserved stems, ASCII-case aliases, a filename that
 * disagrees with its embedded id, legacy collisions. A row has no filename, so the
 * primary key makes every one of those states unrepresentable — those cases have no
 * analogue and stay with the file backend.
 *
 * The other cases are about the SLUG, which still reaches the id both backends store:
 * a traversal slug must be refused before anything is persisted. That property is not
 * a filesystem artifact and would be a real hole if the row path skipped it, so it is
 * pinned here.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listCandidates, writeCandidate } from "../../src/compiler/candidates.js";
import { UnsafeCandidateIdError } from "../../src/compiler/candidate-paths.js";
import { withProjectRoot, withStackEnv } from "../fixtures/stack-env.js";

/** A draft for `slug`, with the minimum the writer needs. */
function draftFor(slug: string) {
  return { title: slug, slug, summary: "", sources: [], body: "# Body\n" };
}

describe("candidate slug hardening on rows", () => {
  it("refuses a traversal slug and persists nothing", () =>
    withProjectRoot("slug-traversal", async (dir) => {
      await expect(writeCandidate(dir, draftFor("../evil"))).rejects.toBeInstanceOf(
        UnsafeCandidateIdError,
      );
      expect(await listCandidates(dir)).toHaveLength(0);
    }));

  it("refuses a slug containing a path separator", () =>
    withProjectRoot("slug-sep", async (dir) => {
      await expect(writeCandidate(dir, draftFor("a/b"))).rejects.toBeInstanceOf(
        UnsafeCandidateIdError,
      );
      expect(await listCandidates(dir)).toHaveLength(0);
    }));

  it("refuses a deep traversal slug rather than resolving it", () =>
    withProjectRoot("slug-deep", async (dir) => {
      await expect(writeCandidate(dir, draftFor("../../../../etc/passwd"))).rejects.toBeInstanceOf(
        UnsafeCandidateIdError,
      );
      expect(await listCandidates(dir)).toHaveLength(0);
    }));

  it("round-trips a normal safe slug unchanged", () =>
    withProjectRoot("slug-safe", async (dir) => {
      const written = await writeCandidate(dir, draftFor("normal-slug"));

      expect(written.slug).toBe("normal-slug");
      expect((await listCandidates(dir)).map((c) => c.id)).toEqual([written.id]);
    }));

  it("does not reflect an oversized hostile slug", () =>
    withProjectRoot("slug-oversize", async (dir) => {
      // A slug past the writable cap must be refused, not echoed into an id.
      await expect(writeCandidate(dir, draftFor("x".repeat(4096)))).rejects.toThrow();
      expect(await listCandidates(dir)).toHaveLength(0);
    }));
});
