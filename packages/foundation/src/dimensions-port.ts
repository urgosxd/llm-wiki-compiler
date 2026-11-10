/**
 * @file packages/foundation/src/dimensions-port.ts
 * @description The third injection seam: the configured dimensions, resolved by
 * `@repo/api` and handed to the wiki side, so the engine can ask for them without
 * naming the package that owns the join.
 *
 * ## Why the seam is declared here and not in a dimension
 *
 * `resolveDimensions` (`packages/wiki/src/dimensions/activation.ts`) reads the
 * `LLMWIKI_DIMENSIONS` switch and builds the enabled dimensions, and the join it
 * performs — a wiki store and a KG graph, side by side, in one process — is exactly
 * the capability only `@repo/api` is allowed to hold (spec S2). Two wiki files call
 * it from inside the engine: the graph-retirement path in
 * `packages/wiki/src/compiler/index.ts` and the production path in
 * `packages/wiki/src/services/ingest/service.ts`. Moving the join into `@repo/api`
 * without a seam would make those two files import `@repo/api`, and `wiki → api` is
 * a forbidden edge in the same gate that counts `wiki → kg`.
 *
 * So the capability is declared HERE, where both sides may reach it, and supplied
 * from above. The same reasoning as `providers.ts`, one layer of indirection
 * further: what crosses the boundary is not a lock or one Stack's config but the
 * dimension set itself.
 *
 * ## A port is passed, never installed
 *
 * There is no module-level singleton, no `setDimensions`, no mutable default and no
 * process-start installation. A provider installed by side effect fails silently in
 * exactly the case that matters: a caller in a second context — a test, an MCP
 * server, a CLI subcommand — observes the other registration, or observes nothing,
 * with no way to report the difference. The port is a parameter, so the compiler
 * shows every place that has one and every place that does not.
 *
 * Every member is `readonly` for the corresponding reason: the value belongs to the
 * implementation, and a consumer that swapped a member out would be a second,
 * invisible registration — the registry this seam refuses to be.
 *
 * ## Absence fails loudly, on purpose
 *
 * {@link requireDimensionsPort} throws {@link MissingDimensionsPortError} rather
 * than returning an empty dimension set. An empty set is the failure this file
 * exists to prevent, and it is invisible: compile and ingest would write nothing,
 * report success, and leave the operator with an unchanged database and no error to
 * read. Four gate defects in this repository have the same shape — a rule that stops
 * matching reports zero violations, indistinguishable from a clean tree — and a
 * silent zero here is the same class.
 *
 * The refusal also covers an EMPTY request. A caller that asks for no dimensions has
 * lost the configuration it was supposed to pass, and answering "resolved, zero
 * dimensions" would turn that loss into a success.
 *
 * ## What this seam is not
 *
 * It carries no registry, no dimension names, no environment parsing and no default.
 * `only`, `root`, `db`, `env` and `stackId` are forwarded to the implementation as the
 * caller stated them; the meaning of the switch stays where the switch is read. The
 * type parameter is the dimension type of whichever side implements the port, because
 * this package may not name a wiki or a KG type — naming one would make the bottom
 * layer depend on a layer above it, the single edge the split forbids outright.
 *
 * ## The request is what the two real consumers need, and nothing else
 *
 * The seam was first declared with `{ only, env }` alone, and its first consumer
 * proved that shape wrong: BOTH call sites already hold the project root and the
 * caller's database handle, and one of them resolves the Stack itself through an
 * async, database-touching pre-check. A request that could not carry those would
 * force the port to re-resolve a Stack both call sites explicitly refuse to ask
 * twice — two answers to one question, which is the defect class this whole split
 * exists to remove. So `root` and `db` are required here, and `stackId` is carried
 * when the caller resolved one. `kgDryRun` is deliberately absent: no consumer of
 * the port asks for it, and an unused field on a seam is the same dead configuration
 * as an unused setting.
 */
import type { DatabaseHandle } from "./index.js";

/**
 * One resolution request, as the caller who needs the dimensions states it.
 *
 * Every field the two production call sites already hold when they need a dimension
 * set, and no field they would have to go and find. Two deliberate differences from
 * `ResolveDimensionsOptions`: `env` is REQUIRED here, because a port free to fall
 * back to `process.env` would answer differently in a test and in production through
 * an input it never stated; and `only` is REQUIRED, because a resolution that does
 * not state which dimensions it may return has lost the configuration it was
 * supposed to pass. `only` is `readonly string[]` rather than a dimension-name union
 * for the reason in the file header — the union belongs to the dimension that
 * defines it, and this package may not name it.
 */
export interface DimensionsRequest {
  /** Dimension names the caller may receive; never enables one the environment disabled. */
  readonly only: readonly string[];
  /** The one environment this resolution reads. Required: no ambient default. */
  readonly env: NodeJS.ProcessEnv;
  /** Project root the dimensions are bound to. */
  readonly root: string;
  /** Database handle the dimensions are backed by. */
  readonly db: DatabaseHandle;
  /** Stack the caller already resolved, when it did. */
  readonly stackId?: string;
}

/**
 * The configured dimensions, as the wiki side needs them.
 *
 * @typeParam TDimension - The dimension type of the implementing side. This package
 *   never names it.
 */
export interface DimensionsPort<TDimension> {
  /**
   * Build the dimensions the request enables.
   *
   * Synchronous because the implementation it wraps is: `resolveDimensions` returns
   * an array, and constructing a dimension opens no connection — the postgres-js
   * pool connects lazily, so the failure, when there is one, is reported by the
   * query that needed it. A `Promise` here would be a shape nobody measured, paid
   * for at every call site.
   *
   * @param request - The root, handle, environment and narrowing the caller states.
   * @returns The enabled dimensions, in the implementation's commit order.
   * @throws When the switch names an unknown dimension or the environment cannot
   *   supply a Stack id; both stay the implementation's refusals, unchanged.
   */
  resolve(request: DimensionsRequest): readonly TDimension[];
}

/**
 * The refusal for a path that needs dimensions and received no port.
 *
 * A named class rather than a bare `Error` so a caller can tell this apart from the
 * implementation's own activation errors: a missing port is a wiring mistake made by
 * whoever constructed the call, while an activation error comes from the operator's
 * environment and sends the reader somewhere else entirely.
 */
export class MissingDimensionsPortError extends Error {
  /**
   * @param message - The refusal, naming the dimensions that were requested.
   */
  constructor(message: string) {
    super(message);
    this.name = "MissingDimensionsPortError";
  }
}

/** Quote each requested dimension the way the activation messages do. */
function quoteNames(requested: readonly string[]): string {
  return requested.map((name) => JSON.stringify(name)).join(", ");
}

/**
 * Take the port a dimension-needing path received, or refuse to proceed without one.
 *
 * @param port - The injected port, or `undefined` when the caller has none.
 * @param requested - The dimensions the caller asked for, named in the refusal.
 * @returns The same port, unchanged.
 * @throws {MissingDimensionsPortError} when `port` is `undefined`, and when
 *   `requested` is empty — an empty request is a caller bug, not success.
 */
export function requireDimensionsPort<TDimension>(
  port: DimensionsPort<TDimension> | undefined,
  requested: readonly string[],
): DimensionsPort<TDimension> {
  if (requested.length === 0) {
    throw new MissingDimensionsPortError(
      `LLMWIKI_DIMENSIONS enables no dimension, so no DimensionsPort can resolve it. ` +
        `An empty request means the configured dimensions were lost before they reached this call.`,
    );
  }
  if (port === undefined) {
    throw new MissingDimensionsPortError(
      `LLMWIKI_DIMENSIONS enables ${quoteNames(requested)} but no DimensionsPort was supplied to resolve it. ` +
        `Construct one where both dimensions are visible and pass it to this call.`,
    );
  }
  return port;
}
