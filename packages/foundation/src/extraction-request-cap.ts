/**
 * @file packages/foundation/src/extraction-request-cap.ts
 * @description The spend cap that bounds one extraction job's chat requests.
 *
 * ## Why this exists
 *
 * Extraction is one chat request per chunk, sequential, with no budget and no per-run
 * limit: a document that chunks into two hundred pieces costs two hundred completions
 * before anyone can see the bill. The cap is the bound that turns "this run will cost
 * whatever the document is worth" into a number an operator declared.
 *
 * ## Why it REFUSES instead of truncating
 *
 * The cheap way to honour a cap is to extract the first N chunks and report success. That
 * produces a graph built from part of a document while reading exactly like a graph built
 * from all of it — the silent partial result this repository keeps finding. So a breach
 * throws instead: no chunk is dropped, no subset is extracted, and the message names the
 * variable, the configured cap and the actual count, which is the distance an operator
 * needs to decide what to raise it to.
 *
 * ## Resolution chain
 *
 * 1. `LLMWIKI_KG_MAX_EXTRACTION_REQUESTS` — the operator's value, when it is a positive
 *    whole number.
 * 2. {@link KG_EXTRACTION_REQUEST_CAP_DEFAULT} — the documented default, when the
 *    variable is unset or empty.
 *
 * Empty means UNSET, and nothing here means "unlimited": a cap that can be switched off
 * by an empty line is the unbounded spend this file exists to remove. Non-numeric, zero
 * and negative values are configuration errors and are REPORTED by name rather than
 * quietly replaced, because each is a typo an operator wants told about — a zero would
 * refuse every document, and a negative is not a bound at all.
 *
 * The parser follows the shape of `readTimeoutEnv` (`packages/wiki/src/providers/openai.ts`)
 * — one variable, one named default, one documented chain — with the one deliberate
 * difference this setting requires: a timeout guessed wrong costs a slow run, while a
 * spend bound guessed wrong spends money, so the value is refused instead of ignored.
 *
 * ## Why this module imports NOTHING
 *
 * The configuration error is raised by the caller, not here, because `ConfigValidationError`
 * lives in the KG core and this package is the bottom of the topology: `@repo/foundation`
 * may import neither `@repo/wiki` nor `@repo/kg` (nor `@repo/api`), so the class could not
 * be named here even if this module wanted to. That makes the reason stronger than it was
 * while the file sat inside the wiki dimension, and it is a different reason: there the
 * constraint was a boundary allowance that had to be spent in exactly one place, and here
 * there is no allowance at all. So the caller throws the class (the same way `prepare`
 * raises every other resolver's `problem`) and this module stays a pure,
 * dependency-free decision about a number.
 */

/**
 * Names the maximum number of chat requests one extraction job may send.
 *
 * Follows the repository's `LLMWIKI_` convention for a wiki-side setting that configures
 * how much work a run performs, and is scoped with `KG_` because it bounds the graph
 * dimension's extraction and nothing else.
 */
export const KG_EXTRACTION_REQUEST_CAP_ENV_VAR = "LLMWIKI_KG_MAX_EXTRACTION_REQUESTS";

/**
 * Default bound on chat requests per extraction job: one thousand.
 *
 * The ingestion path truncates a document at `MAX_EXTRACTION_CHARS` (500,000 characters),
 * and the chunker's 1024-token budget with 200 tokens of overlap carries roughly 700
 * characters of new content per chunk, so no document the pipeline accepts can exceed
 * about 715 chunks. A thousand is therefore above every document this code will ever
 * extract and still a bound: a document that somehow produced more is exactly the run
 * that must be refused rather than paid for.
 */
export const KG_EXTRACTION_REQUEST_CAP_DEFAULT = 1000;

/**
 * What resolving the cap produced: the bound to apply, or the reason none can be.
 *
 * Modelled on the backend resolutions the dimension already uses — a value or a
 * `problem` — so the caller raises the configuration error in one place, with the class
 * the boundary rule already sanctions there.
 */
export type ExtractionRequestCapResolution =
  | { readonly kind: "capped"; readonly cap: number }
  | { readonly kind: "invalid"; readonly problem: string };

/**
 * A run whose chunk count exceeds the configured cap.
 *
 * Typed rather than a bare `Error` so a caller can distinguish "this run was refused for
 * cost" from "extraction failed", which are different remedies: the first is a decision
 * about the cap, the second is a decision about the provider.
 */
export class ExtractionRequestCapError extends Error {
  /**
   * @param message - Refusal text naming the variable, the cap and the actual count.
   */
  constructor(message: string) {
    super(message);
    this.name = "ExtractionRequestCapError";
  }
}

/**
 * Resolve the chat-request cap this run must honour.
 *
 * @param env - Environment to read; defaults to the process environment.
 * @returns The configured cap or {@link KG_EXTRACTION_REQUEST_CAP_DEFAULT}, or the
 *   configuration error to raise — never a silent substitute for a broken value.
 */
export function resolveExtractionRequestCap(
  env: NodeJS.ProcessEnv = process.env,
): ExtractionRequestCapResolution {
  const raw = env[KG_EXTRACTION_REQUEST_CAP_ENV_VAR]?.trim();
  // Empty is unset, never unlimited: a declared-but-blank line is how a `.env` leaves a
  // setting alone, and reading it as "no bound" would restore the unbounded spend.
  if (raw === undefined || raw === "") {
    return { kind: "capped", cap: KG_EXTRACTION_REQUEST_CAP_DEFAULT };
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return {
      kind: "invalid",
      problem:
        `${KG_EXTRACTION_REQUEST_CAP_ENV_VAR}="${raw}" is not a positive whole number. ` +
        `Set it to the most chat requests one extraction may send ` +
        `(default ${String(KG_EXTRACTION_REQUEST_CAP_DEFAULT)}), or unset it.`,
    };
  }
  return { kind: "capped", cap: parsed };
}

/**
 * Refuse a run whose chunk count would exceed the cap, before any request is sent.
 *
 * Called with the chunk count the chunker is ABOUT to produce, so the refusal costs
 * nothing: no embedding batch has been paid for and no completion has been requested.
 *
 * @param chunkCount - Chunks the extraction would send one chat request for each.
 * @param cap - The resolved cap this run must stay within.
 * @throws {ExtractionRequestCapError} When `chunkCount` exceeds `cap`. Never truncates:
 *   the chunk list the caller holds is untouched and no subset is extracted.
 */
export function assertWithinExtractionRequestCap(chunkCount: number, cap: number): void {
  if (chunkCount <= cap) return;
  throw new ExtractionRequestCapError(
    `${KG_EXTRACTION_REQUEST_CAP_ENV_VAR} is set to ${String(cap)}: this document yields ` +
      `${String(chunkCount)} chunks, and extraction sends one chat request per chunk. ` +
      `Nothing was sent and no chunk was skipped — raise the cap or ingest a smaller document.`,
  );
}
