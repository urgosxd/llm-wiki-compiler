/**
 * @file src/services/ingest/jobs/failure-log.ts
 * @description Durable, append-only record of a FAILED async ingest job.
 *
 * ## Why a failed job needs durability when a running one does not
 *
 * Job state lives in process memory, which is the right cost for progress: a
 * running ingest is already serialized by the project lock, and a queued job
 * cannot live inside a transaction that has not opened. Lose the process and the
 * progress is gone.
 *
 * A FAILURE is different. "The upload never appeared" is the question a user asks
 * tomorrow, and an answer that vanished with the process is the same as no answer.
 * So every failed job appends one JSON line here, and a restart can explain what
 * happened without having kept the whole job.
 *
 * ## Append-only, bounded per line, and never fatal
 *
 * The write is best-effort by contract: a job's failure is already the caller's
 * problem, and replacing it with a logging error would hide the cause. What is
 * NOT best-effort is the shape -- one line, one JSON object, fixed field names --
 * so `grep` and `jq` both work without a parser.
 *
 * The record carries no page text, no source body, and no credentials: the source
 * IDENTITY, the stage it died in, and the error message. That is what explains the
 * failure and nothing that would make the log unsafe to share.
 */

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { openFileNoFollow } from "../../../utils/no-follow-open.js";
import { LLMWIKI_DIR } from "../../../utils/constants.js";
import type { IngestJob } from "./types.js";

/** Basename of the failure log inside {@link LLMWIKI_DIR}. */
export const FAILURE_LOG_FILE = "ingest-failures.jsonl";

/** Discriminator on every record, so one query selects one shape. */
const FAILURE_RECORD_KIND = "ingest_job_failed";

/** Log file mode: owner rw, group/other r. Matches the other project stores. */
const LOG_FILE_MODE = 0o644;

/**
 * Append flags: create if absent, append-only, and never follow a symlink.
 *
 * `O_NOFOLLOW` matters because the project tree is writable, and a log that
 * followed a symlink would let a planted link redirect the failure record
 * somewhere else in the filesystem.
 */
const APPEND_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND
  | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;

/** The one-line JSON shape {@link recordJobFailure} writes. */
export interface JobFailureRecord {
  readonly kind: typeof FAILURE_RECORD_KIND;
  readonly jobId: string;
  readonly source: string;
  /** Stage the ingest died in, when it got that far. */
  readonly stage?: string;
  /** Compile stage, when the ingest succeeded and the compile is what failed. */
  readonly compileStage?: string;
  readonly error?: string;
  readonly at: string;
}

/**
 * Reduce a job to the record worth keeping.
 *
 * Both dimensions are considered, because either can be the half that failed. An
 * ingest that succeeded before a failed compile still records the compile stage --
 * reporting only the ingest would say "failed" about a source that is on disk.
 *
 * @param job - The failed job snapshot.
 * @returns The durable record for it.
 */
export function failureRecordOf(job: IngestJob): JobFailureRecord {
  return {
    kind: FAILURE_RECORD_KIND,
    jobId: job.id,
    source: job.source,
    ...(job.ingest.stage === undefined ? {} : { stage: job.ingest.stage }),
    ...(job.compile.stage === undefined ? {} : { compileStage: job.compile.stage }),
    ...(job.ingest.error === undefined && job.compile.error === undefined
      ? {}
      : { error: job.ingest.error ?? job.compile.error }),
    at: job.updatedAt,
  };
}

/**
 * Append one failure record for `job`, best-effort.
 *
 * Never throws, and never rejects: see the file overview. A caller therefore does
 * not need to guard this, and one failing log costs the record rather than the
 * response.
 *
 * @param root - Project root; the log lives under `<root>/.llmwiki/`.
 * @param job - The failed job snapshot.
 */
export async function recordJobFailure(root: string, job: IngestJob): Promise<void> {
  const line = `${JSON.stringify(failureRecordOf(job))}\n`;
  const dir = path.join(root, LLMWIKI_DIR);
  const file = path.join(dir, FAILURE_LOG_FILE);
  try {
    // The open below is O_CREAT on the FILE only, so a project that has never
    // written anything under `.llmwiki/` would fail with ENOENT. Creating the
    // directory first is what makes the first failure record as durable as the
    // hundredth -- the first one is the one a fresh project needs most.
    await mkdir(dir, { recursive: true });
    const handle = await openFileNoFollow(file, APPEND_FLAGS, LOG_FILE_MODE);
    try {
      await handle.appendFile(line);
    } finally {
      await handle.close();
    }
  } catch {
    // Deliberately swallowed: the failure record is a diagnostic, and losing it
    // must never replace the real failure the caller is already handling.
  }
}
