/**
 * @file src/sources/source-store.ts
 * @description The seam every physical read of raw source bytes goes through.
 *
 * ## Why this file exists before anything moves
 *
 * Raw source bytes live in `sources/` on disk today, and the plan is to move them
 * into Postgres. The measurement that shapes this file: `compile` does NOT read
 * sources through one function. It needs three distinct things — enumerate which
 * sources exist (`scan.ts`), hash one to detect change (`hasher.ts`), and read one
 * body to extract from (`extraction-phase.ts`) — plus a fourth re-hash in
 * `compiler/index.ts`. Swapping the medium in four places at once would be
 * unreviewable and irreversible.
 *
 * So the medium is named first. `SourceStore` is that name: three operations, no
 * transaction control, no stream, no metadata. Everything the product needs to
 * compile a source is here, and nothing the filesystem happens to offer for free.
 *
 * ## The filesystem implementation is the FIRST one, deliberately
 *
 * This module ships with a filesystem-backed implementation that behaves exactly
 * as the code does today. That is what makes the migration reversible: with the
 * seam in place, switching callers to the interface changes no behaviour, and a
 * Postgres implementation can be added and compared against it before any caller
 * depends on the new one.
 *
 * Deleting this filesystem implementation is the LAST step of the migration, for
 * the reason the rollback defect taught: removing the fallback removes the
 * condition every earlier step was assuming.
 *
 * ## Identity, not location
 *
 * A source id is a POSIX path relative to the store root, including the `.md`
 * extension (`"records/note.md"`). It is an identity, not a file path: the
 * Postgres implementation uses the same string as `stack_documents.filename`, so a
 * caller that works against this interface does not learn which medium answered.
 * Nothing in this interface exposes an absolute path, and that is the point —
 * `artifactPath` becoming meaningless is what the migration is about.
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { listSelectedSourceFiles } from "./scan.js";
import { confinedRegularFile, resolveSourcesDir } from "../utils/path-confine.js";

/** A source store that cannot answer for the requested id. */
export class SourceNotFoundError extends Error {
  constructor(readonly sourceId: string) {
    super(`Source not found: ${sourceId}`);
    this.name = "SourceNotFoundError";
  }
}

/**
 * The three operations the product needs to compile a source.
 *
 * Deliberately narrow. A method for "write" is absent because writing is entry
 * point specific (ingest builds a document, the KG registers a row) and giving
 * this interface a write would make two very different lifecycles share one shape
 * for no benefit.
 */
export interface SourceStore {
  /**
   * Every source id the store holds, in a stable order.
   *
   * @returns Source ids (relative POSIX paths including `.md`).
   */
  list(): Promise<string[]>;

  /**
   * Lowercase hex SHA-256 of the source body.
   *
   * The same digest the compiler already records in `WikiState`, so a store that
   * returns a different hash for identical bytes would silently recompile
   * everything. Tests pin that both implementations agree.
   *
   * @param id - Source id.
   * @returns Hex-encoded digest.
   * @throws {SourceNotFoundError} When the id is absent.
   */
  hash(id: string): Promise<string>;

  /**
   * The full source body, frontmatter included.
   *
   * @param id - Source id.
   * @returns The body as UTF-8 text.
   * @throws {SourceNotFoundError} When the id is absent.
   */
  read(id: string): Promise<string>;
}

/** SHA-256 of a body, matching what the compiler stores in `WikiState`. */
function digestOf(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Read a source body from disk, refusing anything that is not a confined regular
 * file.
 *
 * Symlinks are excluded on purpose: `confinedRegularFile` already enforces that
 * for the SDK's readers, and a store that accepted an in-tree alias would let two
 * ids denote one body while the compiler treated them as two sources.
 *
 * @param root - Project root containing `sources/`.
 * @param id - Source id.
 * @returns The body, or `undefined` when the id is absent or not a regular file.
 */
async function readFilesystemSource(root: string, id: string): Promise<string | undefined> {
  const dir = await resolveSourcesDir(root);
  if (dir === null) return undefined;
  const real = await confinedRegularFile(dir, id);
  if (real === null) return undefined;
  try {
    return await readFile(real, "utf-8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The filesystem implementation: `sources/` under a project root.
 *
 * Behaviourally identical to the code it replaces, including the `sources/`
 * absence case — a project with no `sources/` directory lists nothing rather than
 * throwing, because a first compile has no sources yet.
 *
 * @param root - Project root containing `sources/`.
 * @returns A store over that directory.
 */
export function createFilesystemSourceStore(root: string): SourceStore {
  return {
    list: () => listSelectedSourceFiles(root),

    async hash(id: string): Promise<string> {
      const body = await readFilesystemSource(root, id);
      if (body === undefined) throw new SourceNotFoundError(id);
      return digestOf(body);
    },

    async read(id: string): Promise<string> {
      const body = await readFilesystemSource(root, id);
      if (body === undefined) throw new SourceNotFoundError(id);
      return body;
    },
  };
}

/**
 * Normalize a caller-supplied source id to the store's identity form.
 *
 * `IngestResult.filename` and the compiler's `SourceChange.file` are both basename
 * strings today, which is exactly the assumption the migration removes. This
 * helper exists so the mapping lives in one place instead of being re-derived.
 *
 * @param id - A relative POSIX path, with or without a leading `./`.
 * @returns The normalized id.
 */
export function normalizeSourceId(id: string): string {
  return path.posix.normalize(id).replace(/^(\.\/)+/, "");
}
