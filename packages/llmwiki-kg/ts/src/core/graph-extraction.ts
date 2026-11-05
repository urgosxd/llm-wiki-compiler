/**
 * @file packages/llmwiki-kg/ts/src/core/graph-extraction.ts
 * @description Graph extraction: chunk batch → triplets → entities and edges.
 *
 * ## Three outcomes per chunk, three different answers
 *
 * A chunk yields no triplets for three reasons that an operator must be able to
 * tell apart, because the remedy differs for each:
 *
 * - the provider FAILED after every retry, reported in `failedChunks`;
 * - the provider answered, but with no usable envelope at all, reported in
 *   `mangledChunks`;
 * - the model legitimately found nothing, reported by neither counter.
 *
 * One bad chunk yields no triplets *for that chunk* and extraction continues,
 * mirroring the oracle's `except (ValueError, TypeError, AttributeError)` around
 * its structured predict. One bad chunk must not fail a document, and that
 * tolerance is what lets a forty-chunk document survive one odd response.
 *
 * But when EVERY chunk failed there is no partial result left to protect: either
 * the provider is down or the credential is wrong. Returning an empty result
 * there is how the `kg` dimension committed a document with an empty graph while
 * reporting success -- indistinguishable from a corpus with nothing to extract.
 * So all-failed raises, while a mangled response is only ever counted: a
 * mangled envelope is a degraded answer, not an outage, so even an all-mangled
 * run returns a result instead of throwing.
 *
 * ## A fourth number that is not a fourth outcome
 *
 * `schemaViolations` rides alongside those three without changing any of them. On
 * a provider that treats the tool schema's `enum` as a hint -- everything except
 * strict-capable OpenAI -- an invented type arrives untouched and is then
 * rejected for being undeclared, which reads exactly like the model choosing a
 * type the Stack does not use. Counting those `type` values (see
 * `llm/schema-validation.ts`) separates "the model drifted" from "this gateway
 * ignores `strict`", a distinction whose remedy is configuration, not a prompt.
 * Nothing is filtered by it: the triplet still travels `rejectTriplet`.
 */

import { callTool } from "./llm_clients.js";
import { extractionModel } from "./llm/endpoints.js";
import { ProviderUnavailableError, withProviderRetry } from "./llm/retry.js";
import { countSchemaViolations } from "./llm/schema-validation.js";
import { strictSchemaEnabled } from "./llm/strict-policy.js";
import { buildExtractionPrompt, buildToolSchema, type ToolSchema } from "./graph-prompt.js";
import {
  isShapeMangled,
  parseStandaloneEntities,
  parseTriplets,
  type StandaloneEntity,
  type Triplet,
} from "./graph-parse.js";
import {
  admitStandaloneEntities,
  parseTripletsWithOntology,
  type Ontology,
  type RejectedTriplet,
} from "./ontology.js";
import {
  EXTRACTED_CONFIDENCE,
  EXTRACTION_PIPELINE,
  type ChunkResult,
  type ExtractedEntity,
  type ExtractedRelationship,
  type ExtractionResult,
} from "./extraction-types.js";

/** The result for a document that produced no chunks. */
function emptyResult(): ExtractionResult {
  return {
    entities: [],
    relationships: [],
    // The model this run ASKED, which is the one an injected chat backend
    // supplies: a result that reported the configured default would be the same
    // false provenance the consolidation writes were caught recording.
    model: extractionModel(),
    pipeline: EXTRACTION_PIPELINE,
  };
}

/** What one chunk contributed: admitted triplets, what was dropped, and nodes. */
interface ChunkOutput {
  readonly triplets: readonly Triplet[];
  readonly rejected: readonly RejectedTriplet[];
  readonly standalone: readonly StandaloneEntity[];
  /**
   * Endpoints of triplets whose only fault was the relationship.
   *
   * Kept apart from `standalone` because the two arrive from different places —
   * the model's `entities` array versus a rejected triplet — and because the
   * audit report counts them separately.
   */
  readonly rescued: readonly StandaloneEntity[];
  /**
   * Type positions the returned payload put outside the schema's `enum`s.
   *
   * Not a fourth outcome: the chunk answers like any other, and its triplets are
   * handled exactly as they always were. This is a diagnostic ABOUT the answer,
   * and it exists because on a provider that treats the schema's `enum` as a hint
   * the model's non-compliance used to be invisible — it read like a legitimate
   * type the model chose.
   *
   * Always 0 when the provider enforces the schema (`strict: true`), and always 0
   * on a run with no ontology, which has no `enum` to fall outside of.
   */
  readonly schemaViolations: number;
  /**
   * Whether the provider answered with no usable envelope at all.
   *
   * The third outcome, and the one that used to be invisible: a response that is
   * non-blank but exposes neither a `triplets` array nor an `entities` array
   * yields zero of both, exactly like prose with nothing to extract in it.
   * Always `false` when {@link failure} is set: the provider never answered, so
   * there is no shape to judge, and reporting both would double-count one chunk.
   */
  readonly shapeMangled: boolean;
  /**
   * Why this chunk produced nothing, or `undefined` when it answered.
   *
   * Separate from "returned zero triplets", which is a legitimate answer a model
   * gives for prose with no facts in it. Collapsing the two is what made an
   * outage look like a thin corpus. The error itself is carried, not just a flag,
   * because the caller that decides an outage is fatal has to report WHY.
   */
  readonly failure?: unknown;
}

/** An answer carrying either a result or the reason there is none. */
function emptyOutput(failure?: unknown): ChunkOutput {
  return {
    triplets: [],
    rejected: [],
    standalone: [],
    rescued: [],
    // A chunk that never got an answer is a failure, not a mangled shape.
    shapeMangled: false,
    // And not a schema violation either: there is no payload to judge.
    schemaViolations: 0,
    ...(failure === undefined ? {} : { failure }),
  };
}

/**
 * Asks the model for one chunk's triplets, retrying a transient failure.
 *
 * The retry wrapper is the first half of the fix for a silent empty graph: one
 * transient response must not cost a chunk. The `catch` is the second half — it
 * marks the chunk as failed rather than reporting an empty contribution, so
 * `extractGraphFromChunks` can tell an outage from a document with no facts.
 *
 * A permanent failure (a bad credential) is not retried by the policy and lands
 * here immediately, which is correct: the answer would not change.
 */
async function chunkTriplets(
  chunk: ChunkResult,
  stackName: string,
  ontology: Ontology | undefined,
): Promise<ChunkOutput> {
  const prompt = buildExtractionPrompt(chunk.content, chunk.chunkIndex, stackName);
  // Built once, outside the retry: every attempt advertises the same schema, and
  // the client-side validator reads its `enum`s from this very object, so the
  // schema checked here is the one the model was shown.
  const schema = buildToolSchema(ontology);
  try {
    const argumentsJson = await withProviderRetry(() => callTool(prompt, schema));
    const standalone = standaloneFor(argumentsJson, ontology);
    const shapeMangled = isShapeMangled(argumentsJson);
    const schemaViolations = advisoryViolations(argumentsJson, schema, ontology);
    if (ontology === undefined) {
      return {
        triplets: parseTriplets(argumentsJson),
        rejected: [],
        standalone,
        rescued: [],
        shapeMangled,
        schemaViolations,
      };
    }
    return {
      ...parseTripletsWithOntology(argumentsJson, ontology),
      standalone,
      shapeMangled,
      schemaViolations,
    };
  } catch (error) {
    // The retries are spent. Report WHY the chunk produced nothing; whether that
    // is fatal is decided by the caller, the only place that knows how many
    // chunks succeeded.
    return emptyOutput(error);
  }
}

/**
 * Counts the schema violations this run can actually attribute to the provider.
 *
 * Both conditions matter. With no ontology there is no `enum` to fall outside of,
 * so a count against `DEFAULT_ENTITIES` would invent a constraint the model was
 * never given. With `strict: true` the provider itself rejects an out-of-schema
 * type, so a count there would be measuring a rule the request already enforced.
 *
 * @param argumentsJson - The model's tool-call argument string.
 * @param schema - The schema sent with the request.
 * @param ontology - The enforced declaration, or `undefined` for none.
 * @returns How many `type` positions fell outside the schema's `enum`s.
 */
function advisoryViolations(
  argumentsJson: string,
  schema: ToolSchema,
  ontology: Ontology | undefined,
): number {
  if (ontology === undefined || strictSchemaEnabled()) {
    return 0;
  }
  return countSchemaViolations(argumentsJson, schema);
}

/**
 * Reads the entities that took part in no relationship, enforcing if asked.
 *
 * Separate from the triplet parse because the two have different contracts: the
 * triplet path mirrors the oracle and must keep doing so, while `entities` is an
 * addition with no oracle behaviour to reproduce.
 */
function standaloneFor(
  argumentsJson: string,
  ontology: Ontology | undefined,
): readonly StandaloneEntity[] {
  const parsed = parseStandaloneEntities(argumentsJson);
  return ontology === undefined ? parsed : admitStandaloneEntities(parsed, ontology);
}

/**
 * Folds one endpoint into the entity map.
 *
 * Both endpoints of a triplet become entities; the oracle does the same, which is
 * why `entities_extracted` counts nodes, not triplet subjects.
 */
function absorbEndpoint(
  entityMap: Map<string, ExtractedEntity>,
  name: string,
  type: string,
  chunkIndex: number,
): void {
  const key = name.trim().toLowerCase();
  const existing = entityMap.get(key);
  if (existing === undefined) {
    entityMap.set(key, {
      name,
      type,
      description: "",
      confidence: EXTRACTED_CONFIDENCE,
      sourceChunkIndices: [chunkIndex],
    });
    return;
  }
  if (EXTRACTED_CONFIDENCE > existing.confidence) {
    existing.description = "";
    existing.confidence = EXTRACTED_CONFIDENCE;
    existing.type = type;
  }
  existing.sourceChunkIndices.push(chunkIndex);
}

/** Folds both endpoints of one triplet into the entity map. */
function absorbEndpoints(
  entityMap: Map<string, ExtractedEntity>,
  triplet: Triplet,
  chunkIndex: number,
): void {
  absorbEndpoint(entityMap, triplet.subjectName, triplet.subjectType, chunkIndex);
  absorbEndpoint(entityMap, triplet.objectName, triplet.objectType, chunkIndex);
}

/** One triplet as an extracted relationship. */
function tripletRelationship(
  triplet: Triplet,
  chunkIndex: number,
): ExtractedRelationship {
  return {
    fromEntityName: triplet.subjectName,
    toEntityName: triplet.objectName,
    // Consolidation lowercases this again; keeping the uppercase form here
    // matches the Python value that reaches it.
    type: triplet.relationType,
    description: "",
    confidence: EXTRACTED_CONFIDENCE,
    sourceChunkIndices: [chunkIndex],
  };
}

/** The dedupe key: endpoints and type, case-insensitively, NUL-separated. */
function relationshipKey(relationship: ExtractedRelationship): string {
  return [
    relationship.fromEntityName.toLowerCase(),
    relationship.type.toLowerCase(),
    relationship.toEntityName.toLowerCase(),
  ].join("\u0000");
}

/** Merges duplicate relationships, keeping the highest confidence per key. */
function mergeRelationships(
  relationships: readonly ExtractedRelationship[],
): Map<string, ExtractedRelationship> {
  const merged = new Map<string, ExtractedRelationship>();
  for (const relationship of relationships) {
    const key = relationshipKey(relationship);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, relationship);
      continue;
    }
    if (relationship.confidence > existing.confidence) {
      existing.description = relationship.description;
      existing.confidence = relationship.confidence;
    }
    existing.sourceChunkIndices.push(...relationship.sourceChunkIndices);
  }
  return merged;
}

/**
 * Everything one extraction run accumulates across its chunks.
 *
 * Grouped rather than kept as five locals so the per-chunk fold can be its own
 * function: the fold is what a reader has to understand — it is where one
 * chunk's answer becomes entities, edges, and counters — and naming it is what
 * keeps `extractGraphFromChunks` a readable end-to-end sequence.
 */
interface ExtractionTally {
  readonly entities: Map<string, ExtractedEntity>;
  readonly relationships: ExtractedRelationship[];
  readonly rejected: RejectedTriplet[];
  readonly failures: unknown[];
  /** Chunks that answered with no usable envelope, however many they were. */
  mangledChunks: number;
  /** Type positions the model put outside the schema's `enum`s, on any chunk. */
  schemaViolations: number;
}

/** The tally every run starts from: nothing counted, nothing merged. */
function emptyTally(): ExtractionTally {
  return {
    entities: new Map(),
    relationships: [],
    rejected: [],
    failures: [],
    mangledChunks: 0,
    schemaViolations: 0,
  };
}

/**
 * Folds one chunk's output into the running tally.
 *
 * Order matters twice here: triplet endpoints are absorbed before standalone
 * entities, so the type a relationship already constrains wins the dedupe; and
 * a rejected triplet's rescued endpoints join the entity map LAST, because they
 * must contribute a node without ever contributing an edge.
 *
 * @param tally - The run so far; mutated in place.
 * @param batch - What one chunk contributed.
 * @param chunkIndex - The chunk's index, recorded on every row it produces.
 */
function foldBatch(tally: ExtractionTally, batch: ChunkOutput, chunkIndex: number): void {
  if (batch.failure !== undefined) tally.failures.push(batch.failure);
  // Counted separately from a failure on purpose: the provider answered, so the
  // remedy is the prompt or the parser, not the endpoint.
  if (batch.shapeMangled) tally.mangledChunks += 1;
  tally.schemaViolations += batch.schemaViolations;
  tally.rejected.push(...batch.rejected);
  for (const triplet of batch.triplets) {
    absorbEndpoints(tally.entities, triplet, chunkIndex);
    tally.relationships.push(tripletRelationship(triplet, chunkIndex));
  }
  // A standalone entity is absorbed by name, so a node the model reported in
  // both shapes stays one row. The triplet endpoints were absorbed first and
  // `absorbEndpoint` only rewrites a type when confidence strictly increases,
  // which it never does here — so the triplet's type wins, and it is the one a
  // relationship already constrains.
  for (const entity of batch.standalone) {
    absorbEndpoint(tally.entities, entity.name, entity.type, chunkIndex);
  }
  // Endpoints of relationship-only rejections. Both types were already checked
  // by the ontology, so nothing here needs filtering again; what they must NOT
  // do is produce a relationship, which is why they join the entity map only.
  for (const entity of batch.rescued) {
    absorbEndpoint(tally.entities, entity.name, entity.type, chunkIndex);
  }
}

export async function extractGraphFromChunks(
  chunks: readonly ChunkResult[],
  stackName: string,
  ontology?: Ontology,
): Promise<ExtractionResult> {
  if (chunks.length === 0) {
    return emptyResult();
  }

  const tally = emptyTally();
  for (const chunk of chunks) {
    foldBatch(tally, await chunkTriplets(chunk, stackName, ontology), chunk.chunkIndex);
  }

  // EVERY chunk failed: there is no partial result to protect, so this is an
  // outage rather than a thin extraction. Throwing here is what makes the kg
  // dimension's `prepare` fail, which is what stops the coordinator committing a
  // document whose graph is empty. Every failure travels with the error, so the
  // operator sees the endpoint and status rather than only a count.
  if (tally.failures.length === chunks.length) {
    throw new ProviderUnavailableError(
      `extraction failed for all ${chunks.length} chunk(s)`,
      tally.failures,
    );
  }

  return {
    entities: [...tally.entities.values()],
    relationships: [...mergeRelationships(tally.relationships).values()],
    model: extractionModel(),
    pipeline: EXTRACTION_PIPELINE,
    // Reported only when an ontology was enforced, so a default run keeps the
    // oracle's result shape instead of carrying a permanently empty array.
    ...(ontology === undefined ? {} : { rejected: tally.rejected }),
    // Absent when nothing failed, so the healthy path keeps the oracle's shape.
    ...(tally.failures.length === 0 ? {} : { failedChunks: tally.failures.length }),
    // Absent when every chunk's envelope was readable, for the same reason.
    ...(tally.mangledChunks === 0 ? {} : { mangledChunks: tally.mangledChunks }),
    // Absent when the model never left the declared schema -- which is every
    // strict-provider run, so that path's result shape does not move either.
    ...(tally.schemaViolations === 0 ? {} : { schemaViolations: tally.schemaViolations }),
  };
}