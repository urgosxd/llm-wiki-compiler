/**
 * @file packages/llmwiki-kg/ts/src/core/jev/config.ts
 * @description The single parsed JEV configuration: endpoint, model, timeout and
 * the four confidence thresholds this application owns.
 *
 * ## The thresholds are starting points, not calibrated values
 *
 * **These defaults are corpus-dependent and MUST be tuned against evaluations of
 * the corpus at hand** (S24). They exist so a first run is possible without
 * configuration, not because any of them is correct for a given document set:
 * abstention rates move with the catalog's breadth, with how the extractor phrases
 * candidates, and with the domain. A Stack whose documents use near-synonyms will
 * spend most of its mass inside the uncertain band with these values, and one with
 * a tight catalog will rarely enter it. Re-tune after changing the catalog version,
 * the extractor prompt or the Jev model, then re-read the classification log.
 *
 * What the four numbers mean, in the terms of the decisions they gate:
 *
 * | Setting | Question it thresholds |
 * | --- | --- |
 * | `classificationNoMatchBelow` | P(some catalog type fits). Below it, `NO_MATCH`. |
 * | `classificationUncertainBelow` | P(some catalog type fits). Between the two, ambiguous → `UNCERTAIN`. |
 * | `classificationMinTopProbability` | P(the argmax type). Below it, no dominant type → `UNCERTAIN`. |
 * | `supportUncertainBelow` | P(the top support answer). Below it, `UNCERTAIN`. |
 *
 * The vendor's `confidence` is deliberately NOT a gate: it is a derived dispersion
 * measure, not a probability that the answer is right, so using it to decide
 * whether to trust an answer would be reading it as something it is not (S22, S23).
 *
 * ## Why a bad override is fatal
 *
 * Every override is validated and a bad one raises. Silently falling back to a
 * default would move an entire corpus's abstention rate with nothing in the log to
 * explain it, and a no-match band that is not below the uncertain band leaves an
 * empty uncertainty band, which reads as "this classifier never hesitates" — the
 * one interpretation nobody should be able to get by accident.
 */

/** Documented default base URL of the System One API. */
export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";

/** Documented default model id. */
export const DEFAULT_JEV_MODEL = "jev-latest";

/** Default per-request timeout. A decision should be quick or it is an outage. */
export const DEFAULT_JEV_TIMEOUT_MS = 30_000;

/**
 * The configurable confidence bands.
 *
 * See the file header: the defaults are corpus-dependent starting points that must
 * be tuned against evaluations, never calibrated constants.
 */
export interface JevThresholds {
  /** P(a catalog type fits) below which the candidate is judged outside the catalog. */
  readonly classificationNoMatchBelow: number;
  /** P(a catalog type fits) below which the fit itself is still ambiguous. */
  readonly classificationUncertainBelow: number;
  /** P(the argmax catalog type) below which no type dominates the distribution. */
  readonly classificationMinTopProbability: number;
  /** P(the top semantic-support answer) below which support is undecided. */
  readonly supportUncertainBelow: number;
}

/**
 * The shipped defaults, documented as tunable starting points.
 *
 * Read the file header before changing them: raising `classificationNoMatchBelow`
 * shrinks the free-by-absence population and pushes borderline candidates into
 * `free_uncertain`; lowering `classificationUncertainBelow` does the reverse.
 */
export const DEFAULT_JEV_THRESHOLDS: JevThresholds = Object.freeze({
  classificationNoMatchBelow: 0.35,
  classificationUncertainBelow: 0.65,
  classificationMinTopProbability: 0.45,
  supportUncertainBelow: 0.6,
});

/** Everything the adapter reads from configuration. */
export interface JevConfig {
  /** System One base URL; `/v1/systemone` is appended by the client. */
  readonly baseUrl: string;
  /** Model id sent in every request body. */
  readonly model: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** The confidence bands, all four of them. */
  readonly thresholds: JevThresholds;
}

/** An environment-shaped object; only string values are read. */
export type JevEnv = Readonly<Record<string, string | undefined>>;

/** Raised when the configuration cannot be parsed or is internally inconsistent. */
export class JevConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevConfigError";
  }
}

/**
 * Reads a string setting, treating blank as absent.
 *
 * @param env - The environment to read.
 * @param name - The variable name, used in errors.
 * @param fallback - The value to use when the variable is absent or blank.
 * @returns The trimmed configured value.
 */
function readString(env: JevEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? fallback : raw;
}

/**
 * Reads a threshold that must be a probability strictly between 0 and 1.
 *
 * @param env - The environment to read.
 * @param name - The variable name, used in errors.
 * @param fallback - The value to use when the variable is absent or blank.
 * @returns The configured probability.
 * @throws {JevConfigError} When the value is not a number in the open interval (0, 1).
 */
function readProbability(env: JevEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new JevConfigError(`${name} must be a probability strictly between 0 and 1, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Reads a timeout or similar positive integer.
 *
 * @param env - The environment to read.
 * @param name - The variable name, used in errors.
 * @param fallback - The value to use when the variable is absent or blank.
 * @returns The configured positive integer.
 * @throws {JevConfigError} When the value is not a positive integer.
 */
function readPositiveInt(env: JevEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new JevConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Parses the four thresholds and checks that the bands can actually be entered.
 *
 * @param env - The environment to read.
 * @returns The validated thresholds.
 * @throws {JevConfigError} When the no-match band is not below the uncertain band.
 */
function readThresholds(env: JevEnv): JevThresholds {
  const noMatchBelow = readProbability(
    env,
    "LLMWIKI_JEV_CLASSIFICATION_NO_MATCH_BELOW",
    DEFAULT_JEV_THRESHOLDS.classificationNoMatchBelow,
  );
  const uncertainBelow = readProbability(
    env,
    "LLMWIKI_JEV_CLASSIFICATION_UNCERTAIN_BELOW",
    DEFAULT_JEV_THRESHOLDS.classificationUncertainBelow,
  );
  if (noMatchBelow >= uncertainBelow) {
    throw new JevConfigError(
      `the no-match band (${String(noMatchBelow)}) must be below the uncertain band (${String(uncertainBelow)}); ` +
        "otherwise the uncertainty band is empty and the classifier can never abstain as uncertain",
    );
  }
  return Object.freeze({
    classificationNoMatchBelow: noMatchBelow,
    classificationUncertainBelow: uncertainBelow,
    classificationMinTopProbability: readProbability(
      env,
      "LLMWIKI_JEV_CLASSIFICATION_MIN_TOP_PROBABILITY",
      DEFAULT_JEV_THRESHOLDS.classificationMinTopProbability,
    ),
    supportUncertainBelow: readProbability(
      env,
      "LLMWIKI_JEV_SUPPORT_UNCERTAIN_BELOW",
      DEFAULT_JEV_THRESHOLDS.supportUncertainBelow,
    ),
  });
}

/**
 * Parses one complete, validated JEV configuration.
 *
 * @param env - The environment to read; defaults to `process.env`.
 * @returns A frozen configuration with every threshold resolved.
 * @throws {JevConfigError} On an unparseable or inconsistent value.
 */
export function parseJevConfig(env: JevEnv = process.env): JevConfig {
  return Object.freeze({
    baseUrl: readString(env, "LLMWIKI_JEV_BASE_URL", DEFAULT_JEV_BASE_URL),
    model: readString(env, "LLMWIKI_JEV_MODEL", DEFAULT_JEV_MODEL),
    timeoutMs: readPositiveInt(env, "LLMWIKI_JEV_TIMEOUT_MS", DEFAULT_JEV_TIMEOUT_MS),
    thresholds: readThresholds(env),
  });
}

/** The process-wide configuration, parsed once so every stage sees the same numbers. */
let cachedConfig: JevConfig | undefined;

/**
 * The configuration for this process.
 *
 * Parsed once: a threshold that changed between two candidates of the same run
 * would make the run's own classification log unreproducible.
 *
 * @returns The process-wide configuration.
 * @throws {JevConfigError} On an unparseable or inconsistent value.
 */
export function jevConfig(): JevConfig {
  cachedConfig ??= parseJevConfig(process.env);
  return cachedConfig;
}
