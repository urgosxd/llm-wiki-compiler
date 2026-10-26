/**
 * Raw candidate rejection deliberately bypasses promotion admission so a record
 * whose validated-answer metadata is malformed can still be archived by its
 * explicit safe id. Only the filename identifies the record; its JSON is never
 * parsed or trusted for paths. Custody capture keeps the store's confinement,
 * regular-file and race guards without sanitizing the archived bytes.
 */
import { captureCandidateCustody } from "./candidate-custody.js";
import { archiveCandidate } from "./candidates.js";
import { assertWritableCandidateId } from "./candidate-paths.js";
import { withCandidateSource } from "../dimensions/wiki/candidate-source.js";
import * as output from "../utils/output.js";

/** Report absence while leaving unsafe ids and genuine store failures visible. */
export async function loadRejectableCandidateOrFail(root: string, id: string): Promise<boolean> {
  // A row IS the record, so "exists" is a lookup rather than a custody capture. The
  // custody call below is a filesystem precondition a Stack-backed project has no
  // leaf for and would always answer "not found" to.
  const fromRows = await withCandidateSource(process.env, async (source) => {
    if (source === undefined) return undefined;
    // A row is addressed by a bound parameter, so an unsafe id cannot escape a path.
    // It still must not be reported as ABSENCE: "not found" would hide a caller
    // passing `../outside` behind the same message a genuinely missing candidate gets.
    assertWritableCandidateId(id);
    return (await source.get(id)) !== undefined;
  });
  if (fromRows !== undefined) {
    if (fromRows) return true;
    output.status("!", output.error(`Candidate not found or removed during review: ${id}`));
    process.exitCode = 1;
    return false;
  }

  const custody = await captureCandidateCustody(root, id, undefined, "public");
  if (custody !== null) return true;
  output.status("!", output.error(`Candidate not found or removed during review: ${id}`));
  process.exitCode = 1;
  return false;
}

/** Archive the original queue file through the custody move without admission. */
export async function archiveRejectedCandidate(root: string, id: string): Promise<boolean> {
  if (!await loadRejectableCandidateOrFail(root, id)) return false;

  // A rejected candidate leaves the pending queue. Rows have no archive directory to
  // move a file into, so the archive IS the removal: the record stops being pending,
  // which is the only state the queue exposes. Returning the honest boolean keeps the
  // caller's "reported removed vs already gone" distinction intact.
  const viaRows = await withCandidateSource(process.env, async (source) =>
    source === undefined ? undefined : await source.remove(id),
  );
  if (viaRows !== undefined) return viaRows;

  let archived = false;
  try {
    archived = await archiveCandidate(root, id);
  } catch {
    archived = false;
  }
  if (!archived) {
    output.status("!", output.error("Candidate could not be archived safely."));
    process.exitCode = 1;
  }
  return archived;
}
