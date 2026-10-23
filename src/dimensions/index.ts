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

export { createWikiDimension } from "./wiki/index.js";
export { createWikiReader } from "./wiki/reader.js";
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
  resolveDimensions,
} from "./activation.js";
export type { ResolveDimensionsOptions } from "./activation.js";
