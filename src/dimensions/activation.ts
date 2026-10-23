/**
 * @file src/dimensions/activation.ts
 * @description Reads the environment switch that decides which dimensions an
 * ingest writes to.
 *
 * Activation is environment-driven so the CLI keeps its current shape:
 *
 *   LLMWIKI_DIMENSIONS=wiki,kg
 *   AKS_STACK_ID=<uuid>       AKS_STACK_NAME=<name>      (optional, defaults to id)
 *   AKS_DATABASE_URL=<dsn>    (optional; the vendored core falls back to its own)
 *
 * With the variable unset or empty, only `wiki` is enabled and ingest behaves
 * exactly as it did before this feature existed. That default is the point:
 * adding a second dimension must not change the behaviour of a project that
 * never asked for one.
 */

import { createKgDimension } from "./kg/index.js";
import { createWikiDimension } from "./wiki/index.js";
import type { Dimension, DimensionName } from "./types.js";

/** Environment variable naming the enabled dimensions, comma-separated. */
export const DIMENSIONS_ENV_VAR = "LLMWIKI_DIMENSIONS";

/** Environment variable naming the knowledge stack id. */
export const AKS_STACK_ID_ENV_VAR = "AKS_STACK_ID";

/** Environment variable naming the knowledge stack's display name. */
const AKS_STACK_NAME_ENV_VAR = "AKS_STACK_NAME";

/** Environment variable overriding the graph database connection string. */
const AKS_DATABASE_URL_ENV_VAR = "AKS_DATABASE_URL";

/** The dimension enabled when the switch is absent. */
const DEFAULT_DIMENSION: DimensionName = "wiki";

/** Every dimension this build knows how to write. */
const KNOWN_DIMENSIONS: readonly DimensionName[] = ["wiki", "kg"];

/** A request for a dimension this build cannot write, or a malformed switch. */
export class DimensionActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DimensionActivationError";
  }
}

/** Parse the comma-separated switch, rejecting names that are not known. */
function parseNames(raw: string | undefined): DimensionName[] {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return [DEFAULT_DIMENSION];

  const names: DimensionName[] = [];
  for (const token of trimmed.split(",")) {
    const name = token.trim();
    if (name === "") continue;
    if (!isKnownDimension(name)) {
      throw new DimensionActivationError(
        `Unknown dimension ${JSON.stringify(name)} in ${DIMENSIONS_ENV_VAR}. ` +
          `Known dimensions: ${KNOWN_DIMENSIONS.join(", ")}.`,
      );
    }
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return [DEFAULT_DIMENSION];
  return names;
}

/** Narrow a token to a known dimension name. */
function isKnownDimension(name: string): name is DimensionName {
  return (KNOWN_DIMENSIONS as readonly string[]).includes(name);
}

/** Options for {@link resolveDimensions}. */
export interface ResolveDimensionsOptions {
  /** Project root, used to bind the wiki dimension. */
  readonly root: string;
  /** Source of the environment values; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Detect-only graph mode; see {@link createKgDimension}. */
  readonly kgDryRun?: boolean;
}

/**
 * Build the enabled dimensions, in commit order.
 *
 * `kg` requires a stack id: a graph write without one would scatter every
 * project's entities into a single unnamed stack, so a missing id is an error
 * rather than a silent default.
 *
 * @param options - Project root plus optional environment and dry-run flag.
 * @throws {DimensionActivationError} on an unknown dimension or missing stack id.
 */
export function resolveDimensions(options: ResolveDimensionsOptions): Dimension[] {
  const env = options.env ?? process.env;
  const names = parseNames(env[DIMENSIONS_ENV_VAR]);
  const dimensions: Dimension[] = [];

  for (const name of KNOWN_DIMENSIONS) {
    if (!names.includes(name)) continue;
    if (name === "wiki") {
      dimensions.push(createWikiDimension(options.root));
      continue;
    }
    const stackId = env[AKS_STACK_ID_ENV_VAR]?.trim() ?? "";
    if (stackId === "") {
      throw new DimensionActivationError(
        `${DIMENSIONS_ENV_VAR} enables "kg" but ${AKS_STACK_ID_ENV_VAR} is not set. ` +
          `Set it to the knowledge stack the documents belong to.`,
      );
    }
    const stackName = env[AKS_STACK_NAME_ENV_VAR]?.trim() || stackId;
    const databaseUrl = env[AKS_DATABASE_URL_ENV_VAR]?.trim();
    dimensions.push(
      createKgDimension({
        stackId,
        stackName,
        ...(databaseUrl === undefined || databaseUrl === "" ? {} : { databaseUrl }),
        ...(options.kgDryRun === true ? { dryRun: true } : {}),
      }),
    );
  }

  return dimensions;
}
