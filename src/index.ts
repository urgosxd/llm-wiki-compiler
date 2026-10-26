/**
 * @file src/index.ts
 * @description Public SDK surface for llm-wiki-compiler.
 *
 * Re-exports consumer-facing types, errors, and opt-in integration surfaces.
 * Experimental APIs retain their individual stability annotations. Commander
 * setup and prompts remain CLI internals; the viewer has an explicit embedding
 * entry point. Product instances and external workflow engines are not bundled.
 *
 * Consumers can import types and errors directly:
 *   import type { Page, PageRef } from "llm-wiki-compiler";
 *   import { ProviderUnavailableError } from "llm-wiki-compiler";
 */







export { createWiki } from "./sdk/wiki.js";





export type { Wiki } from "./sdk/types.js";


// Result/input types for the Wiki facade methods, re-exported so typed
// consumers don't have to deep-import from internal module paths.










// WriteStatus is part of IngestResult — re-exported so callers needn't deep-import utils/types.


// OKF export/import — report types and typed errors for SDK consumers.




// @experimental — artifact write/verify. `createWiki()` exposes `writeArtifact`/
// `verifyArtifact`; `SdkWriteArtifactInput` is the input `writeArtifact` takes,
// `ArtifactRef`/`ArtifactHealth` are the ref/health types both methods return,
// and `ArtifactVerifyUnavailableError` is the typed, catchable refusal
// `verifyArtifact` throws when no active profile declares artifact types.








// @experimental — programmatic non-default entity-page staging loop. The
// `createWiki()` facade exposes `stageEntityPage`/`promoteStagedPage`; these are
// the input/return types consumers need. The lower-level `stageEntityPage(root,…)`
// and `promoteCandidateUnderLock` forms stay internal. API may change.
//
// Read-integration status: typed entity pages are surfaced in `status`, the JSON
// export, the wiki INDEX, the viewer graph, agent context packs (lexical ranking
// + relation-edge expansion), and semantic search (under their qualified EntityId).


// The staged-change RELATION/ARTIFACT targets are Phase-4 STUB shapes named
// `Staged…` so the canonical relation `RelationRef` (from `relations/types.ts`,
// below) owns the unprefixed name.


// @experimental — trust-gated relation writes + lifecycle transitions
// (planner-routed, shared SDK/CLI). `createWiki().createRelation` /
// `.transitionLifecycle` expose these; these are the input/return + typed-error
// types consumers need.







// Planner sub-types named by `StagedChange.target` / `.planned` so the staged
// surface is fully nameable by consumers (the typed `EntityRef` target especially).



// Experimental read-only domain contract. The unrestricted loader stays internal;
// the non-default projection preserves the existing compiler profile validation.



// Profile pack types for callers interpreting the read-only projection.


// Experimental integration contracts retained from the internal implementation.








































































