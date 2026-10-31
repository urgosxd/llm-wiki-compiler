/**
 * @file test/dimensions/kg-runtime-provider-env.ts
 * @description Points the vendored provider layer at a fake gateway for the
 * `kg-runtime-*` suites that drive the dimension with the network stubbed.
 *
 * ## Why a module instead of a `vi.hoisted` block in each suite
 *
 * The vendored `config` module parses `process.env` ONCE, at import time, so the
 * variables must be in place before anything imports it. `vi.hoisted` runs early
 * enough, but it forces the block to be copy-pasted into every suite that needs
 * it, duplicating a non-obvious and load-bearing detail: one wrong variable name
 * silently makes the suite reach a real provider.
 *
 * Setting them at the TOP of a module and importing that module FIRST is
 * equivalent, and MEASURED to be: with this imported above the core, the core
 * observes `EXTRACTION_MODEL` from here. The ordering is a property of ESM
 * evaluation of the import graph, not a hope about hoisting.
 *
 * ## Why the values are fake but the provider names are real
 *
 * `gateway` is a real provider name, so the code takes its normal
 * OpenAI-compatible path instead of a test-only branch. The URL is `.invalid`, so
 * a suite that forgot to install the fetch stub fails on a name that cannot
 * resolve rather than by reaching somebody's gateway. No credential here is real.
 */

process.env["EXTRACTION_PROVIDER"] = "gateway";
process.env["EMBEDDING_PROVIDER"] = "gateway";
process.env["GATEWAY_URL"] = "https://gateway.invalid/v1";
process.env["GATEWAY_API_KEY"] = "test-key-not-a-credential";
process.env["EMBEDDING_MODEL"] = "hf:nomic-ai/nomic-embed-text-v1.5";
process.env["EMBEDDING_DIM"] = "768";
process.env["EXTRACTION_MODEL"] = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";

// No exports on purpose: this module is imported ONLY for that side effect, so
// anything exported here would be dead code the analyzer is right to flag.
export {};
