/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/wiring.ts
 * @description The one wiring defect the ingest paths refuse instead of tolerating:
 * a classifier with no bounded transaction runner.
 *
 * ## Why it is its own module
 *
 * Two routers need to refuse the same misconfiguration — the ingest endpoint, whose
 * pipeline would hold its request transaction open across every classifier call, and
 * the reclassification endpoint, which has no other transaction to open at all. The
 * message and the error type therefore live here, so both name the defect identically
 * and neither router has to import the other (which would close an import cycle).
 *
 * ## Why refusing beats degrading
 *
 * A request-scoped wrapper is fine for a pipeline with no external decision call in the
 * middle. Once a classifier is enabled it is not: the transaction would sit open for the
 * whole handler while the response told nobody, which is exactly what S44 forbids. So
 * the combination fails loudly with a message that names the fix.
 */

/** Message of the refusal a misconfigured wiring gets, spelled once. */
export const MISSING_RUNNER_MESSAGE =
  "ingest classification requires a bounded transaction runner: pass `run: " +
  "createTransactionRunner(database)` over your pool, or disable classification. " +
  "Refusing to keep a database transaction open across classifier calls (S44).";

/** Raised when a wiring would violate the bounded-transaction contract. */
export class IngestWiringError extends Error {
  constructor(message: string = MISSING_RUNNER_MESSAGE) {
    super(message);
    this.name = "IngestWiringError";
  }
}
