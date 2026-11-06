/**
 * @file packages/llmwiki-kg/ts/src/core/jev/index.ts
 * @description Public surface of the JEV adapter.
 *
 * The directory is one substitutable unit: the wire types and verdicts
 * (`types.ts`), the parsed configuration (`config.ts`), the payload validator
 * (`payload.ts`), the request builders (`questions.ts`), the HTTP adapter and the
 * outcome boundary (`client.ts`), the interpretation rules (`interpret.ts`), and
 * the scripted double (`doubles.ts`).
 *
 * The double travels with the surface because S46 makes "automated tests use a
 * double" part of the contract rather than a private test helper: a consumer that
 * wires this adapter into its own suite needs the same double, and the alternative
 * is every consumer hand-rolling one and drifting from the documented wire shape.
 *
 * Nothing here touches the database, the pipeline or the catalog. The adapter
 * reads configuration, asks a client one question set, and returns a verdict; the
 * caller decides what to persist.
 */

export * from "./types.js";
export * from "./config.js";
export * from "./payload.js";
export * from "./questions.js";
export * from "./client.js";
export * from "./interpret.js";
export * from "./doubles.js";
