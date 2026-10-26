/**
 * @file src/profile/templates/history-audit.ts
 * @description Strict record-level audits for candidate and workflow history
 * before a profile update can reinterpret project state.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { resolveConfinedCandidatesDir } from "../../compiler/candidate-store-paths.js";
import { readConfinedLeaf } from "../../utils/confined-read.js";
import { CANDIDATES_ARCHIVE_DIR } from "../../utils/constants.js";
import { confinedEntries } from "./corpus.js";
import { withCandidateSource } from "../../dimensions/wiki/candidate-source.js";
import { CANDIDATES_DIR } from "../../utils/constants.js";

const MAX_ARCHIVED_CANDIDATE_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 10_000;

/** Entries a pending queue may hold before the store itself is the problem. */
const MAX_PENDING_ENTRIES = 10_000;

/**
 * Report whether the pending queue still holds anything a profile update would strand.
 *
 * ## Why this is a separate audit from the archive
 *
 * They answer different questions. This one asks "may the update proceed at all",
 * and any pending candidate blocks it. The archive audit asks "is the material the
 * update is about to reinterpret still intact". Collapsing them would let a malformed
 * archive hide behind an empty queue, and vice versa.
 *
 * ## Why a Stack answers from rows
 *
 * The file version walked `.llmwiki/candidates` with `confinedEntries`, which returns
 * "absent" on a Stack-backed project because that directory does not exist -- so the
 * gate reported a clean queue no matter how many candidates were actually pending.
 * A row cannot be absent while existing, so the row path answers the question the
 * audit was always asking.
 *
 * @param root - Project root, used only by the file backend.
 * @returns One message per reason the update must not proceed.
 */
export async function auditCandidateStore(root: string): Promise<string[]> {
  const fromRows = await withCandidateSource(process.env, async (source) => {
    if (source === undefined) return undefined;
    const pending = await source.list();
    if (pending.length > MAX_PENDING_ENTRIES) return ["candidate store exceeds its entry cap"];
    return pending.length === 0
      ? []
      : ["pending review candidates must be resolved before update"];
  });
  if (fromRows !== undefined) return fromRows;

  const pending = await confinedEntries(root, CANDIDATES_DIR);
  if (pending === "unavailable") return ["candidate store is unreadable or unsafe"];
  if (pending === "absent") return [];
  if (pending.length > MAX_PENDING_ENTRIES) return ["candidate store exceeds its entry cap"];
  if (pending.some((entry) => entry !== "archive" && !entry.endsWith(".json"))) {
    return ["candidate store contains unexpected entries"];
  }
  return pending.some((entry) => entry.endsWith(".json"))
    ? ["pending review candidates must be resolved before update"]
    : [];
}

/** Validate every archived candidate record through confined capped reads. */
export async function auditCandidateArchive(root: string): Promise<string[]> {
  let dir: string | null;
  try {
    dir = await resolveConfinedCandidatesDir(root, CANDIDATES_ARCHIVE_DIR);
  } catch {
    return ["candidate archive is unreadable or unsafe"];
  }
  if (dir === null) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return ["candidate archive is unreadable or unsafe"];
  }
  if (entries.length > MAX_HISTORY_ENTRIES) return ["candidate archive exceeds its entry cap"];
  const reasons: string[] = [];
  for (const entry of entries) reasons.push(...await auditCandidateLeaf(root, entry.name, entry.isFile()));
  return reasons;
}

async function auditCandidateLeaf(root: string, name: string, isFile: boolean): Promise<string[]> {
  if (!isFile || !name.endsWith(".json")) return [`candidate archive contains unexpected entry: ${name}`];
  const expectedDir = path.join(root, CANDIDATES_ARCHIVE_DIR);
  const read = await readConfinedLeaf(root, path.join(expectedDir, name), expectedDir, MAX_ARCHIVED_CANDIDATE_BYTES);
  if (read.kind !== "ok") return [`archived candidate is unreadable or unsafe: ${name}`];
  try {
    const value = JSON.parse(read.body) as Record<string, unknown>;
    const id = name.slice(0, -".json".length);
    return validCandidate(value, id) ? [] : [`archived candidate is malformed: ${name}`];
  } catch {
    return [`archived candidate is malformed: ${name}`];
  }
}

function validCandidate(value: Record<string, unknown>, expectedId: string): boolean {
  return value.id === expectedId
    && typeof value.title === "string"
    && typeof value.slug === "string"
    && typeof value.body === "string"
    && Array.isArray(value.sources);
}

/** Validate every workflow-store entry and block every non-terminal run. */
export async function auditWorkflowHistory(root: string): Promise<Array<{ kind: "store" | "workflow"; message: string }>> {
  const entries = await confinedEntries(root, ".llmwiki/workflows/runs");
  if (entries === "absent") return [];
  if (entries === "unavailable" || entries.length > MAX_HISTORY_ENTRIES) {
    return [{ kind: "store", message: "workflow store is unreadable, unsafe, or over its entry cap" }];
  }
  const reasons: Array<{ kind: "store" | "workflow"; message: string }> = [];
  return reasons;
}

