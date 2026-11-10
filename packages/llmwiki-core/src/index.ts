/**
 * @file packages/llmwiki-core/src/index.ts
 * @description The published root surface of `@atomicstrata/llmwiki-core`.
 *
 * THIS SURFACE IS NOW DELIBERATE. It used to be whatever
 * `packages/wiki/src/core-index.ts` happened to export, because this package's
 * build compiled that file directly as its own entry. A name that left the wiki
 * barrel disappeared from the published package with no edit here, no test and
 * no review, and a name that appeared there was published without anyone
 * choosing it.
 *
 * So every name below is written out, one statement per cluster, each naming the
 * reason the cluster is published at all. That costs maintenance and buys the
 * only thing that matters at a package boundary: REMOVING A NAME FROM THIS FILE
 * IS A BREAKING CHANGE, and adding one is a decision a reviewer can see. Keep
 * the enumeration explicit. A wildcard here would restore the accident this file
 * exists to end, and `test/artifact/facade-surface.test.ts` fails if one appears.
 *
 * Values are re-exported from the wiki barrel by RELATIVE specifier on purpose:
 * `@repo/wiki` is a private workspace package this package does not declare, so
 * a bare specifier would survive into `dist/` in import position and make the
 * shipped bundle import raw TypeScript the consumer does not have.
 */

// The engine-free SDK root: the one factory an embedder calls, and the error
// classes it must be able to catch by name. The execution engine those calls
// reach is deliberately NOT published — a host composes it, it does not own it.
export {
  createWikiCore,
  ProviderUnavailableError,
  UnknownProviderError,
} from "../../wiki/src/core-index.js";

// The shapes that factory and its methods hand back. They are published as
// types because a caller annotating its own boundary needs these names
// resolvable from the package it already depends on.
export type {
  WikiCore,
  CreateWikiOptions,
  SdkCompileOptions,
  IngestResult,
  CompileResult,
  QueryResult,
  AnswerCitation,
  AnswerCitationReport,
  IngestTextInput,
  LintSummary,
  TieredLintReportV1,
  LintTierV1,
  ContextPack,
  EvalReport,
  WikiStatus,
  WriteStatus,
} from "../../wiki/src/core-index.js";

// The read and export vocabulary: pages, sources, the JSON projection and the
// OKF bundle reports. Published because these formats are contracts with
// consumers that are not this process — a host reading the same files must
// describe them in the same words.
export type {
  Page,
  PageRef,
  PageDirectory,
  ListPagesOptions,
  ListPagesResult,
  ListPagesProfileBlock,
  PageRecord,
  SourceRecord,
  ListSourcesOptions,
  ListSourcesResult,
  JsonExportDocument,
  ExportJsonOptions,
  OkfExportReport,
  OkfImportReport,
  OkfImportSkip,
  OkfImportedPage,
} from "../../wiki/src/core-index.js";

// Confinement and lock authority. A host that writes beside the engine must use
// THIS authority rather than a second copy of it: two confinement
// implementations disagree eventually, and the disagreement is a path escaping
// its root. Same for the lock and queue errors, which are only catchable if they
// are the classes the engine actually throws.
export {
  LockUnavailableError,
  confineUnderRoot,
  resolveConfinedPrivateDir,
  releaseLock,
  confinedFetch,
  confinedFetchRequest,
  scaffoldConfinedDirectories,
  ensureConfinedDirectory,
} from "../../wiki/src/core-index.js";

export type {
  FetchLimits,
  ConfinedFetchSeams,
  ConfinedFetchResult,
  ConfinedFetchRequest,
  ConfinedFetchMethod,
  ScaffoldDirectoriesResultV1,
} from "../../wiki/src/core-index.js";

// Trust and review staging: the grant check plus the staged-change and planner
// vocabulary a host needs to say why a mutation was held. Published because
// consumers already import these names to type their own hold reporting.
export { isTrustedWriteGranted } from "../../wiki/src/core-index.js";

export type {
  TrustDecision,
  StagedChange,
  CandidateKind,
  HeldReasonCode,
  WorkflowRunRef,
  StagedRelationRef,
  StagedArtifactRef,
  EntityRef,
  RawPageRef,
  MutationTarget,
  MutationOperation,
  MutationKind,
  PlannedMutation,
  MutationProvenance,
} from "../../wiki/src/core-index.js";

// Profiles: which profile block is active, how its identity rules are applied,
// and the confinement-capped read a domain caller performs against it. The
// digest and the slug-safety check are the same rules the engine validates page
// paths with, so a host validating before it writes agrees with the write.
export {
  activeProfileDigest,
  readConfinedCappedBuffer,
  loadNonDefaultProfile,
  loadProfile,
  isSlugSafe,
} from "../../wiki/src/core-index.js";

export type {
  ConfinedCappedRead,
  ProfilePack,
  EntityId,
  EntityPageRef,
  EntityPageView,
  EntityProblemView,
  LoadedProfile,
  SlugSafe,
} from "../../wiki/src/core-index.js";

// Markdown interop. Frontmatter parsing and slug derivation are the wiki's own
// definition of its file format; a host that edits the same files has to derive
// the same slug from the same title, not a compatible-looking one of its own.
export { parseFrontmatter, slugify } from "../../wiki/src/core-index.js";

// The viewer, so a host can mount the same pages the CLI serves instead of
// building a second rendering path over the same directory.
export { startViewer, collectViewerPages, resolveBareSlug } from "../../wiki/src/core-index.js";

export type { StartViewerOptions } from "../../wiki/src/core-index.js";

// Durable writes. Published with their collision errors because the guarantee
// is only usable if a failed write is catchable as the specific failure it was:
// a host that cannot distinguish a collision from a cleanup fault has to treat
// both as unknown, which means re-reading state the API already knows.
export {
  atomicWrite,
  AtomicWriteCollisionError,
  AtomicWriteCommittedCleanupError,
} from "../../wiki/src/core-index.js";

export type {
  AtomicWriteOptions,
  AtomicWriteNoReplaceDurableOptions,
} from "../../wiki/src/core-index.js";
