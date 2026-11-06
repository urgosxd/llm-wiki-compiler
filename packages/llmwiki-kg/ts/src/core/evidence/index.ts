/**
 * @file packages/llmwiki-kg/ts/src/core/evidence/index.ts
 * @description Public surface of the evidence stage.
 *
 * The stage is pure: it takes a quote, the chunk content it came from, and the
 * caller's provenance fields, and returns either a verifiable span in that
 * content or an honest `not_found`. It reads no database, calls no model, and
 * keeps no state, which is what lets the wiring task hand it candidates and lets
 * its tests drive the same functions a caller does.
 *
 * `prompt-data.ts` travels with it because the "document content is data" rule
 * (S13) must have exactly one implementation, and every model call that quotes a
 * source is downstream of this stage.
 */

export * from "./types.js";
export * from "./normalize.js";
export * from "./locate.js";
export * from "./assessment.js";
export * from "./provenance.js";
export * from "./prompt-data.js";
