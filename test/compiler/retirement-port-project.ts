/**
 * @file test/compiler/retirement-port-project.ts
 * @description The one on-disk project the graph-retirement port cases compile:
 * a checkout whose recorded state names a source the disk no longer has — stated in
 * the backend the run actually reads.
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
 * ## TWO seeds, because a run reads ONE backend and the presence of a database decides
 *
 * `resolveStackAuthority` (`packages/wiki/src/dimensions/stack-authority.ts`) answers
 * the named `file` mode ONLY when nothing configured a database. Every state seam —
 * `wikiStateRowsBackend`, `sourceChangeDetection`, `sourceContentReading`, and
 * `CompileStateDraft.load` behind them — gates on that single authority, so a suite
 * that sets `AKS_DATABASE_URL` reads ROWS and never consults `.llmwiki/state.json`.
 * Absence of `AKS_STACK_ID` does NOT keep a run file-backed; it only leaves the Stack
 * to be resolved (and provisioned) at the default domain.
 *
 * So the deletion has to be stated in the backend the run under test reads:
 *
 *   - {@link seedDeletedSourceProject} writes `.llmwiki/state.json`, for the
 *     `file` mode cases (`graph-retirement-port-invocation.test.ts`).
 *   - {@link seedDeletedSourceRows} and its siblings write `wiki.source_compile_state`
 *     rows for the row-backed cases, WITH NO `wiki.source_documents` row for that
 *     identity. That missing document is what makes `findDeletedDocuments`
 *     (`packages/wiki/src/compiler/hasher.ts`) report a deletion, and the compile
 *     record that survives it is the tombstone the schema no longer cascades away.
 *
 * ## Why the source identity is recorded
 *
 * `SourceState.source` is what retirement names to the dimension, and
 * `toSourceState` (`wiki-state-source.ts`) fills it from the row's `source_ref`
 * column. Without it the loop in `forgetDeletedSources` skips the source, and a case
 * asserting "the port answered and its answer was used" would observe nothing. The
 * row seed therefore keeps `source_ref` and `source_identity` the SAME value, which
 * is also the key `findDeletedDocuments` subtracts.
 *
 * ## Why the recording port lives here too
 *
 * Every case in this suite threads ONE port down the real compile path and then
 * reads the identities it received. Restating that double per case made each case
 * carry its own copy of the same `forget` sink, which is a copy the duplication gate
 * is right to call a clone: two copies of one double can drift until one case stops
 * observing the call the other still measures. The double therefore lives once here,
 * beside the seeds, and each case supplies only the sink it asserts on.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseHandle } from "@repo/foundation";
import { LLMWIKI_DIR, STATE_FILE } from "../../packages/wiki/src/utils/constants.js";
import { writeWikiStateToRows } from "../../packages/wiki/src/dimensions/wiki/wiki-state-source.js";
import type { DimensionsPort } from "../../packages/wiki/src/sdk/core-types.js";
import type { Dimension, DimensionName } from "../../packages/wiki/src/dimensions/types.js";
import type { SourceState, WikiState } from "../../packages/wiki/src/utils/types.js";

/** Identity recorded for the missing source, so retirement has something to name. */
export const DELETED_SOURCE_IDENTITY = "https://example.test/deleted-source";

/** Identities the two-source seed records, in the order the state holds them. */
export const TWO_DELETED_IDENTITIES = ["https://example.test/a", "https://example.test/b"] as const;

/** The file `sources/` no longer holds, recorded in state as compiled. */
const DELETED_SOURCE_FILE = "deleted-source.md";

/** The compile record both seeds state for the source the project no longer has. */
const DELETED_ENTRY: SourceState = {
  hash: "hash-of-a-source-the-disk-no-longer-has",
  concepts: [],
  compiledAt: "2026-01-01T00:00:00.000Z",
  source: DELETED_SOURCE_IDENTITY,
};

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
    sources: { [DELETED_SOURCE_FILE]: DELETED_ENTRY },
  };
  await writeFile(path.join(root, STATE_FILE), JSON.stringify(state), "utf-8");
}

/**
 * Persist one compile state for a Stack, through the production writer.
 *
 * `writeWikiStateToRows` is reused rather than re-stated as an `insert`: it is the
 * function that owns the row shape, including the `source_ref` column that carries
 * the identity, so a seed that bypassed it could state a record no reader could
 * interpret.
 *
 * @param db - Handle bound to the Stack's database.
 * @param stackId - Stack the deletion belongs to.
 * @param sources - Entries to record, keyed by source identity.
 */
async function seedRecordedRows(
  db: DatabaseHandle,
  stackId: string,
  sources: Record<string, SourceState>,
): Promise<void> {
  await writeWikiStateToRows(db, stackId, { version: 2, indexHash: "", sources });
}

/**
 * Record the deletion as a ROW: a compile record with no document behind it.
 *
 * The absence of a `wiki.source_documents` row for {@link DELETED_SOURCE_IDENTITY} is
 * the staging, not an omission: it is exactly the state a removed source leaves.
 *
 * @param db - Handle bound to the Stack's database.
 * @param stackId - Stack the deletion belongs to.
 */
export async function seedDeletedSourceRows(db: DatabaseHandle, stackId: string): Promise<void> {
  await seedRecordedRows(db, stackId, { [DELETED_SOURCE_IDENTITY]: DELETED_ENTRY });
}

/**
 * Record the deletion WITHOUT a `source` identity, as state written before v2 has it.
 *
 * @param db - Handle bound to the Stack's database.
 * @param stackId - Stack the deletion belongs to.
 */
export async function seedIdentitylessSourceRows(db: DatabaseHandle, stackId: string): Promise<void> {
  const identityless: SourceState = { ...DELETED_ENTRY };
  delete identityless.source;
  await seedRecordedRows(db, stackId, { [DELETED_SOURCE_IDENTITY]: identityless });
}

/**
 * Record TWO deletions, each under its own identity.
 *
 * @param db - Handle bound to the Stack's database.
 * @param stackId - Stack the deletions belong to.
 */
export async function seedTwoDeletedSourceRows(db: DatabaseHandle, stackId: string): Promise<void> {
  const [first, second] = TWO_DELETED_IDENTITIES;
  await seedRecordedRows(db, stackId, {
    [first]: { ...DELETED_ENTRY, hash: `${DELETED_ENTRY.hash}-a`, source: first },
    [second]: { ...DELETED_ENTRY, hash: `${DELETED_ENTRY.hash}-b`, source: second },
  });
}

/**
 * One graph dimension that records every retirement and refuses every write phase.
 *
 * Retirement is the only thing a compile may ask a dimension for, so a call into
 * `prepare`, `commit` or `discard` has to surface as a failure rather than pass
 * quietly as an unobserved no-op.
 *
 * @param name - Dimension name the retirement helper receives.
 * @param retired - Sink each retired source identity is pushed into, in call order.
 * @returns A dimension whose only reachable capability is `forget`.
 */
function recordingDimension(name: DimensionName, retired: string[]): Dimension {
  const neverCalledByRetirement = async (): Promise<never> => {
    throw new Error("compile retirement must never call a write phase");
  };
  return {
    name,
    prepare: neverCalledByRetirement,
    commit: neverCalledByRetirement,
    discard: neverCalledByRetirement,
    forget: async (source: string) => {
      retired.push(source);
    },
  };
}

/**
 * A port answering with one recording graph dimension.
 *
 * @param retired - Sink the retired identities are pushed into, in call order.
 * @returns A port typed against the published shape.
 */
export function recordingPort(retired: string[]): DimensionsPort<Dimension> {
  return { resolve: () => [recordingDimension("kg", retired)] };
}
