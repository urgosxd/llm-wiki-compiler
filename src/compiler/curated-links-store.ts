/**
 * @file The durable curated-link STORE, and the one function that applies it to bodies
 * (S8, S9, S12).
 *
 * WHERE IT LIVES AND WHY. `.llmwiki/curated-links.json`, beside `state.json`,
 * `pending-embeddings.json` and `rule-state.json`, because that directory is this
 * project's convention for durable compiler state: it is never emitted into `wiki/`, it
 * is resolved through the same trust-boundary helpers as the lock, and every file in it
 * is written with the shared hardened {@link atomicWrite} (random `O_EXCL` temp then
 * `rename`) so a crash leaves either the old file or the new one.
 *
 * WHY NOT A PAGE AND NOT A ROW. Not a page: a curated link is not a document and must
 * never appear in the wiki's own listing. Not a row: the derived-artifact store keys on
 * `(stack_id, kind)` with a constrained `kind` and one row per kind, and the pending-marker
 * rows are a two-value set (`pending`/`quarantined`) with no place for N link records. A
 * row would need a schema change nobody asked for, so a Stack-backed project keeps its
 * curated links in the same confined file. That is a LIMITATION, stated rather than
 * faked: on a Stack the pages live in rows and the curated records live on the host that
 * compiled them, so two hosts sharing one Stack do not share their curated links.
 *
 * CONFINEMENT IS ENFORCED AT BOTH LEVELS, exactly as `pending-embeddings.ts` does it:
 * the directory through {@link resolveConfinedPrivateDir} / {@link
 * resolveExistingConfinedPrivateDir} (never a raw `path.join(root, ...)` that would follow
 * an escaping `.llmwiki` symlink), and the leaf by writing through `atomicWrite` with
 * `confineRoot` and reading with `O_RDONLY | O_NOFOLLOW` plus a byte cap.
 *
 * FAIL CLOSED ON A FILE THIS BUILD DOES NOT UNDERSTAND. A store whose `version` is above
 * {@link CURATED_LINK_STORE_VERSION} is never read into the overlay and never written
 * through; the run warns and continues with no curated links. An entry that does not
 * validate -- wrong field types, an unknown provenance, or a `stableKey` that does not
 * recompute from its own (source, target, anchor) -- is skipped with a warning naming how
 * many were skipped, and the next write persists the cleaned set.
 */

import { openFileNoFollow } from "../utils/no-follow-open.js";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { atomicWrite } from "../utils/markdown.js";
import { CURATED_LINKS_FILE, MAX_CURATED_LINKS_BYTES } from "../utils/constants.js";
import {
  CURATED_LINK_STORE_VERSION,
  CURATED_PROVENANCES,
  addCuratedLinks,
  curatedLinkKey,
  sortLinks,
  type CuratedLinkAnchor,
  type CuratedLinkCounts,
  type CuratedLinkProvenance,
  type CuratedLinkRecord,
  type CuratedLinkStore,
} from "./curated-links.js";
import {
  resolveConfinedPrivateDir,
  resolveExistingConfinedPrivateDir,
} from "../utils/private-dir.js";
import { isPlainObject } from "../utils/state.js";
import * as output from "../utils/output.js";

/** How a read of the store ended. */
interface CuratedLinkRead {
  /** `absent` is a clean empty project; `unavailable` is a file that cannot be trusted. */
  status: "ok" | "absent" | "unavailable";
  /** The store, empty unless `status` is `ok`. */
  store: CuratedLinkStore;
  /** Why the store is unavailable, for the warning line. */
  detail?: string;
}

/** A fresh, empty store. */
export function emptyCuratedLinkStore(): CuratedLinkStore {
  return { version: CURATED_LINK_STORE_VERSION, links: [] };
}

/** The file path inside an already-confined `.llmwiki`. */
function storeIn(privateDir: string): string {
  return path.join(privateDir, path.basename(CURATED_LINKS_FILE));
}

/**
 * Read the store, classifying the outcome without side effects.
 *
 * @param root - Absolute project root.
 * @returns What the store holds, or that it is absent or untrustworthy.
 */
async function readCuratedLinkStore(root: string): Promise<CuratedLinkRead> {
  let privateDir: string | null;
  try {
    privateDir = await resolveExistingConfinedPrivateDir(root);
  } catch {
    return { status: "unavailable", store: emptyCuratedLinkStore(), detail: "escape" };
  }
  if (privateDir === null) return { status: "absent", store: emptyCuratedLinkStore() };
  const read = await readStoreLeaf(storeIn(privateDir));
  if (read.kind === "absent") return { status: "absent", store: emptyCuratedLinkStore() };
  if (read.kind === "unreadable") {
    return { status: "unavailable", store: emptyCuratedLinkStore(), detail: "unreadable" };
  }
  return parseStore(read.body);
}

/** What opening the store leaf produced, with absence kept apart from distrust. */
type StoreLeafRead = { kind: "absent" } | { kind: "unreadable" } | { kind: "ok"; body: string };

/**
 * Open the leaf without following a symlink, require a regular file, and read it under
 * the byte cap. A symlinked or oversized leaf is `unreadable`, never read through.
 *
 * @param filePath - Absolute path inside the confined `.llmwiki`.
 * @returns The bytes, or why there are none.
 */
async function readStoreLeaf(filePath: string): Promise<StoreLeafRead> {
  const opened = await openFileNoFollow(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    .then((handle) => ({ handle }))
    .catch((err: NodeJS.ErrnoException) => ({ err }));
  if ("err" in opened) return { kind: opened.err?.code === "ENOENT" ? "absent" : "unreadable" };
  try {
    const stat = await opened.handle.stat();
    const readable = stat.isFile() && stat.size <= MAX_CURATED_LINKS_BYTES;
    return readable ? { kind: "ok", body: await opened.handle.readFile("utf-8") } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/**
 * Parse store bytes into a trusted store, or report why they cannot be trusted.
 *
 * @param raw - The file's bytes.
 * @returns The classified read.
 */
function parseStore(raw: string): CuratedLinkRead {
  const parsed = parseJson(raw);
  if (parsed === undefined) return unavailable("corrupt");
  const header = storeHeaderOf(parsed);
  if ("detail" in header) return unavailable(header.detail);
  const valid = header.links.map(coerceRecord).filter((record): record is CuratedLinkRecord => record !== null);
  if (valid.length !== header.links.length) {
    warnSkippedRecords(header.links.length - valid.length);
  }
  return { status: "ok", store: { version: header.version, links: sortLinks(valid) } };
}

/** A store header this build can read: its version and its raw entries. */
interface StoreHeader {
  version: number;
  links: unknown[];
}

/** The bytes as JSON, or undefined when they are not JSON at all. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A read that holds no trusted store. */
function unavailable(detail: string): CuratedLinkRead {
  return { status: "unavailable", store: emptyCuratedLinkStore(), detail };
}

/**
 * Validate the store's header, failing closed on a layout this build does not know.
 *
 * A `version` ABOVE {@link CURATED_LINK_STORE_VERSION} is the forward-incompatible case:
 * the file is left alone rather than rewritten, because a write would drop whatever
 * fields the newer build added.
 *
 * @param parsed - The parsed file.
 * @returns The version and raw entries, or the detail to report.
 */
function storeHeaderOf(parsed: unknown): StoreHeader | { detail: string } {
  if (!isPlainObject(parsed)) return { detail: "schema" };
  const { version, links } = parsed;
  if (typeof version !== "number" || !Number.isInteger(version)) return { detail: "schema" };
  if (version > CURATED_LINK_STORE_VERSION) return { detail: `version ${version}` };
  return Array.isArray(links) ? { version, links } : { detail: "schema" };
}

/** Report entries the store held that this build could not use. */
function warnSkippedRecords(count: number): void {
  output.status("!", output.warn(
    `Ignored ${count} malformed curated-link record(s) in ${CURATED_LINKS_FILE}; ` +
      "the next write replaces them.",
  ));
}

/**
 * One stored entry as a record, or null when it does not validate.
 *
 * The `stableKey` is recomputed from the entry's own identities instead of trusted, so a
 * hand-edited key cannot make two different links collide into one.
 *
 * @param entry - A raw store element.
 * @returns The record, or null.
 */
function coerceRecord(entry: unknown): CuratedLinkRecord | null {
  const parts = recordPartsOf(entry);
  if (parts === null) return null;
  const stableKey = curatedLinkKey(parts.sourcePageId, parts.targetPageId, parts.anchor.text);
  return parts.stableKey === stableKey ? { ...parts, stableKey } : null;
}

/**
 * The plain fields one stored entry must carry, with its anchor validated.
 *
 * @param entry - A raw store element.
 * @returns The fields, or null when any of them is the wrong shape.
 */
function recordPartsOf(entry: unknown): CuratedLinkRecord | null {
  if (!isPlainObject(entry)) return null;
  const { sourcePageId, targetPageId, provenance, createdAt, stableKey, anchor } = entry;
  if (typeof sourcePageId !== "string" || typeof targetPageId !== "string") return null;
  if (typeof createdAt !== "string" || typeof stableKey !== "string") return null;
  if (!CURATED_PROVENANCES.includes(provenance as CuratedLinkProvenance)) return null;
  const validAnchor = anchorOf(anchor);
  if (validAnchor === null) return null;
  return {
    stableKey,
    sourcePageId,
    targetPageId,
    anchor: validAnchor,
    provenance: provenance as CuratedLinkProvenance,
    createdAt,
  };
}

/**
 * A stored anchor, with its two context sides defaulted to empty.
 *
 * @param raw - The raw `anchor` field.
 * @returns The anchor, or null when it names no mention.
 */
function anchorOf(raw: unknown): CuratedLinkAnchor | null {
  if (!isPlainObject(raw)) return null;
  const { text, before, after } = raw;
  if (typeof text !== "string" || text.trim() === "") return null;
  return {
    text,
    before: typeof before === "string" ? before : "",
    after: typeof after === "string" ? after : "",
  };
}

/**
 * Every trusted curated record of this project.
 *
 * A read the store cannot answer returns no records rather than failing the caller: the
 * overlay is an improvement to a page, never a precondition for publishing one.
 *
 * @param root - Absolute project root.
 * @returns The records, or an empty list when the store is absent or untrustworthy.
 */
export async function loadCuratedLinks(root: string): Promise<readonly CuratedLinkRecord[]> {
  const read = await readCuratedLinkStore(root);
  if (read.status === "unavailable") {
    output.status("!", output.warn(
      `Curated links unavailable (${read.detail ?? "unreadable"}); ` +
        `pages will be written without restoring them.`,
    ));
  }
  return read.store.links;
}

/**
 * Read, transform and atomically write the store.
 *
 * The mutation runs only on a store this build understands, so a forward-incompatible
 * file is never silently rewritten. When the mutation changes nothing, nothing is
 * written: an unchanged run leaves the file byte-identical, which is what makes a no-op
 * compile a no-op on disk.
 *
 * @param root - Absolute project root.
 * @param mutate - Computes the next store; returns the input unchanged for no-op.
 * @returns True when the file was written.
 */
async function mutateCuratedLinks(
  root: string,
  mutate: (store: CuratedLinkStore) => CuratedLinkStore,
): Promise<boolean> {
  const read = await readCuratedLinkStore(root);
  if (read.status === "unavailable") return false;
  const next = mutate(read.store);
  if (JSON.stringify(next) === JSON.stringify(read.store)) return false;
  const privateDir = await resolveConfinedPrivateDir(root);
  const body = `${JSON.stringify(next, null, 2)}\n`;
  await atomicWrite(storeIn(privateDir), body, { confineRoot: path.dirname(privateDir) });
  return true;
}

/**
 * Store the records one review run produced, holding both named bounds.
 *
 * @param root - Absolute project root.
 * @param incoming - Records in the order the review accepted them.
 * @param tally - Counters to fill with what was stored and what a bound refused.
 */
export async function recordCuratedLinks(
  root: string,
  incoming: readonly CuratedLinkRecord[],
  tally: CuratedLinkCounts,
): Promise<void> {
  if (incoming.length === 0) return;
  await mutateCuratedLinks(root, (store) => addCuratedLinks(store, incoming, tally));
}

/**
 * Remove the records the overlay refused to re-anchor, so a dead link is not re-dropped
 * (and re-reported) on every later run.
 *
 * @param root - Absolute project root.
 * @param stableKeys - Keys of the dropped records.
 * @returns How many records were removed.
 */
export async function dropCuratedLinks(
  root: string,
  stableKeys: readonly string[],
): Promise<number> {
  if (stableKeys.length === 0) return 0;
  const dead = new Set(stableKeys);
  let removed = 0;
  await mutateCuratedLinks(root, (store) => {
    const links = store.links.filter((record) => !dead.has(record.stableKey));
    removed = store.links.length - links.length;
    return removed === 0 ? store : { ...store, links };
  });
  return removed;
}
