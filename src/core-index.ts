/**
 * Engine-free knowledge SDK and existing domain integration exports.
 * Core retains authenticated local history without exporting its execution
 * engine. The standard compiler separately composes the legacy workflow API.
 */
export { createWikiCore } from "./sdk/core.js";
export type { WikiCore } from "./sdk/core-types.js";
export type {
  Page,
  PageRef,
  PageDirectory,
  ListPagesOptions,
  ListPagesResult,
  ListPagesProfileBlock,
} from "./pages/list.js";
export type {
  JsonExportDocument,
  ExportJsonOptions,
  JsonExportProfileBlock,
} from "./export/json-export.js";
export {
  ProviderUnavailableError,
  UnknownProviderError,
} from "./utils/provider-guard.js";
export { startViewer, type StartViewerOptions } from "./viewer/server.js";

export type { CreateWikiOptions, SdkCompileOptions } from "./sdk/core-types.js";
export type { IngestResult, CompileResult, QueryResult } from "./utils/types.js";
export type { AnswerCitation, AnswerCitationReport } from "./citations/answer-types.js";
export type { IngestTextInput } from "./commands/ingest.js";
export type { LintSummary } from "./linter/types.js";
export type { TieredLintReportV1, LintTierV1 } from "./linter/tiers.js";
export type { ContextPack } from "./context/types.js";
export type { EvalReport } from "./eval/types.js";
export type { WikiStatus } from "./status/collect.js";
export type { PageRecord } from "./pages/read.js";
export type { SourceRecord, ListSourcesOptions, ListSourcesResult } from "./sources/store.js";
export type { WriteStatus } from "./utils/types.js";
export type { OkfExportReport } from "./export/okf/run.js";
export type { OkfImportReport, OkfImportSkip, OkfImportedPage } from "./import/run.js";
export { LockUnavailableError, QueueFullError } from "./import/run-errors.js";

export type {
  StagedChange,
  CandidateKind,
  HeldReasonCode,
  WorkflowRunRef,
  StagedRelationRef,
  StagedArtifactRef,
} from "./trust/staged-change.js";



export type {
  EntityRef,
  RawPageRef,
  MutationTarget,
  MutationOperation,
  MutationKind,
  PlannedMutation,
  MutationProvenance,
} from "./trust/planner.js";
export type { TrustDecision } from "./trust/decision.js";
export { activeProfileDigest, readConfinedCappedBuffer } from "./sdk/domain-read.js";
export type { ConfinedCappedRead } from "./sdk/domain-read.js";
export { loadNonDefaultProfile } from "./profile/block.js";
export type {
  ProfilePack,
  EntityId,
  EntityPageRef,
  EntityPageView,
  EntityProblemView,
  LoadedProfile,
  SlugSafe,
} from "./profile/types.js";
export { parseFrontmatter, slugify } from "./utils/markdown.js";
export { collectViewerPages, resolveBareSlug } from "./viewer/collect.js";
export { isTrustedWriteGranted } from "./trust/trusted-write.js";
export { atomicWrite, AtomicWriteCollisionError, AtomicWriteCommittedCleanupError, type AtomicWriteOptions, type AtomicWriteNoReplaceDurableOptions } from "./utils/atomic-write.js";


export { loadProfile } from "./profile/load.js";
export { isSlugSafe } from "./profile/identity.js";
export { confineUnderRoot } from "./utils/path-confine.js";
export { resolveConfinedPrivateDir } from "./utils/private-dir.js";
export { releaseLock } from "./utils/lock.js";

export { confinedFetch, confinedFetchRequest } from "./connectors/confined-fetch.js";
export type { FetchLimits, ConfinedFetchSeams, ConfinedFetchResult, ConfinedFetchRequest, ConfinedFetchMethod } from "./connectors/confined-fetch.js";
export { scaffoldConfinedDirectories, ensureConfinedDirectory, type ScaffoldDirectoriesResultV1 } from "./utils/confined-scaffold.js";
