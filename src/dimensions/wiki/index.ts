/**
 * @file src/dimensions/wiki.ts
 * @description The `wiki` dimension: ingest into the compiler's own `sources/`.
 *
 * The write itself is not reimplemented here — {@link saveSource} already owns
 * the empty-slug guard, the basename-collision suffix, and the source-identity
 * match that makes a re-ingest update in place instead of forking. Duplicating
 * it would duplicate every protection it carries.
 *
 * What this module adds is **rollback**. The compiler already has a
 * write-ahead intent journal (`src/trust/journal.ts`) that records a target's
 * pre-state before mutating it and can restore that pre-state on demand. We
 * reuse it rather than inventing a second rollback mechanism:
 *
 *   - `prepare` opens a journal batch, passes a `beforeWrite` hook into
 *     `saveSource` so the destination's pre-state is recorded before any byte
 *     lands, then runs the write.
 *   - `discard` reverts the batch's entries and deletes the journal, putting
 *     `sources/` back exactly as it was.
 *   - `commit` deletes the journal, which is what marks the batch resolved.
 *
 * A crash between `prepare` and `commit` leaves a `pending` journal that the
 * existing `replayJournal` startup path reverts, so an interrupted ingest
 * cannot leave a half-written source behind.
 *
 * ## This is the FILE-BACKED half, and the barrel for it only
 *
 * The database-backed pair — `createWikiStoreDimension` and
 * `createWikiPageReader` — is published from `./database.js`, deliberately NOT
 * re-exported here. Re-exporting it would load `drizzle-orm` (a dependency of the
 * KG workspace package, absent from the root manifest) for every caller that only
 * wanted the filesystem wiki. A consumer choosing the database backend imports
 * that entry point; see its file header for the full reasoning.
 */

import { saveSource } from "../../utils/source-writer.js";
import type { WriteStatus } from "../../utils/types.js";
import {
  commitBatch,
  openBatch,
  recordPreState,
  revertEntry,
  type JournalBatch,
} from "../../trust/journal.js";
import type {
  CommittedWrite,
  Dimension,
  DimensionInput,
  PreparedWrite,
} from "../types.js";
import { wikiIdempotencyKey } from "./idempotency.js";

/** Handle carried between `prepare` and `commit` for the wiki dimension. */
interface WikiHandle {
  readonly input: DimensionInput;
  readonly writeStatus: WriteStatus;
  readonly savedPath: string;
  readonly batch: JournalBatch;
}

/**
 * Build the wiki dimension bound to one project root.
 *
 * @param root - Absolute path to the wiki project root.
 */
export function createWikiDimension(root: string): Dimension {
  return {
    name: "wiki",

    async prepare(input: DimensionInput): Promise<PreparedWrite> {
      const batch = await openBatch(root);
      // The hook must run before the write so an interrupted write is
      // revertible; `saveSource` calls it only when a write will actually land.
      const beforeWrite = async (destinationPath: string): Promise<void> => {
        await recordPreState(batch, destinationPath);
      };
      const { path: savedPath, writeStatus } = await saveSource(
        root,
        input.title,
        input.document,
        input.source,
        { beforeWrite },
      );
      const handle: WikiHandle = { input, writeStatus, savedPath, batch };
      return { unchanged: writeStatus === "unchanged", handle };
    },

    async commit(prepared: PreparedWrite): Promise<CommittedWrite> {
      const handle = prepared.handle as WikiHandle;
      await commitBatch(handle.batch);
      return {
        idempotencyKey: wikiIdempotencyKey(handle.input),
        summary: `wiki:${handle.writeStatus}`,
        writeStatus: handle.writeStatus,
        artifactPath: handle.savedPath,
      };
    },

    async discard(prepared: PreparedWrite): Promise<void> {
      const handle = prepared.handle as WikiHandle;
      for (const entry of handle.batch.entries) {
        await revertEntry(entry, handle.batch.root);
      }
      await commitBatch(handle.batch);
    },

    async forget(): Promise<void> {
      // DELIBERATELY A NO-OP. The wiki's removal story is already owned elsewhere:
      // `compile` detects a vanished source file and marks the pages that only it
      // owned as orphaned (`markDeletedAsOrphaned`), which preserves content other
      // sources still support. Deleting here as well would duplicate that decision
      // in a second place, and the two would disagree the moment orphan rules
      // change — one of them would remove a page the other kept.
    },
  };
}
