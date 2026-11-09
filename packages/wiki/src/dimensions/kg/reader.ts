/**
 * @file src/dimensions/kg/reader.ts
 * @description The `kg` dimension as a READER: entities, relationships, and
 * relevant chunks from the knowledge graph.
 *
 * ## What it answers that the wiki cannot
 *
 * The graph stores EXTRACTED entities and typed edges, so it can answer "how is X
 * connected to Y" and "which passages mention Z" in a way the wiki's page store
 * cannot. The wiki has compiled concepts and no edges; this has edges and no
 * compiled pages. That asymmetry is the reason both dimensions exist rather than
 * one being sufficient.
 *
 * ## What this reader does NOT do: passages
 *
 * It answers entities and typed edges, and deliberately nothing else. It used to
 * advertise passage retrieval too, and that capability was never real: this
 * dimension chunks and embeds a document during `prepare`, then throws the chunks
 * away without writing `document_chunks`, because only the vendored HTTP route
 * calls `upsertChunk`. So `read({ text })` answered `ok: true` with `chunks: []`
 * for every query, forever.
 *
 * A caller could not distinguish "nothing matched" from "never wired", which is
 * the same silent lie as a provider outage reported as an empty graph. The
 * capability is therefore removed rather than left broken, and a text query now
 * answers `unavailable` with a message naming the gap. The `wiki` dimension does
 * serve passages, so the alternative is real and the message says so.
 *
 * ## Why it reuses `core/graph_read.ts`
 *
 * Those functions ARE the read layer, already verified against the oracle. This
 * module only translates between the dimension-neutral contract and the AKS
 * shapes, so there is one implementation of each query in the codebase.
 */

import {
  createClient,
  createDatabase,
  kgConfig,
  readEntities,
  readEntityByName,
  traverseGraph,
  type AKSEntityDto,
} from "@repo/kg";
import type {
  DimensionAnswer,
  DimensionQuery,
  DimensionReader,
  GraphReadFailure,
  GraphReadResult,
  ReadEntity,
  ReadRelationship,
} from "../read-types.js";

/** Seconds to wait for the graph database before giving up. */
const DB_CONNECT_TIMEOUT_SECONDS = 10;

/** Default cap when the caller does not set one. */
const DEFAULT_LIMIT = 20;

/** Default hop count for a walk when the caller asks for one without a depth. */
const DEFAULT_DEPTH = 2;

/** How this reader is bound to one knowledge stack. */
export interface KgReaderOptions {
  /** Knowledge stack the graph belongs to. */
  readonly stackId: string;
  /** Postgres connection string; defaults to the vendored core's own config. */
  readonly databaseUrl?: string;
}

/** Map an AKS entity onto the dimension-neutral shape. */
function toReadEntity(entity: AKSEntityDto): ReadEntity {
  return {
    id: entity.id,
    name: entity.name,
    kind: entity.type,
    ...(entity.description === null ? {} : { description: entity.description }),
    confidence: entity.confidence,
  };
}

/**
 * Translate a coded graph failure into the dimension contract's failure.
 *
 * The two shapes differ only in the HTTP status, which a dimension must not carry:
 * a transport decides its own status from the CODE.
 *
 * @param failure - Failure from `core/graph_read.ts`.
 * @returns The same information without transport concerns.
 */
function toContractFailure(failure: { code: string; message: string }): GraphReadFailure {
  const code =
    failure.code === "not_found" || failure.code === "invalid" || failure.code === "unavailable"
      ? failure.code
      : "unavailable";
  return { code, message: failure.message };
}

/** Run one graph read inside a transaction and close the client afterwards. */
async function withGraph<T>(
  options: KgReaderOptions,
  work: (db: ReturnType<typeof createDatabase>) => Promise<T>,
): Promise<T> {
  const client = createClient(
    options.databaseUrl ?? kgConfig.DATABASE_URL,
    DB_CONNECT_TIMEOUT_SECONDS,
  );
  try {
    const db = createDatabase(client);
    return await work(db);
  } finally {
    await client.end({ timeout: DB_CONNECT_TIMEOUT_SECONDS });
  }
}

/** Read entities, optionally narrowed by kind, or one by name. */
async function readEntityPart(
  options: KgReaderOptions,
  query: DimensionQuery,
): Promise<GraphReadResult<readonly ReadEntity[]>> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  return withGraph(options, (db) =>
    db.transaction(async (tx) => {
      if (query.name !== undefined && query.name.trim() !== "") {
        const single = await readEntityByName(tx, options.stackId, null, query.name);
        if (!single.ok) return { ok: false, error: toContractFailure(single.error) };
        return { ok: true, value: [toReadEntity(single.value)] };
      }
      const many = await readEntities(tx, {
        stackId: options.stackId,
        domain: null,
        type: query.kinds?.[0] ?? null,
        minConfidence: 0,
        limit,
      });
      if (!many.ok) return { ok: false, error: toContractFailure(many.error) };
      const scoped =
        query.kinds === undefined || query.kinds.length === 0
          ? many.value
          : many.value.filter((entity) => query.kinds?.includes(entity.type));
      return { ok: true, value: scoped.map(toReadEntity) };
    }),
  );
}

/** Walk from an anchor, returning typed edges. */
async function readRelationshipPart(
  options: KgReaderOptions,
  query: DimensionQuery,
): Promise<readonly ReadRelationship[]> {
  if (query.name === undefined || query.name.trim() === "" || query.depth === undefined) {
    // Walking needs an anchor AND a depth; without either there is no walk to do.
    return [];
  }
  const result = await withGraph(options, (db) =>
    db.transaction((tx) =>
      traverseGraph(tx, {
        start: query.name as string,
        stackId: options.stackId,
        domain: null,
        maxDepth: query.depth ?? DEFAULT_DEPTH,
        relationshipTypes: null,
      }),
    ),
  );
  if (!result.ok) return [];
  return result.value.steps.map((step) => ({
    from: step.from_entity,
    to: step.to_entity,
    kind: step.relationship,
    // The walk reports one confidence per edge; the oracle's step shape flattens
    // it, so it is the only value available here.
    confidence: step.confidence,
  }));
}

/**
 * Answer one question against the knowledge graph.
 *
 * A text query is refused up front, before any database work, because this
 * dimension cannot answer it: the passages a text query asks for are never
 * stored by this path. Refusing early is also what keeps the answer honest — a
 * caller that ignores the code still cannot mistake it for "no matches".
 *
 * Entities and relationships then need only Postgres, so they are read
 * independently of any provider being configured.
 *
 * @param options - Stack binding and connection override.
 * @param query - What to look for.
 * @returns The answer, or a coded failure.
 */
async function readGraph(
  options: KgReaderOptions,
  query: DimensionQuery,
): Promise<GraphReadResult<DimensionAnswer>> {
  if (query.text !== undefined && query.text.trim() !== "") {
    return {
      ok: false,
      error: {
        code: "unavailable",
        message:
          "the kg dimension does not serve passage retrieval; " +
          "query the wiki dimension for text matches",
      },
    };
  }

  let entities: readonly ReadEntity[] = [];
  let relationships: readonly ReadRelationship[] = [];

  // A text query already returned above, so a call reaching here either names an
  // anchor, asks to walk, or lists what the graph holds. All three want the
  // entity part; only a walk also wants the edges.
  const entityPart = await readEntityPart(options, query).catch((error: unknown) => ({
    ok: false as const,
    error: {
      code: "unavailable" as const,
      message: error instanceof Error ? error.message : String(error),
    },
  }));
  if (!entityPart.ok) return entityPart;
  entities = entityPart.value;
  relationships = await readRelationshipPart(options, query);

  return { ok: true, value: { entities, relationships, chunks: [] } };
}

/**
 * Build the graph dimension's reader.
 *
 * @param options - Stack binding and connection override.
 * @returns A reader bound to that stack.
 */
export function createKgReader(options: KgReaderOptions): DimensionReader {
  return {
    name: "kg",
    read: (query: DimensionQuery) => readGraph(options, query),
  };
}
