/**
 * @file src/dimensions/index.ts
 * @description Public surface of the dimension layer: the port, the two
 * implementations, the transactional coordinator, and the outbox reconciler.
 *
 * Consumers outside this directory should import from here rather than
 * reaching into individual modules, so the internal file layout stays free to
 * change.
 */

export type {
  CommittedWrite,
  Dimension,
  DimensionInput,
  DimensionName,
  PreparedWrite,
} from "./types.js";

export { DIMENSION_PORT_VERSION } from "./types.js";

export { DIMENSION_READ_PORT_VERSION } from "./read-types.js";
export type {
  DimensionAnswer,
  DimensionQuery,
  DimensionReader,
  GraphReadFailure,
  GraphReadFailureCode,
  GraphReadResult,
  ReadChunk,
  ReadEntity,
  ReadRelationship,
} from "./read-types.js";

/*
 * The database-backed wiki factories are deliberately NOT re-exported here.
 *
 * `wiki/database.ts` pulls in `page-store.ts`, which imports `sql` from
 * `drizzle-orm` as a VALUE. `drizzle-orm` is declared in
 * `packages/llmwiki-kg/ts/package.json` and is absent from the root manifest, so
 * exporting the pair from this barrel would load the query builder for every
 * caller that only wanted `resolveDimensions` -- which includes `compile` and
 * `ingest`, the two hottest CLI paths. `test/dimensions/wiki-database-entry.test.ts`
 * pins that this stays true.
 *
 * Activation reaches the factories through `./wiki/database.js` directly, which
 * keeps the cost where the choice is actually made.
 */
export { createKgDimension } from "./kg/index.js";
export type { KgDimensionOptions } from "./kg/index.js";
export { createKgReader } from "./kg/reader.js";
export type { KgReaderOptions } from "./kg/reader.js";

export { ingestDimensions } from "./coordinator.js";
export type { IngestOutcome } from "./coordinator.js";

export { reconcileOutbox } from "./reconcile.js";
export type { ReconcileOutcome, UnresolvedIngest } from "./reconcile.js";

export { loadRecords, mintIngestId, removeRecord, saveRecord } from "./outbox.js";
export type { OutboxDimensionEntry, OutboxRecord, OutboxStatus } from "./outbox.js";

export {
  AKS_STACK_ID_ENV_VAR,
  DIMENSIONS_ENV_VAR,
  DimensionActivationError,
  createDimensionsDatabase,
  resolveDimensions,
  resolveStackId,
} from "./activation.js";
export type { DimensionsDatabase, ResolveDimensionsOptions } from "./activation.js";
