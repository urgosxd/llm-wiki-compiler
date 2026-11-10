/**
 * @file test/sdk/published-dimensions-port.test.ts
 * @description Compile-time pin for the direction that ships: the port `@repo/api`
 * composes must be accepted by the published option, and the published shape must be
 * the one the wiki ingest path takes.
 *
 * ## Why the published port is a SECOND declaration
 *
 * `CreateWikiOptions` reaches embedders through `@atomicstrata/llmwiki-core`'s
 * `compiler-sdk` (`packages/wiki/src/sdk/compiler-composition.ts`, built by
 * `packages/llmwiki-core/tsup.config.ts:11-12`), and `dist/index.d.ts:1` of the root
 * package imports the option type from that specifier. `@repo/foundation` is
 * `private: true` and is absent from `.github/workflows/publish.yml`'s
 * `PACKAGE_DIRS`, so naming foundation's `DimensionsPort` in `core-types.ts` would put
 * a specifier in a published `.d.ts` that no embedder can install. The shape is
 * therefore restated, and the restated one is AUTHORITATIVE on the wiki side:
 * `writeToDimensions` and `ingestSource` take the published port, so foundation's
 * implementation-side interface is the thing that must satisfy it.
 *
 * ## Which direction is asserted, and why only that one
 *
 * A published contract has to answer "may a port supplied by the composing package be
 * accepted by the wiki ingest path?" — not "are these two declarations identical?".
 * Asserting identity in both directions was measured and cannot be satisfied: the
 * engine's `db` returns `RowList<Assume<TRow, Row>[]>` from `db.execute`, and no
 * hand-written container is mutually assignable with it, so an identity guard demands
 * that the published file name the ORM and driver packages — specifiers a published
 * consumer of the core SDK cannot resolve. The reverse direction is nobody's need,
 * because nothing ever hands a hand-built published port to the engine's resolver:
 * the composition root owns the port AND the resolver.
 *
 * ## Where the real factory is anchored, and why not here
 *
 * `createDimensionsPort()` (`packages/api/src/dimensions/port.ts`) returns exactly
 * `DimensionsPort<Dimension>`, the type assigned below. The literal claim "the object
 * that factory returns is accepted by `CreateWikiOptions.dimensionsPort`" is asserted
 * in `packages/api/src/dimensions/port.test.ts`, because `eslint.config.mjs`'s
 * `WIKI_TO_API` boundary forbids every root-side specifier that names that package —
 * a rule this guard must not be the reason to weaken.
 *
 * ## What this guard does NOT prove
 *
 * The published `db` is OPAQUE at this boundary (`readonly db: object`), so
 * assignability holds for the request's named members but says nothing about `db`'s
 * query surface — a hand-built port cannot execute SQL through it, by design.
 *
 * ## Why `SameKeys` sits beside the assignments
 *
 * `resolve` is a METHOD and method parameters compare bivariantly, so an
 * assignment-only guard tolerates drift in one direction. Dropping an OPTIONAL member
 * (`stackId?`) is mutually assignable in particular — an absent optional property is
 * compatible both ways — and only a key-set comparison catches it. Everything here is
 * type-level, so drift fails `pnpm run typecheck:tests`, not a runtime expectation.
 */

import { describe, expect, it } from "vitest";
import type {
  DimensionsPort as EngineDimensionsPort,
  DimensionsRequest as EngineDimensionsRequest,
} from "@repo/foundation";
import type { Dimension } from "../../packages/wiki/src/dimensions/types.js";
import type { ingestSource } from "../../packages/wiki/src/services/ingest/service.js";
import type {
  CreateWikiOptions,
  DimensionsPort as PublishedDimensionsPort,
  DimensionsRequest as PublishedDimensionsRequest,
} from "../../packages/wiki/src/sdk/compiler-composition.js";

/** The port type `ingestSource` accepts, as the wiki side now declares it. */
type IngestAcceptedPort = NonNullable<Parameters<typeof ingestSource>[5]>;

/** `true` when both key sets are identical in both directions, `never` otherwise. */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : never
  : never;

/**
 * An implementation-side port satisfies the public option.
 *
 * This is the product direction: the port the composition root builds is what the
 * embedder passes as `CreateWikiOptions.dimensionsPort`. The concrete anchor — the
 * object `createDimensionsPort()` actually returns — is asserted in
 * `packages/api/src/dimensions/port.test.ts` for the boundary reason in the header,
 * and its return type IS this one.
 */
const enginePortToOptions = (
  port: EngineDimensionsPort<Dimension>,
): NonNullable<CreateWikiOptions["dimensionsPort"]> => port;

/**
 * The same port satisfies what the wiki ingest path accepts.
 *
 * Proves the re-pointed parameter type is the direction that ships, not a second
 * identity claim: the port an implementation builds is what `writeToDimensions`
 * receives through `ingestSource`.
 */
const enginePortToIngest = (port: EngineDimensionsPort<Dimension>): IngestAcceptedPort => port;

/** The published request names exactly the members the engine's request names. */
type AssertRequestKeysMatch = SameKeys<EngineDimensionsRequest, PublishedDimensionsRequest>;
const _requestKeysMatch: AssertRequestKeysMatch = true;

/** The published port exposes exactly the member the engine's port exposes. */
type AssertPortKeysMatch = SameKeys<
  EngineDimensionsPort<Dimension>,
  PublishedDimensionsPort<Dimension>
>;
const _portKeysMatch: AssertPortKeysMatch = true;

/** Omission of `dimensionsPort` is valid (spec S3), so `undefined` must be accepted. */
type AssertPortIsOptional = undefined extends CreateWikiOptions["dimensionsPort"]
  ? true
  : never;
const _portIsOptional: AssertPortIsOptional = true;

/** A `root`-only options object must compile: omitting the port is the shipped default. */
const _rootOnlyOptions: CreateWikiOptions = { root: "/tmp/published-port-omitted" };

// Referenced so a future unused-variable sweep keeps the compile-time assertions.
void enginePortToOptions;
void enginePortToIngest;
void _requestKeysMatch;
void _portKeysMatch;
void _portIsOptional;
void _rootOnlyOptions;

describe("published DimensionsPort", () => {
  it("declares a resolve method on the published shape", () => {
    // The type-level assertions above are the guard; this keeps the file collectable
    // by `pnpm test` and reads the one member both declarations must agree on.
    const port: PublishedDimensionsPort<Dimension> = {
      resolve: () => [],
    };
    expect(typeof port.resolve).toBe("function");
  });
});
