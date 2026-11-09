/**
 * @file test/dimensions/kg-core-mock.ts
 * @description The vendored-core exports a kg dimension's `prepare` needs, taken
 * from the REAL barrel so a suite that replaces the provider layer still
 * exercises the shipped credential, width and backend rules.
 *
 * Shared rather than restated per suite: four copies of this block would let one
 * suite silently drift to a stub of a rule another suite verifies. Every value
 * below is fake — `test-key-not-real`, an unreachable database URL — because no
 * provider or database is reached by these suites.
 *
 * Not a test file: it declares no cases and is imported by the suites that mock
 * `llmwiki-kg`.
 */

import type * as Core from "@repo/kg/core-index";

/** The barrel shape a `vi.mock("@repo/kg")` factory receives. */
type CoreModule = typeof Core;

/**
 * Barrel members `prepare` reads, forwarded from the real module.
 *
 * @param core - The real barrel, imported by the caller's mock factory.
 * @param databaseUrl - The vendored config's database URL for this suite.
 * @returns An object spreadable into the mock's return value.
 */
export function prepareCoreExports(core: CoreModule, databaseUrl: string) {
  return {
    kgConfig: {
      DATABASE_URL: databaseUrl,
      // A usable embedding credential: these suites exercise wiring, not the
      // fail-closed door `prepare` opens with first.
      EMBEDDING_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key-not-real",
      GATEWAY_URL: "",
      GATEWAY_API_KEY: "",
    } as const,
    readStackOntology: core.readStackOntology,
    defaultOntology: core.defaultOntology,
    // The credential and width doors are the SHIPPED ones: a suite that replaces
    // the provider layer must not also replace the rules that refuse a
    // configuration, or it would prove its own stub.
    findEmbeddingCredentialProblem: core.findEmbeddingCredentialProblem,
    findEmbeddingModelProblem: core.findEmbeddingModelProblem,
    ConfigValidationError: core.ConfigValidationError,
    // The injected-backend seam, straight through: these suites state their
    // provider wiring explicitly instead of resolving one.
    configuresOwnEmbeddingBackend: core.configuresOwnEmbeddingBackend,
    prepareEmbeddingBackend: core.prepareEmbeddingBackend,
    withEmbeddingBackend: core.withEmbeddingBackend,
    // The same seam on the EXTRACTION side. Its canonical lookups read
    // `EXTRACTION_PROVIDER` from the config above (absent here), so these
    // wiring suites are refused by nothing: the door exists but stays open.
    configuresOwnChatBackend: core.configuresOwnChatBackend,
    findExtractionCredentialProblem: core.findExtractionCredentialProblem,
    prepareChatBackend: core.prepareChatBackend,
    withChatBackend: core.withChatBackend,
  };
}
