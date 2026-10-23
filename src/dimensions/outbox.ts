/**
 * @file src/dimensions/outbox.ts
 * @description Durable record of a two-dimension ingest, written before the
 * commit so an interrupted run can be finished or rolled back later.
 *
 * ## Why an outbox rather than a plain transaction
 *
 * The two dimensions cannot share a transaction: one writes a local directory,
 * the other writes rows in an external Postgres. No `BEGIN` spans both, so a
 * process crash between them is a real state that a single transaction cannot
 * prevent. The outbox is what makes that state **recoverable** instead of
 * corrupt:
 *
 *   1. `pending` is written to disk and flushed **before** any dimension
 *      commits. It names every dimension and the idempotency key each will use.
 *   2. Each dimension commits and records its key back into the record.
 *   3. `committed` is written once every dimension succeeded.
 *
 * A record still `pending` on the next run is unfinished work: the reconciler
 * re-runs the dimensions that did not record a key. Because each dimension's
 * commit is idempotent under its key, replay cannot double-write.
 *
 * Records live under `.llmwiki/dimensions/outbox/`, the compiler's existing
 * private directory, so they are never emitted into `wiki/`.
 */

import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { LLMWIKI_DIR } from "../utils/constants.js";
import { atomicWrite } from "../utils/markdown.js";
import type { DimensionName } from "./types.js";

/** Directory holding outbox records, relative to the project root. */
const OUTBOX_DIR = `${LLMWIKI_DIR}/dimensions/outbox`;

/** Lifecycle of one ingest record. */
export type OutboxStatus = "pending" | "committed";

/** What one dimension did, or is expected to do, for one ingest. */
export interface OutboxDimensionEntry {
  /** Which dimension. */
  readonly name: DimensionName;
  /**
   * Idempotency key once the dimension committed, or `null` while it has not.
   * A record whose entry is still `null` is work the reconciler must retry.
   */
  readonly idempotencyKey: string | null;
}

/** One durable ingest record. */
export interface OutboxRecord {
  /** Schema version, so a future format change is detectable. */
  readonly version: 1;
  /** Stable id; also the filename stem. */
  readonly ingestId: string;
  /** Source identity the dimensions were given. */
  readonly source: string;
  /** Human-readable title. */
  readonly title: string;
  /** Document body, retained so a replay needs no re-fetch. */
  readonly document: string;
  /** Extracted body text (no frontmatter), retained for the graph replay. */
  readonly body: string;
  /** Lifecycle status. */
  readonly status: OutboxStatus;
  /** Per-dimension progress. */
  readonly dimensions: readonly OutboxDimensionEntry[];
  /** ISO timestamp of creation. */
  readonly createdAt: string;
}

/** Length of the random suffix appended to a minted ingest id. */
const INGEST_ID_RANDOM_CHARS = 8;

/** Mint a unique ingest id. */
export function mintIngestId(now: number = Date.now()): string {
  const random = Math.random().toString(36).slice(2, 2 + INGEST_ID_RANDOM_CHARS);
  return `${now}-${random}`;
}

/** Absolute path of one record. */
function recordPath(root: string, ingestId: string): string {
  return path.join(root, OUTBOX_DIR, `${ingestId}.json`);
}

/**
 * Persist a record, replacing any existing copy.
 *
 * Uses the project's `atomicWrite` so a torn write cannot leave a half-record
 * that the reconciler would misread.
 *
 * @param root - Project root.
 * @param record - Record to persist.
 */
export async function saveRecord(root: string, record: OutboxRecord): Promise<void> {
  await mkdir(path.join(root, OUTBOX_DIR), { recursive: true });
  await atomicWrite(recordPath(root, record.ingestId), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Delete a record. Missing is not an error: two concurrent replays racing on
 * the same record must both finish successfully.
 */
export async function removeRecord(root: string, ingestId: string): Promise<void> {
  try {
    await unlink(recordPath(root, ingestId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/** Parse one record, returning `null` when the file is unreadable or malformed. */
function parseRecord(raw: string): OutboxRecord | null {
  try {
    const parsed = JSON.parse(raw) as OutboxRecord;
    if (parsed.version !== 1) return null;
    if (typeof parsed.ingestId !== "string") return null;
    if (parsed.status !== "pending" && parsed.status !== "committed") return null;
    if (!Array.isArray(parsed.dimensions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load every record in the outbox.
 *
 * A malformed record is reported as `unreadable` rather than silently skipped,
 * because skipping it would hide exactly the kind of interrupted write the
 * outbox exists to catch.
 *
 * @param root - Project root.
 */
export async function loadRecords(
  root: string,
): Promise<{ records: OutboxRecord[]; unreadable: string[] }> {
  const dir = path.join(root, OUTBOX_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], unreadable: [] };
    }
    throw error;
  }

  const records: OutboxRecord[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = parseRecord(await readFile(path.join(dir, name), "utf-8"));
    if (parsed === null) unreadable.push(name);
    else records.push(parsed);
  }
  return { records, unreadable };
}
