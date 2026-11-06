/**
 * @file packages/llmwiki-kg/ts/src/core/candidates/index.ts
 * @description Public surface of the open candidate stage.
 *
 * Three pure modules, one entry point: the candidate model (`types.ts`), the parser
 * that reads a model answer into it (`parse.ts`), the contract that answer is asked
 * with (`contract.ts`), and the bounded budget that admits candidates into a run
 * (`budget.ts`). Nothing here reads a database, calls a provider, or writes a row,
 * which is what lets the wiring task drive the same functions its tests do.
 */

export * from "./types.js";
export * from "./parse.js";
export * from "./contract.js";
export {
  CandidateBudgetError,
  DEFAULT_CANDIDATE_BUDGET,
  candidateDedupKey,
  createCandidateLedger,
  mergeCandidateAccounting,
} from "./budget.js";
export type {
  AdmittedCandidates,
  CandidateAccounting,
  CandidateBudgetConfig,
  CandidateBudgetLedger,
  CandidateTruncation,
  ChunkCandidateAccounting,
} from "./budget.js";
