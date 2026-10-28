/**
 * @file src/index.ts
 * @description Public SDK surface for llm-wiki-compiler.
 *
 * Re-exports the consumer-facing facade, its types, and the read-only domain
 * contract an external coordinator uses to observe a project without mutation
 * authority.
 *
 * ## What left this file, and why it is not a loss
 *
 * It previously re-exported type and error shapes for the preparation, product,
 * operation-bundle and workflow slices. Those subsystems are gone, so their
 * types describe nothing a caller can construct. The read-only domain contract
 * below SURVIVES because it reads profile state the wiki still owns -- the
 * active profile and its digest -- and is the only way a coordinator can observe
 * a project without holding the lock.
 *
 * Consumers can import directly:
 *   import { createWiki } from "llm-wiki-compiler";
 *   import type { Wiki } from "llm-wiki-compiler";
 */

export { createWiki } from "./sdk/wiki.js";
export type { Wiki } from "./sdk/types.js";

/**
 * Read-only domain contract.
 *
 * `activeProfileDigest`, `loadNonDefaultProfile` and `readConfinedCappedBuffer` are
 * deliberately public: a coordinator confirms which profile a project is running and
 * reads a bounded, confined buffer WITHOUT acquiring mutation authority or the lock.
 * They are the observation half of the same profile the loader uses, which is why
 * they outlive the subsystems that once consumed them.
 */
export { ArtifactVerifyUnavailableError } from "./artifacts/resolve.js";
export { activeProfileDigest } from "./profile/load.js";
export { loadNonDefaultProfile } from "./profile/block.js";
export {
  readConfinedCappedBuffer,
  type ConfinedCappedRead,
} from "./sdk/domain-read.js";

/** Typed refusal surfaces a facade caller is expected to catch. */
export {
  ProviderUnavailableError,
  UnknownProviderError,
} from "./utils/provider-guard.js";
