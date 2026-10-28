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
 * With the variable unset or empty, only `wiki` is enabled.
 *
 * ## Postgres is required, for both dimensions
 *
 * The `wiki` dimension used to have a file-backed sibling. That is gone: pages
 * live in the `wiki.pages` table keyed by Stack, so building EITHER dimension
 * requires a reachable database and a stack id. A machine without them cannot
 * compile, which is a product decision recorded in
 * `odd/tasks/multi-tenant-stack-only.md`, not an incidental default.
 *
 * The stack id requirement is checked BEFORE the switch is honoured, and it is
 * checked for every enabled dimension rather than only for `kg`. Two reasons:
 *
 *   - A dimension that silently resolves to a different backend is worse than a
 *     refusal, because the caller cannot tell which one it got.
 *   - Callers that resolve dimensions only to FILTER one out (`compile`'s
 *     `forgetDeletedSources` drops `wiki` immediately) would otherwise fail on a
 *     dimension they never intended to use. Failing closed here is the honest
 *     answer: the environment is misconfigured either way.
 */

import { createClient, createDatabase, kgConfig, type Database } from "llmwiki-kg";
import { createKgDimension } from "./kg/index.js";
import { createWikiStoreDimension } from "./wiki/database.js";
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

/**
 * A database handle plus the one way to release it.
 *
 * The client is carried alongside the handle because closing the drizzle object
 * is not how a pool is drained -- the driver's `end()` is, and only the value
 * that created the client can call it. Returning both keeps that pairing
 * explicit instead of reaching through drizzle internals at each call site.
 */
export interface DimensionsDatabase {
  /** Drizzle handle the dimensions are bound to. */
  readonly db: Database;
  /** Drain the pool. Safe to call once per handle. */
  close(): Promise<void>;
}

/**
 * Build the database handle every dimension is backed by.
 *
 * Constructing a client does NOT connect: postgres-js pools lazily, so a process
 * that never writes a page never opens a socket. That is what lets `compile`
 * hold a handle without requiring a reachable database up front -- the failure,
 * when there is one, is reported by the query that actually needed it.
 *
 * @param env - Environment to read the DSN from; defaults to `process.env`.
 * @returns The handle and its closer.
 */
export function createDimensionsDatabase(env: NodeJS.ProcessEnv = process.env): DimensionsDatabase {
  const configured = env[AKS_DATABASE_URL_ENV_VAR]?.trim();
  const client = createClient(
    configured === undefined || configured === "" ? kgConfig.DATABASE_URL : configured,
    DB_CONNECT_TIMEOUT_SECONDS,
  );
  return {
    db: createDatabase(client),
    close: () => client.end({ timeout: DB_CLOSE_TIMEOUT_SECONDS }),
  };
}

/** Seconds to wait for a connection before failing, matching the KG dimension. */
const DB_CONNECT_TIMEOUT_SECONDS = 10;

/** Seconds to allow a pool to drain on close. */
const DB_CLOSE_TIMEOUT_SECONDS = 5;

/** Options for {@link resolveDimensions}. */
export interface ResolveDimensionsOptions {
  /** Project root, used to locate project state (not a storage medium for pages). */
  readonly root: string;
  /** Source of the environment values; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Detect-only graph mode; see {@link createKgDimension}. */
  readonly kgDryRun?: boolean;
  /**
   * Database handle to bind the wiki dimension to.
   *
   * REQUIRED, and deliberately not optional. Every dimension is Postgres-backed
   * now, so a caller without a handle cannot build one. It is a required
   * argument rather than an optional one checked at runtime for a specific
   * reason: the switch DEFAULTS to `wiki`, so every existing caller enables it.
   * An optional field would let all of them compile and then fail inside ingest,
   * far from the line that forgot to pass it. Making it required turns each of
   * those into a compile error at the call site instead.
   */
  readonly db: Database;
  /**
   * Restrict resolution to these dimensions, intersected with the switch.
   *
   * Exists because one caller wants a single dimension and must NOT build the
   * others: `compile`'s graph-retirement path needs `kg` and would otherwise
   * construct the wiki too, demanding a Stack id for a dimension it discards.
   * Filtering after construction made that build unavoidable; asking for a
   * subset before construction is what avoids it.
   *
   * Still honours `LLMWIKI_DIMENSIONS`: `only` narrows, it never enables a
   * dimension the environment disabled.
   */
  readonly only?: readonly DimensionName[];
}

/**
 * Read the Stack id every dimension is keyed by, refusing an absent one.
 *
 * One Stack per ingest is the whole isolation model: without it there is no
 * tenant to key a row by, so there is nothing sensible to write.
 *
 * @param env - Environment to read.
 * @param dimension - Dimension being resolved, named in the error.
 * @returns The trimmed Stack id.
 * @throws {DimensionActivationError} when it is unset or blank.
 */
function requireStackId(env: NodeJS.ProcessEnv, dimension: DimensionName): string {
  const stackId = env[AKS_STACK_ID_ENV_VAR]?.trim() ?? "";
  if (stackId === "") {
    throw new DimensionActivationError(
      `${DIMENSIONS_ENV_VAR} enables "${dimension}" but ${AKS_STACK_ID_ENV_VAR} is not set. ` +
        `Set it to the knowledge stack the documents belong to.`,
    );
  }
  return stackId;
}

/**
 * Build the wiki dimension over Postgres, or refuse when no handle was supplied.
 *
 * @param options - Resolution options, possibly carrying a database.
 * @param env - Environment to read the Stack id from.
 * @returns The Postgres-backed wiki dimension.
 * @throws {DimensionActivationError} when the database handle is missing.
 */
function resolveWiki(options: ResolveDimensionsOptions, env: NodeJS.ProcessEnv): Dimension {
  // The handle is checked first because it is the caller-level mistake: an
  // operator who forgot `{ db }` controls that argument directly, while the
  // Stack id lives in the environment. Reporting the environment first would
  // send them to the wrong place when both are missing.
  const stackId = requireStackId(env, "wiki");
  // `root` is required by the dimension, not by this function: pages are rows,
  // but the raw markdown is still written under `sources/` so `compile` can
  // discover it. Until Wave 4 moves those bytes, the dimension needs both.
  return createWikiStoreDimension({ db: options.db, stackId, root: options.root });
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
/**
 * The Stack these dimensions will write to, resolved the same way they resolve it.
 *
 * The outbox needs this and must not re-derive it. The dimemensions take their
 * Stack from the environment through {@link requireStackId}, so a second reader --
 * parsing `AKS_STACK_ID` again in the caller -- would be a second answer to the same
 * question, and the two would disagree the moment one of them changed.
 *
 * @param env - Environment to read the Stack id from.
 * @returns The Stack id every enabled dimension is bound to.
 * @throws {DimensionActivationError} when `AKS_STACK_ID` is missing.
 */
export function resolveStackId(env: NodeJS.ProcessEnv = process.env): string {
  return requireStackId(env, "wiki");
}

export function resolveDimensions(options: ResolveDimensionsOptions): Dimension[] {
  const env = options.env ?? process.env;
  const names = parseNames(env[DIMENSIONS_ENV_VAR]);
  const dimensions: Dimension[] = [];

  for (const name of KNOWN_DIMENSIONS) {
    if (!names.includes(name)) continue;
    if (options.only !== undefined && !options.only.includes(name)) continue;
    if (name === "wiki") {
      dimensions.push(resolveWiki(options, env));
      continue;
    }
    const stackId = requireStackId(env, "kg");
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
