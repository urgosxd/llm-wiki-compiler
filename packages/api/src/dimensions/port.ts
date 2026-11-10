/**
 * @file packages/api/src/dimensions/port.ts
 * @description The first real implementation of `@repo/foundation`'s `DimensionsPort`:
 * the configured dimensions, resolved here because this is the only package allowed
 * to hold a wiki store and a KG graph at once, and handed to the engine as a
 * parameter.
 *
 * ## Why the implementation lives in this package
 *
 * Foundation declares the seam and may not name a dimension; the wiki side receives
 * the port and may not name this package (`wiki → api` is a forbidden edge, counted
 * by the same gate that counts `wiki → kg`). So the implementation can only exist
 * here: joining the two dimensions is the capability spec L18.S1 grants this package
 * alone, and `packages/api/src/host/server.ts` already imports `@repo/kg/server` — the
 * edge this file makes real on the dimension path.
 *
 * ## A thin forwarder, on purpose
 *
 * `resolve` does not resolve anything itself. It calls wiki's own
 * `resolveDimensions` with the request it was handed — same root, same handle, same
 * environment, same Stack — so the meaning of `LLMWIKI_DIMENSIONS`, the ordering of
 * the enabled dimensions and every activation refusal stay exactly where they already
 * are. Re-deriving any of it here would be a second answer to a question the engine
 * and this package would then disagree about, and the disagreement would be silent.
 *
 * ## Stateless, and with no ambient default
 *
 * `createDimensionsPort()` takes no arguments, keeps no module-level mutable state and
 * reads no environment. A factory that captured `process.env` at construction would
 * answer differently in a test and in production through an input it never stated;
 * the request is the only source, which is why `env` is required at the seam and why
 * `prepare`/`commit`/`forget` are absent — both call sites use `resolve` and nothing
 * else, and a member nobody calls is dead configuration.
 *
 * ## Why the two type aliases below are derived instead of named
 *
 * Foundation may not name a dimension type, so `DimensionsPort<TDimension>` is
 * generic and the implementation supplies the parameter. Writing it as `Dimension`
 * would be the clearer spelling, and it is unreachable: `Dimension` and `DimensionName`
 * are declared in `packages/wiki/src/dimensions/types.ts` and re-exported only from
 * `packages/wiki/src/dimensions/index.ts`, which is NOT one of `packages/wiki`'s
 * exported subpaths — `@repo/wiki/dimensions` does not resolve. Reaching them would
 * mean either widening that package's manifest (a change this task does not own) or a
 * cross-package relative walk into another package's internals, which is the exact
 * spelling the boundary gate treats as a reach. Deriving both through the resolver
 * keeps one source of truth, wiki's own signature, with no cast.
 */
import type { DimensionsPort, DimensionsRequest } from "@repo/foundation";
import { DimensionActivationError, resolveDimensions } from "@repo/wiki/dimensions-activation";
import type { ResolveDimensionsOptions } from "@repo/wiki/dimensions-activation";

/**
 * One resolved dimension, as wiki declares it.
 *
 * Derived from the resolver's return type rather than named, for the reason in the
 * file header: the element type of `readonly Dimension[]` is exactly what a consumer
 * receives, so nothing here can drift from it.
 */
type ResolvedDimension = ReturnType<typeof resolveDimensions>[number];

/**
 * wiki's dimension-name union, reached through its own options type.
 *
 * `NonNullable` is what removes the optionality: `only` is declared optional on
 * `ResolveDimensionsOptions`, so the union is the element type of the non-undefined
 * form, not of the property as spelled.
 */
type WikiDimensionName = NonNullable<ResolveDimensionsOptions["only"]>[number];

/**
 * The dimension names this port accepts, one key per member of wiki's union.
 *
 * A `Record` rather than a list so `tsc` checks it in BOTH directions: a name wiki
 * adds becomes a missing key here, and a name it drops becomes an excess one. That is
 * the drift guard the derived type buys, and it is why the table is written out
 * instead of read from wiki — wiki publishes no runtime vocabulary list, and
 * `KNOWN_DIMENSIONS` in `activation.ts` is module-private by design.
 *
 * The table exists because the request's `only` is `readonly string[]` (foundation may
 * not name the union) while `resolveDimensions` wants the union. Passing the strings
 * through unchecked would NOT be caught downstream: `resolveDimensions` validates the
 * environment switch through `parseNames` and then filters by `options.only.includes`,
 * so an unknown name in `only` is silently dropped and the caller receives a smaller
 * dimension set with no error. That is the same silent-zero failure
 * `MissingDimensionsPortError` exists to refuse, so it is refused here.
 */
const ACCEPTED_NAMES: Record<WikiDimensionName, true> = { wiki: true, kg: true };

/**
 * Tell a requested name apart from one this build cannot write.
 *
 * @param name - A name exactly as the caller stated it in `only`.
 * @returns Whether it is a dimension name wiki knows.
 */
function isAcceptedName(name: string): name is WikiDimensionName {
  return Object.hasOwn(ACCEPTED_NAMES, name);
}

/**
 * Narrow the request's `only` to the union wiki's resolver takes, refusing strangers.
 *
 * Names are refused rather than dropped for the reason in `ACCEPTED_NAMES`: a dropped
 * name resolves a subset and reports success, which no caller can tell from a working
 * configuration.
 *
 * @param only - The narrowing the caller stated, as the seam types it.
 * @returns The same names, typed as wiki's union, in the order the caller stated them.
 * @throws {DimensionActivationError} when any name is one this build cannot write.
 */
function narrowOnly(only: readonly string[]): WikiDimensionName[] {
  const unknown = only.filter((name) => !isAcceptedName(name));
  if (unknown.length > 0) {
    throw new DimensionActivationError(
      `Unknown dimension ${unknown.map((name) => JSON.stringify(name)).join(", ")} ` +
        `requested of the DimensionsPort. Known dimensions: ${Object.keys(ACCEPTED_NAMES).join(", ")}.`,
    );
  }
  return only.filter(isAcceptedName);
}

/**
 * Build the port `@repo/api` hands to any caller that needs the configured dimensions.
 *
 * Stateless: every call returns an equivalent port, and nothing is captured between
 * them. The caller decides the root, the handle, the environment and the Stack — this
 * function only decides that wiki's resolver is the one that answers.
 *
 * @returns The port, typed against foundation's interface for wiki's dimension type.
 */
export function createDimensionsPort(): DimensionsPort<ResolvedDimension> {
  return {
    resolve(request: DimensionsRequest): readonly ResolvedDimension[] {
      return resolveDimensions({
        root: request.root,
        db: request.db,
        env: request.env,
        only: narrowOnly(request.only),
        stackId: request.stackId,
      });
    },
  };
}
