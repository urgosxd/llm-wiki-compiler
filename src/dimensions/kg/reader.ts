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
 * ## Two capabilities, deliberately separable
 *
 * `readEntities`/`traverseGraph` need only Postgres. Chunk retrieval additionally
 * needs an embedding of the query text, which costs a provider call. Asking for
 * entities must therefore not fail because an embedding provider is unconfigured —
 * the two are attempted independently and their failures reported per capability.
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
  embedQuery,
  kgConfig,
  readEntities,
  readEntityByName,
  retrieveRelevantChunks,
  traverseGraph,
  toVectorLiteral,
  type AKSEntityDto,
  type RetrievedChunk,
} from "llmwiki-kg";
import type {
  DimensionAnswer,
  DimensionQuery,
  DimensionReader,
  GraphReadFailure,
  GraphReadResult,
  ReadChunk,
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

/** Map a retrieved chunk onto the dimension-neutral shape. */
function toReadChunk(chunk: RetrievedChunk): ReadChunk {
  return {
    content: chunk.content,
    sourceId: chunk.document_id,
    score: chunk.similarity,
  };
}

/**
 * Retrieve passages relevant to the query text.
 *
 * Returns `unavailable` when either half cannot run: the text must be embedded
 * before it can be compared, and a missing provider is a capability gap rather
 * than an empty result. Reporting it lets the caller distinguish "nothing matched"
 * from "search is off".
 *
 * @param options - Stack binding and connection override.
 * @param text - Query text.
 * @param limit - Cap on returned passages.
 * @returns Passages, or a coded failure.
 */
async function readChunkPart(
  options: KgReaderOptions,
  text: string,
  limit: number,
): Promise<GraphReadResult<readonly ReadChunk[]>> {
  let embedding: readonly number[];
  try {
    embedding = await embedQuery(text);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "unavailable",
        message: `cannot embed the query: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  // Serializing here proves the vector is well-formed before it reaches SQL; the
  // query path casts it back to ::vector.
  void toVectorLiteral(embedding);
  const rows = await withGraph(options, (db) =>
    db.transaction((tx) => retrieveRelevantChunks(tx, options.stackId, text, embedding, limit)),
  );
  return { ok: true, value: rows.map(toReadChunk) };
}

/**
 * Answer one question against the knowledge graph.
 *
 * Entities and relationships are read first because they need only the database;
 * chunk retrieval is attempted only when text was supplied, so a missing embedding
 * provider never prevents an entity listing.
 *
 * @param options - Stack binding and connection override.
 * @param query - What to look for.
 * @returns The answer, or a coded failure.
 */
async function readGraph(
  options: KgReaderOptions,
  query: DimensionQuery,
): Promise<GraphReadResult<DimensionAnswer>> {
  const limit = query.limit ?? DEFAULT_LIMIT;

  let entities: readonly ReadEntity[] = [];
  let relationships: readonly ReadRelationship[] = [];

  const wantsEntityRead =
    query.name !== undefined || query.text === undefined || query.depth !== undefined;
  if (wantsEntityRead) {
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
  }

  let chunks: readonly ReadChunk[] = [];
  if (query.text !== undefined && query.text.trim() !== "") {
    const chunkPart = await readChunkPart(options, query.text, limit);
    if (!chunkPart.ok) return chunkPart;
    chunks = chunkPart.value;
  }

  return { ok: true, value: { entities, relationships, chunks } };
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
