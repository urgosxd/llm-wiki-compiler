/**
 * @file test/compiler/retirement-port-project.ts
 * @description The one on-disk project the graph-retirement port cases compile:
 * a checkout whose recorded state names a source the disk no longer has.
 *
 * ## Why a project and not a call to the retirement helper
 *
 * The subject of these cases is the REAL compile path — the port is threaded from
 * `compileAndReport` down to the retirement helper, and a case that called the
 * helper directly would pass while the seam above it stayed unwired. So each case
 * needs a project in the single state that reaches retirement at all: one deletion.
 *
 * A deletion cannot be produced by compiling twice, because the first compile would
 * need extraction (a provider call). It is therefore stated directly: state records
 * `deleted-source.md`, and `sources/` does not contain it. That is the same on-disk
 * shape a project has after someone removes a file, and it is setup rather than an
 * assertion — every case asserts an OUTCOME (rejection, recorded request, completed
 * run), never this file's contents.
 *
 * ## Why the source identity is recorded
 *
 * `SourceState.source` is what retirement names to the dimension. Without it the
 * loop in `forgetDeletedSources` skips the source, and a case asserting "the port
 * answered and its answer was used" would observe nothing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LLMWIKI_DIR, STATE_FILE } from "../../packages/wiki/src/utils/constants.js";
import type { WikiState } from "../../packages/wiki/src/utils/types.js";

/** Identity recorded for the missing source, so retirement has something to name. */
const DELETED_SOURCE_IDENTITY = "https://example.test/deleted-source";

/** The file `sources/` no longer holds, recorded in state as compiled. */
const DELETED_SOURCE_FILE = "deleted-source.md";

/**
 * Write a project root whose state names one source that no longer exists.
 *
 * @param root - Empty project root to populate.
 */
export async function seedDeletedSourceProject(root: string): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  const state: WikiState = {
    version: 1,
    indexHash: "",
    sources: {
      [DELETED_SOURCE_FILE]: {
        hash: "hash-of-a-source-the-disk-no-longer-has",
        concepts: [],
        compiledAt: "2026-01-01T00:00:00.000Z",
        source: DELETED_SOURCE_IDENTITY,
      },
    },
  };
  await writeFile(path.join(root, STATE_FILE), JSON.stringify(state), "utf-8");
}
