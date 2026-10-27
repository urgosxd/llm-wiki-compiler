/**
 * @file src/dimensions/wiki/source-projection.ts
 * @description The one write an ingest cannot put inside a Postgres transaction:
 * `sources/<slug>.md`.
 *
 * ## Why this is a projection and not part of the commit
 *
 * Atomic ingest runs both dimensions in ONE transaction (dimension port v3), so a
 * failure leaves neither the wiki rows nor the graph rows behind. A file write
 * cannot join that transaction: `saveSource` is a bare `writeFile`, and no
 * ordering of statements makes a filesystem operation participate in a COMMIT.
 *
 * So the file moves AFTER the commit, which buys the property that matters most:
 * when the transaction fails, **the file was never touched**. "Clean up the source
 * after a failed ingest" then costs nothing in the case that actually happens,
 * instead of being a delete that could destroy content a previous ingest produced.
 *
 * ## The residual, stated rather than hidden
 *
 * The projection itself can fail after the rows committed. That leaves rows with no
 * file, and this module chooses to REPORT it rather than destroy good rows: the
 * rows are the truth, and `compile` discovers work from `wiki.source_documents`
 * whenever a Stack is configured, so the next compile re-detects the source. What
 * is never acceptable is deleting a row that a successful transaction committed.
 *
 * ## Compensation, and why it needs the pre-state
 *
 * `saveSource` exposes `beforeWrite`, which fires with the resolved destination
 * path before anything is written and is skipped for a no-op. That is exactly the
 * hook a compensation needs, and it is why this module did not have to grow its own
 * journal:
 *
 *   - the path did not exist  -> remove it, because this attempt created it
 *   - the path did exist      -> restore the bytes it had, because this attempt
 *                                overwrote them
 *
 * Restoring rather than deleting is what keeps a failed re-ingest from wiping a
 * source that was working before the attempt.
 */

import { readFile, unlink, writeFile } from "node:fs/promises";

import { saveSource } from "../../utils/source-writer.js";
import type { WriteStatus } from "../../utils/types.js";

/** What the destination looked like before this attempt wrote to it. */
type PreWriteState =
  | { readonly existed: false }
  | { readonly existed: true; readonly bytes: string };

/** Outcome of projecting one source onto disk. */
export interface ProjectionResult {
  /** Absolute path the source landed at. */
  readonly artifactPath: string;
  /** Whether the file was created, updated, or already current. */
  readonly writeStatus: WriteStatus;
}

/**
 * Read the destination before it is overwritten.
 *
 * Called through `saveSource`'s `beforeWrite`, so it only ever runs for a write
 * that will actually happen. A read failure here is not fatal to the projection:
 * treating an unreadable destination as absent would make the compensation delete
 * a file it could not restore, so the state is recorded as "existed but empty",
 * which makes the compensation refuse to delete it.
 *
 * @param destinationPath - Absolute path about to be written.
 * @returns The destination's prior state.
 */
async function capturePreWriteState(destinationPath: string): Promise<PreWriteState> {
  try {
    return { existed: true, bytes: await readFile(destinationPath, "utf-8") };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { existed: false };
    // Unreadable but present: refuse to claim it was absent.
    return { existed: true, bytes: "" };
  }
}

/**
 * Undo a projection that failed after the transaction committed.
 *
 * Best effort by construction: if the rollback of the FILE fails there is nothing
 * further to try, and reporting the original projection error is more useful to
 * the operator than a second error about cleanup.
 *
 * @param destinationPath - Path the projection was writing.
 * @param preWrite - What the destination looked like before.
 */
async function restorePreWrite(
  destinationPath: string,
  preWrite: PreWriteState,
): Promise<void> {
  if (!preWrite.existed) {
    await unlink(destinationPath).catch(() => undefined);
    return;
  }
  await writeFile(destinationPath, preWrite.bytes, "utf-8").catch(() => undefined);
}

/**
 * Write one source's markdown into `sources/`, with self-compensation.
 *
 * Runs AFTER the ingest transaction commits, and undoes its own half if it fails.
 * The caller decides what to report; this never throws a cleanup error over the
 * original failure, because the original failure is the one worth reading.
 *
 * @param root - Project root; `sources/` is resolved against it.
 * @param input - Title, full markdown, and source identity.
 * @returns Where the source landed and whether it changed.
 * @throws Whatever `saveSource` threw, after the destination is restored.
 */
export async function projectSourceMarkdown(
  root: string,
  input: { readonly title: string; readonly document: string; readonly source: string },
): Promise<ProjectionResult> {
  let preWrite: PreWriteState | undefined;
  let destinationPath: string | undefined;

  try {
    const saved = await saveSource(root, input.title, input.document, input.source, {
      beforeWrite: async (path) => {
        destinationPath = path;
        preWrite = await capturePreWriteState(path);
      },
    });
    return { artifactPath: saved.path, writeStatus: saved.writeStatus };
  } catch (error) {
    // `destinationPath` is set only once `beforeWrite` fired, so an error before
    // that point (the empty-slug guard, path confinement) left nothing to undo.
    if (destinationPath !== undefined && preWrite !== undefined) {
      await restorePreWrite(destinationPath, preWrite);
    }
    throw error;
  }
}
