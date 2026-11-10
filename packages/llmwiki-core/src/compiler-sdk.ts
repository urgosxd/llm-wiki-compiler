/**
 * @file packages/llmwiki-core/src/compiler-sdk.ts
 * @description The published `@atomicstrata/llmwiki-core/compiler-sdk` subpath:
 * the version-locked composition support the standard compiler is built on.
 *
 * Two values, named, and nothing else. This subpath is what
 * `packages/wiki/src/sdk/wiki.ts` imports to construct the compiler's core, and
 * `test/artifact/facade-surface.test.ts` pins its runtime surface by EXACT
 * equality, so a helper added here is a published API decision rather than an
 * implementation detail.
 *
 * ## Why the values come from the wiki composition module
 *
 * Quiet output must use CORE's `AsyncLocalStorage` instance, not a bundled copy.
 * Re-implementing either function here — or importing the storage from anywhere
 * but the composition module — would give the facade a second storage object,
 * and a `withQuiet` entered through a host would then be invisible to the engine
 * doing the writing: the output it was asked to silence would print anyway. The
 * values are therefore re-exported from the module that already pairs them, not
 * rebuilt.
 *
 * ## Why the types are enumerated
 *
 * This subpath used to publish its type surface as `export type * from
 * "./core-types.js"` — a wildcard, so every type that file declared (and every
 * type it grows later) was published without anyone choosing it. The five names
 * below are the same surface, written out, which is the whole point of S1: the
 * published surface is a decision, and the pinning test forbids a wildcard here.
 */

export { createWikiCoreAtRoot, withQuiet } from "../../wiki/src/sdk/compiler-composition.js";

export type {
  SdkCompileOptions,
  CreateWikiOptions,
  DimensionsRequest,
  DimensionsPort,
  WikiCore,
} from "../../wiki/src/sdk/core-types.js";
