/**
 * @file test/sources/source-store.test.ts
 * @description The `SourceStore` seam: list, hash, and read must agree with the
 * behaviour the filesystem code had before the seam existed.
 *
 * WHY THESE ASSERTIONS. The seam exists so raw bytes can move from `sources/` to
 * Postgres without changing what `compile` observes. That is only true if the
 * filesystem implementation is byte-for-byte faithful to today's behaviour, so
 * these cases pin the three properties a future implementation must also satisfy:
 *
 *   - a project with no `sources/` LISTS NOTHING rather than throwing, because a
 *     first compile legitimately has no sources;
 *   - `hash` is the SHA-256 the compiler already stores in `WikiState`, so an
 *     implementation returning a different digest would recompile everything;
 *   - a missing id THROWS instead of returning an empty body, so a caller cannot
 *     silently compile nothing.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  createFilesystemSourceStore,
  normalizeSourceId,
  SourceNotFoundError,
} from "../../src/sources/source-store.js";

/** A project root with the given files written under `sources/`. */
async function projectWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "source-store-"));
  await mkdir(path.join(root, "sources"), { recursive: true });
  for (const [id, body] of Object.entries(files)) {
    const target = path.join(root, "sources", id);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, "utf-8");
  }
  return root;
}

describe("the filesystem source store", () => {
  /* Top level only, and markdown only. `loadSourceSelection` defaults
   * `recursive` to false, so a nested source is invisible without project
   * config — existing behaviour this store must not silently change, because a
   * Postgres implementation that listed nested rows would compile sources the
   * filesystem one never did. */
  it("lists top-level markdown sources, and nothing else", async () => {
    const root = await projectWith({ "a.md": "A", "records/b.md": "B", "notes.txt": "no" });
    const store = createFilesystemSourceStore(root);

    expect(await store.list()).toEqual(["a.md"]);
  });

  /* A nested source is still READABLE by id even though `list` omits it, which is
   * what lets the compiler resolve a change it was told about.
   */
  it("reads a nested source by id even when list omits it", async () => {
    const root = await projectWith({ "records/b.md": "B" });
    const store = createFilesystemSourceStore(root);

    expect(await store.read("records/b.md")).toBe("B");
  });

  /* A first compile has no sources yet. Throwing here would make an empty project
   * fail instead of compiling nothing, which is the behaviour callers depend on. */
  it("lists nothing when sources/ does not exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "source-store-empty-"));
    const store = createFilesystemSourceStore(root);

    expect(await store.list()).toEqual([]);
  });

  /* The digest must match what the compiler records, or every source would look
   * changed on every run. */
  it("hashes the body the same way the compiler does", async () => {
    const body = "---\ntitle: A\n---\n\nprose";
    const root = await projectWith({ "a.md": body });
    const store = createFilesystemSourceStore(root);

    expect(await store.hash("a.md")).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("reads the full body, frontmatter included", async () => {
    const body = "---\ntitle: A\n---\n\nprose";
    const root = await projectWith({ "a.md": body });
    const store = createFilesystemSourceStore(root);

    expect(await store.read("a.md")).toBe(body);
  });

  /* Returning an empty body for a missing id would let a caller compile nothing
   * and call it success. */
  it("throws SourceNotFoundError for an id that is absent", async () => {
    const root = await projectWith({ "a.md": "A" });
    const store = createFilesystemSourceStore(root);

    await expect(store.read("missing.md")).rejects.toBeInstanceOf(SourceNotFoundError);
    await expect(store.hash("missing.md")).rejects.toBeInstanceOf(SourceNotFoundError);
  });

  /* A symlink would let two ids denote one body while the compiler counted them
   * as two sources. The SDK's readers already refuse symlinks; the store must not
   * quietly accept what they reject. */
  it("refuses a symlinked source", async () => {
    const root = await projectWith({ "a.md": "A" });
    await symlink(path.join(root, "sources", "a.md"), path.join(root, "sources", "link.md"));
    const store = createFilesystemSourceStore(root);

    await expect(store.read("link.md")).rejects.toBeInstanceOf(SourceNotFoundError);
  });
});

describe("normalizeSourceId", () => {
  it("drops a leading ./ and collapses a redundant separator", () => {
    expect(normalizeSourceId("./records//note.md")).toBe("records/note.md");
  });

  it("keeps a bare filename unchanged", () => {
    expect(normalizeSourceId("note.md")).toBe("note.md");
  });
});
