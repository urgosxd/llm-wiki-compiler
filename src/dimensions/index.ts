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

export { createWikiDimension } from "./wiki.js";
export { createKgDimension } from "./kg.js";
export type { KgDimensionOptions } from "./kg.js";

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
