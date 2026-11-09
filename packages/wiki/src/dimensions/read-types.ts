/**
 * @file src/dimensions/read-types.ts
 * @description The READ half of the dimension port: how a dimension is asked a
 * question, and what it answers with.
 *
 * ## Why this is separate from `types.ts`
 *
 * `types.ts` describes how a SOURCE is written — `prepare`, `commit`, `discard`,
 * `forget`, all keyed on one source identity. Reading is a different question with
 * a different shape: it is not tied to a source at all, it may span many, and it
 * returns knowledge rather than confirming a write. Folding the two together would
 * force every writer to implement queries it has no answer for, and would break the
 * frozen v2 contract for a concern it was never about.
 *
 * So the port is versioned separately: {@link DIMENSION_READ_PORT_VERSION}.
 *
 * ## Why a `{ ok }` result rather than a throw
 *
 * "No such entity" is an EXPECTED answer to a lookup, not an exception. A caller
 * has to turn it into its own envelope — an HTTP 404, an MCP tool error, a CLI
 * message — and a thrown error forces every transport to catch and guess which
 * failures are normal. The shape carries the failure instead, with a code the
 * caller can map.
 */

import type { DimensionName } from "./types.js";

/** The version of the read port. Bumped only through an agreed contract change. */
export const DIMENSION_READ_PORT_VERSION = 1 as const;

/**
 * Why a read produced no value.
 *
 * Closed on purpose: a caller maps these onto its own surface, and an open string
 * would make every transport interpret free text. `not_found` is separable from
 * `invalid` because only one of them is the caller's mistake.
 */
export type GraphReadFailureCode =
  /** The thing asked for does not exist. */
  | "not_found"
  /** The request itself is malformed (missing stack, bad depth, empty name). */
  | "invalid"
  /** The dimension cannot answer: no database, no index, feature disabled. */
  | "unavailable";

/** A read that produced no value, with a code the caller maps. */
export interface GraphReadFailure {
  readonly code: GraphReadFailureCode;
  /** Human-readable detail; transports may surface it, but must not parse it. */
  readonly message: string;
}

/** The value, or the reason there is none. */
export type GraphReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GraphReadFailure };

/**
 * One entity as a dimension reports it.
 *
 * Deliberately narrow and dimension-agnostic: a graph has named things of some
 * type with a confidence, and a wiki page is a named thing of type `concept` with
 * no confidence. A shape that named graph columns would force the wiki to fake
 * them.
 */
export interface ReadEntity {
  /** Stable identity within the dimension (graph id, page slug). */
  readonly id: string;
  /** Name as a human writes it. */
  readonly name: string;
  /** Dimension-defined kind (graph `type`, wiki `concept`/`query`). */
  readonly kind: string;
  /** Optional prose account of the entity. */
  readonly description?: string;
  /** Extracted confidence in [0,1]; absent when the dimension has no notion of it. */
  readonly confidence?: number;
}

/** A directed edge between two entities. */
export interface ReadRelationship {
  readonly from: string;
  readonly to: string;
  /** Dimension-defined edge kind. */
  readonly kind: string;
  /** Optional prose account of the relationship. */
  readonly description?: string;
  /** Extracted confidence in [0,1]; absent when the dimension has no notion of it. */
  readonly confidence?: number;
}

/** A passage that matched a text query, with its relevance. */
export interface ReadChunk {
  readonly content: string;
  /** Identity of the document/entity this passage came from. */
  readonly sourceId: string;
  /** Ranking score; higher is more relevant. Scale is dimension-defined. */
  readonly score: number;
}

/**
 * One question to a dimension.
 *
 * Fields are OPTIONAL and combinable because the same call serves "list what is
 * here", "find one thing", "walk from it", and "what text matches this". A
 * dimension answers what it can and says `unavailable` for a capability it lacks,
 * rather than silently returning nothing that reads like "no results".
 */
export interface DimensionQuery {
  /** Entity name to anchor on, for a lookup or a walk. */
  readonly name?: string;
  /** Free text to match against passages. */
  readonly text?: string;
  /** How many relationship hops to walk from the anchor. Omit for none. */
  readonly depth?: number;
  /** Restrict to entities of these kinds. Omit for all. */
  readonly kinds?: readonly string[];
  /** Cap on returned items. */
  readonly limit?: number;
}

/** Everything one read produced. Absent fields mean "not requested or not available". */
export interface DimensionAnswer {
  readonly entities: readonly ReadEntity[];
  readonly relationships: readonly ReadRelationship[];
  readonly chunks: readonly ReadChunk[];
}

/**
 * A dimension that can be asked questions.
 *
 * Implementations must be safe to call concurrently and must not mutate anything:
 * a read that writes is a write, and belongs on {@link import("./types.js").Dimension}.
 */
export interface DimensionReader {
  /** Which dimension this is, matching its write-side name. */
  readonly name: DimensionName;

  /**
   * Answer one question.
   *
   * @param query - What to look for.
   * @returns The answer, or a coded failure a transport maps onto its own surface.
   */
  read(query: DimensionQuery): Promise<GraphReadResult<DimensionAnswer>>;
}
