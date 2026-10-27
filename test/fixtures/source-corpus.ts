/**
 * @file test/fixtures/source-corpus.ts
 * @description Read a project's source corpus through whichever backend is active.
 *
 * The source-identity suites (unicode slugs, basename collisions, idempotent
 * re-ingest) assert the FILENAME the ingest assigns, because that filename is the
 * contract: `notes.md` plus one `notes-<8 hex>.md` sibling is how a collision is
 * disambiguated, and it must survive a re-ingest unchanged.
 *
 * Those assertions hold on both backends, but the way to READ them does not. On
 * files they are directory entries; on a Stack they are rows. Asking the active
 * backend keeps the contract under test and stops the suite from asserting
 * storage by accident -- a `readdir` on a Stack-backed project throws ENOENT for
 * the right reason and proves nothing at all.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createDimensionsDatabase } from "../../src/dimensions/activation.js";
import { listSourceDocuments } from "../../src/dimensions/wiki/source-documents-store.js";
import { listStoredPagesUnfiltered } from "../../src/dimensions/wiki/page-store.js";

/** The Stack this process is bound to, or undefined on a filesystem project. */
function activeStackId(env: NodeJS.ProcessEnv): string | undefined {
  return env.AKS_STACK_ID;
}

/**
 * Every source filename in the project, sorted.
 *
 * @param cwd - The project root the ingest wrote into.
 * @returns The source filenames, in ascending order.
 */
export async function listSourceFilenames(cwd: string): Promise<string[]> {
  const stackId = activeStackId(process.env);
  if (stackId === undefined) {
    return (await readdir(path.join(cwd, "sources"))).sort();
  }
  const handle = createDimensionsDatabase(process.env);
  try {
    const docs = await listSourceDocuments(handle.db, stackId);
    return docs.map((doc) => doc.filename).sort();
  } finally {
    await handle.close();
  }
}

/**
 * Every source body in the project, keyed by filename.
 *
 * @param cwd - The project root the ingest wrote into.
 * @returns A map from source filename to its stored text.
 */
export async function readSourceBodies(cwd: string): Promise<Map<string, string>> {
  const stackId = activeStackId(process.env);
  const bodies = new Map<string, string>();
  if (stackId === undefined) {
    for (const name of await listSourceFilenames(cwd)) {
      bodies.set(name, await readFile(path.join(cwd, "sources", name), "utf-8"));
    }
    return bodies;
  }
  const handle = createDimensionsDatabase(process.env);
  try {
    const docs = await listSourceDocuments(handle.db, stackId);
    for (const doc of docs) bodies.set(doc.filename, doc.content);
    return bodies;
  } finally {
    await handle.close();
  }
}

/**
 * How many compiled concept pages the project holds, from the active backend.
 *
 * @param cwd - The project root the compile wrote into.
 * @returns The number of concept pages stored.
 */
export async function countConceptPages(cwd: string): Promise<number> {
  const stackId = activeStackId(process.env);
  if (stackId === undefined) {
    return (await readdir(path.join(cwd, "wiki", "concepts"))).length;
  }
  const handle = createDimensionsDatabase(process.env);
  try {
    const pages = await listStoredPagesUnfiltered(handle.db, stackId);
    return pages.length;
  } finally {
    await handle.close();
  }
}
