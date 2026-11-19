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
import {
  buildExtractionPrompt,
  buildOpenExtractionPrompt,
  buildOpenToolSchema,
  buildToolSchema,
  type ToolSchema,
  type TripletBudgetOptions,
  type TripletTruncation,
} from "./graph-prompt.js";
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
  type ClassifiedEndpoint,
  type Ontology,
  type OntologyClassification,
  type RejectedTriplet,
  type RejectedTripletDetail,
} from "./ontology.js";
import {
  OpenAdmissionError,
  admitOpenTriplets,
  type CatalogMismatch,
  type OpenRejection,
} from "./open-admission.js";
import {
  EXTRACTED_CONFIDENCE,
  EXTRACTION_PIPELINE,
  type ChunkResult,
  type ExtractedEntity,
  type ExtractedRelationship,
  type ExtractionResult,
} from "./extraction-types.js";

/** The result for a document that produced no chunks. */
function emptyResult(): ExtractionOutcome {
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

/**
 * Which admission contract the extractor asks the model with.
 *
 * - `strict`  the legacy contract: the caller's declaration is enforced, so a
 *   triplet outside it is dropped and reported. This is the DEFAULT, because it is
 *   the oracle-parity behaviour every existing caller and suite depends on.
 * - `open`    the open contract: the declaration is orientation, so a candidate
 *   the catalog does not name is ADMITTED with the type and predicate the model
 *   proposed. The ingest pipeline selects this one explicitly.
 * - `persist` the enforcing contract that KEEPS what it refuses: the declaration is
 *   enforced exactly as `strict` enforces it, and the triplet is then stored with its
 *   class, its reason and the refused type instead of being dropped, so BOTH classes
 *   reach the graph. This is what the wiki `kg` dimension already does with no contract
 *   named, and the reason the value exists: the same document through both entry points
 *   must produce the same classes.
 *
 * The three sit on ONE axis — what happens to a triplet the ontology turns away. `open`
 * takes no verdict, `strict` takes it and refuses the triplet, `persist` takes it and
 * keeps it. So `persist` needs no third code path: it falls through the open-only guard
 * in {@link chunkTriplets} and runs the enforcing path, deliberately.
 *
 * The default stays `strict` on purpose. A function whose default silently changed
 * would move the behaviour of every caller nobody audited, and a default the
 * production path does not use is a trap in the other direction — so the pipeline
 * names `open` at its call site, which is where the choice belongs.
 */
export type ExtractionContract = "strict" | "open" | "persist";

/** Everything only an open run can report about what it answered. */
export interface OpenExtractionReport {
  /** Proposals the catalog does not name, KEPT with the model's own wording (S7). */
  readonly outsideCatalog?: readonly CatalogMismatch[];
  /** Triplets refused because they were not facts at all, never for the catalog. */
  readonly structuralRejections?: readonly OpenRejection[];
  /** Per-chunk caps that dropped something, so a bounded answer reads as bounded (S9). */
  readonly truncations?: readonly TripletTruncation[];
}

/** What {@link extractGraphFromChunks} returns: the oracle's result plus an open run's report. */
export interface ExtractionOutcome
  extends Omit<ExtractionResult, "entities" | "relationships">,
    OpenExtractionReport {
  readonly entities: ClassifiedEntity[];
  readonly relationships: ClassifiedRelationship[];
}

/**
 * An extracted node plus the ontology class its row must carry.
 *
 * Every entity this module produces carries one, including the ones nothing is wrong
 * with. That is deliberate and not ceremony: the column is `not null default
 * 'accepted'`, so a node whose class was never decided would be stored as accepted by
 * omission — the shape a reader could not tell from a real admission.
 */
export interface ClassifiedEntity extends ExtractedEntity, OntologyClassification {}

/** An extracted edge plus the ontology class its row must carry. */
export interface ClassifiedRelationship
  extends ExtractedRelationship,
    OntologyClassification {}

/** How one extraction run is asked: which contract, and how much one chunk may cost. */
export interface ExtractionOptions extends TripletBudgetOptions {
  /**
   * The admission contract — `strict`, `open` or `persist`; defaults to `strict`, the
   * oracle-parity behaviour.
   */
  readonly contract?: ExtractionContract;
}

/** What one open chunk contributed beyond the legacy triplets and entities. */
interface OpenChunkExtras {
  readonly outsideCatalog: readonly CatalogMismatch[];
  readonly rejections: readonly OpenRejection[];
  readonly truncation: TripletTruncation | undefined;
}

/** What one chunk contributed: admitted triplets, what was dropped, and nodes. */
interface ChunkOutput {
  readonly triplets: readonly Triplet[];
  readonly rejected: readonly RejectedTriplet[];
  readonly standalone: readonly StandaloneEntity[];
  /**
   * The rejected triplets of this chunk, paired with the rows they must produce.
   *
   * Empty on the open contract, which refuses nothing for the declaration's sake, and
   * empty on a run without an ontology. Present so the fold can write what the verdict
   * decided instead of counting it and discarding it (S1). The endpoints of these
   * triplets travel inside them, each with its own class, so there is no second channel
   * for the same nodes that could disagree with this one.
   */
  readonly rejectedDetails: readonly RejectedTripletDetail[];
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
  /** What only an open run reports; absent on a strict run, whose shape is unchanged. */
  readonly open?: OpenChunkExtras;
}

/** An answer carrying either a result or the reason there is none. */
function emptyOutput(failure?: unknown): ChunkOutput {
  return {
    triplets: [],
    rejected: [],
    standalone: [],
    rejectedDetails: [],
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
  options: ExtractionOptions,
): Promise<ChunkOutput> {
  // A negative guard, not a switch: only `open` leaves the enforcing path. `persist`
  // deliberately falls through here — it enforces the declaration like `strict` does,
  // and its refused rows travel on so both classes are stored with their reason.
  if (options.contract === "open" && ontology !== undefined) {
    return openChunkTriplets(chunk, stackName, ontology, options);
  }
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
        rejectedDetails: [],
        shapeMangled,
        schemaViolations,
      };
    }
    const parsed = parseTripletsWithOntology(argumentsJson, ontology);
    return {
      triplets: parsed.triplets,
      rejected: parsed.rejected,
      standalone,
      // The triplets travel on so their EDGE becomes a row too, and their endpoints'
      // classes travel with them.
      rejectedDetails: parsed.rejectedTriplets,
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
 * Asks the model for one chunk's answer under the OPEN contract.
 *
 * Three differences from the strict path above, and nothing else:
 *
 * 1. the prompt and the tool schema offer the catalog as orientation
 *    ({@link buildOpenExtractionPrompt}, {@link buildOpenToolSchema}), so the model
 *    is never told a type it proposes is illegal;
 * 2. admission keeps every structurally valid candidate and reports what the
 *    catalog does not name instead of dropping it ({@link admitOpenTriplets});
 * 3. the per-chunk budget's truncation record travels with the answer instead of
 *    being discarded, because a capped answer must be legible as capped (S9).
 *
 * `schemaViolations` is 0 by construction: the open schema declares no `enum` for
 * a type position to fall outside of. That is not a missing counter — it is the
 * same reason `advisoryViolations` returns 0 when no ontology is supplied.
 *
 * `OpenAdmissionError` is rethrown rather than absorbed: it means this module and
 * the oracle-parity parser disagreed about an answer, which is a bug here and must
 * not be laundered into "the provider failed for this chunk".
 */
async function openChunkTriplets(
  chunk: ChunkResult,
  stackName: string,
  ontology: Ontology,
  options: ExtractionOptions,
): Promise<ChunkOutput> {
  const prompt = buildOpenExtractionPrompt(chunk.content, chunk.chunkIndex, stackName, ontology, options);
  const schema = buildOpenToolSchema(ontology);
  try {
    const argumentsJson = await withProviderRetry(() => callTool(prompt, schema));
    const admitted = admitOpenTriplets(argumentsJson, ontology, {
      chunkIndex: chunk.chunkIndex,
      ...(options.maxTripletsPerChunk === undefined
        ? {}
        : { maxTripletsPerChunk: options.maxTripletsPerChunk }),
    });
    return {
      triplets: admitted.triplets,
      // The declaration turned nothing away: what it does not name is reported in
      // `open.outsideCatalog` as KEPT.
      rejected: [],
      // The rescued endpoints of the open contract were never in a rejected triplet:
      // the scan refused them for structure, and the declaration admitted the rest.
      standalone: [...admitted.entities, ...admitted.rescued],
      rejectedDetails: [],
      shapeMangled: isShapeMangled(argumentsJson),
      schemaViolations: 0,
      open: {
        outsideCatalog: admitted.outsideCatalog,
        rejections: admitted.rejected,
        truncation: admitted.truncation,
      },
    };
  } catch (error) {
    if (error instanceof OpenAdmissionError) throw error;
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
 * The row-level class of one endpoint, named the way the three columns are.
 *
 * The single place an endpoint's verdict becomes a row's verdict, so the two tables
 * cannot be fed by two different conventions: `rejected` always carries its reason and
 * the refused type, because a rejected row without a reason is refused by the
 * `ontology_rejection_reason_requires_rejected` CHECK and a refused type left off the
 * row would reduce the reason to a boolean.
 *
 * @param endpoint - One endpoint with the class the ontology gave it.
 * @returns The class to store, ready to spread onto the row.
 */
function classificationOf(endpoint: ClassifiedEndpoint): OntologyClassification {
  return endpoint.verdict === "accepted"
    ? { ontologyVerdict: "accepted" }
    : {
        ontologyVerdict: "rejected",
        ontologyRejectionReason: endpoint.reason,
        ontologyOffendingType: endpoint.type,
      };
}

/**
 * Folds one endpoint into the entity map, with the class its row must carry.
 *
 * Both endpoints of a triplet become entities; the oracle does the same, which is why
 * `entities_extracted` counts nodes, not triplet subjects. A rejected triplet's
 * endpoints arrive here too, and they are the reason the class is a required argument:
 * an endpoint whose class was never decided would reach the column's own default and be
 * stored as accepted, which is exactly the mistake a reader could not detect.
 *
 * ## A name the ontology admitted is not downgraded
 *
 * One name can be mentioned many times in a document, and only some of those mentions
 * may be at fault. An admitted mention therefore WINS: it supplies the declared type and
 * repairs a rejected row, while a rejected mention never overwrites an accepted one.
 * The reason is deleted with the verdict, not left beside it — the equivalence CHECK
 * refuses a reason on an accepted row.
 */
function absorbEndpoint(
  entityMap: Map<string, ClassifiedEntity>,
  endpoint: ClassifiedEndpoint,
  chunkIndex: number,
): void {
  const key = endpoint.name.trim().toLowerCase();
  const existing = entityMap.get(key);
  if (existing === undefined) {
    entityMap.set(key, {
      name: endpoint.name,
      type: endpoint.type,
      description: "",
      confidence: EXTRACTED_CONFIDENCE,
      sourceChunkIndices: [chunkIndex],
      ...classificationOf(endpoint),
    });
    return;
  }
  if (EXTRACTED_CONFIDENCE > existing.confidence) {
    existing.description = "";
    existing.confidence = EXTRACTED_CONFIDENCE;
    existing.type = endpoint.type;
  }
  if (existing.ontologyVerdict === "rejected" && endpoint.verdict === "accepted") {
    existing.type = endpoint.type;
    existing.ontologyVerdict = "accepted";
    delete existing.ontologyRejectionReason;
    delete existing.ontologyOffendingType;
  }
  existing.sourceChunkIndices.push(chunkIndex);
}

/** Folds both endpoints of an admitted triplet into the entity map. */
function absorbEndpoints(
  entityMap: Map<string, ClassifiedEntity>,
  triplet: Triplet,
  chunkIndex: number,
): void {
  absorbEndpoint(
    entityMap,
    { name: triplet.subjectName, type: triplet.subjectType, verdict: "accepted" },
    chunkIndex,
  );
  absorbEndpoint(
    entityMap,
    { name: triplet.objectName, type: triplet.objectType, verdict: "accepted" },
    chunkIndex,
  );
}

/** One triplet as an extracted relationship, carrying its class. */
function tripletRelationship(
  triplet: Triplet,
  chunkIndex: number,
  classification: OntologyClassification,
): ClassifiedRelationship {
  return {
    fromEntityName: triplet.subjectName,
    toEntityName: triplet.objectName,
    // Consolidation lowercases this again; keeping the uppercase form here
    // matches the Python value that reaches it.
    type: triplet.relationType,
    // The verb the model read, byte for byte after a trim. It travels beside the
    // folded label so the stored `predicate` keeps its original wording (S2, S31)
    // while identity, dedup and the `type` projection keep using the fold.
    predicate: triplet.rawRelationType,
    description: "",
    confidence: EXTRACTED_CONFIDENCE,
    sourceChunkIndices: [chunkIndex],
    ...classification,
  };
}

/** The dedupe key: endpoints and type, case-insensitively, NUL-separated. */
function relationshipKey(relationship: ExtractedRelationship): string {
  // Keyed on the FOLDED label, deliberately: two spellings of one verb are one
  // relationship, and the merged entry keeps the first spelling's raw predicate.
  // The class is NOT part of the key: `unique_edge_per_stack` admits one row per
  // identity, so the two classes of a collision cannot both persist.
  return [
    relationship.fromEntityName.toLowerCase(),
    relationship.type.toLowerCase(),
    relationship.toEntityName.toLowerCase(),
  ].join("\u0000");
}

/**
 * Merges duplicate relationships, keeping the highest confidence per key.
 *
 * ## ACCEPTED WINS: a collision is resolved, never decided by fold order
 *
 * `unique_edge_per_stack (stack_id, from_entity_id, to_entity_id, type)` — the constraint
 * the migration KEPT rather than replaced — admits ONE row per identity, so an accepted
 * triplet and a rejected one naming the same subject, relation and object cannot both
 * persist. Which class survives must therefore be a rule:
 *
 * 1. **An acceptance beats a rejection in either direction.** `absorbEndpoint` already
 *    repairs a node the same way; here the edge's reason and refused type are DELETED
 *    with the verdict, because `ontology_rejection_reason_requires_rejected` refuses a
 *    reason on an accepted row, so clearing the class without clearing the prose would
 *    be an update the CHECK rejects.
 * 2. **A collision between two rejections keeps the FIRST one.** `merged` is fed in
 *    extraction order and a kept rejection is never rewritten below, so the survivor is
 *    the first refusal the document produced — never whichever record a `Map` happened
 *    to yield, which a `for…of` over the merged entries would have made unstable.
 *
 * Fold order alone would give the right answer only by luck: this module folds a chunk's
 * admitted triplets before its refusals, so "accepted then rejected" survives and
 * "rejected then accepted" silently stores the refusal. That asymmetry is what this
 * function removes.
 */
function mergeRelationships(
  relationships: readonly ClassifiedRelationship[],
): Map<string, ClassifiedRelationship> {
  const merged = new Map<string, ClassifiedRelationship>();
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
    if (relationship.ontologyVerdict === "accepted" && existing.ontologyVerdict === "rejected") {
      existing.ontologyVerdict = "accepted";
      delete existing.ontologyRejectionReason;
      delete existing.ontologyOffendingType;
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
  readonly entities: Map<string, ClassifiedEntity>;
  readonly relationships: ClassifiedRelationship[];
  readonly rejected: RejectedTriplet[];
  readonly failures: unknown[];
  /** Chunks that answered with no usable envelope, however many they were. */
  mangledChunks: number;
  /** Type positions the model put outside the schema's `enum`s, on any chunk. */
  schemaViolations: number;
  /** Open runs only: proposals kept although the catalog does not name them. */
  outsideCatalog: CatalogMismatch[];
  /** Open runs only: triplets refused for being structurally incomplete. */
  structuralRejections: OpenRejection[];
  /** Open runs only: every per-chunk cap that dropped something. */
  truncations: TripletTruncation[];
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
    outsideCatalog: [],
    structuralRejections: [],
    truncations: [],
  };
}

/**
 * Folds one chunk's output into the running tally.
 *
 * Order matters three times here: triplet endpoints are absorbed before standalone
 * entities, so the type a relationship already constrains wins the dedupe; the open
 * contract's rescued endpoints follow the entities they came beside, as they always
 * did; and a rejected triplet is folded LAST, so when the same name or the same edge
 * identity is both admitted and refused within one chunk, the admitted record reaches
 * the merge first.
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
  if (batch.open !== undefined) {
    tally.outsideCatalog.push(...batch.open.outsideCatalog);
    tally.structuralRejections.push(...batch.open.rejections);
    if (batch.open.truncation !== undefined) tally.truncations.push(batch.open.truncation);
  }
  tally.rejected.push(...batch.rejected);
  for (const triplet of batch.triplets) {
    absorbEndpoints(tally.entities, triplet, chunkIndex);
    tally.relationships.push(
      tripletRelationship(triplet, chunkIndex, { ontologyVerdict: "accepted" }),
    );
  }
  // A standalone entity is absorbed by name, so a node the model reported in
  // both shapes stays one row. The triplet endpoints were absorbed first and
  // `absorbEndpoint` only rewrites a type when confidence strictly increases,
  // which it never does here — so the triplet's type wins, and it is the one a
  // relationship already constrains.
  for (const entity of batch.standalone) {
    absorbEndpoint(
      tally.entities,
      { name: entity.name, type: entity.type, verdict: "accepted" },
      chunkIndex,
    );
  }
  // A triplet the ontology refused used to stop at this line: the count grew and the
  // rows never existed. Under two classes it is written like any other — both endpoints
  // with their own classes, and the EDGE with the verdict and the specific reason — and
  // it is folded LAST so an admitted mention of the same name or identity is seen first.
  for (const detail of batch.rejectedDetails) {
    for (const endpoint of detail.endpoints) {
      absorbEndpoint(tally.entities, endpoint, chunkIndex);
    }
    tally.relationships.push(
      tripletRelationship(detail.triplet, chunkIndex, {
        ontologyVerdict: "rejected",
        ontologyRejectionReason: detail.rejection.reason,
        ontologyOffendingType: detail.rejection.offendingType,
      }),
    );
  }
}

export async function extractGraphFromChunks(
  chunks: readonly ChunkResult[],
  stackName: string,
  ontology?: Ontology,
  options: ExtractionOptions = {},
): Promise<ExtractionOutcome> {
  if (chunks.length === 0) {
    return emptyResult();
  }

  const tally = emptyTally();
  for (const chunk of chunks) {
    foldBatch(tally, await chunkTriplets(chunk, stackName, ontology, options), chunk.chunkIndex);
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
    // Absent when the catalog named every proposal, so a run that stayed inside
    // its vocabulary keeps the strict path's exact shape. Present only on an open
    // run that kept something the catalog does not name (S7).
    ...(tally.outsideCatalog.length === 0 ? {} : { outsideCatalog: tally.outsideCatalog }),
    // Absent when nothing was refused for structure -- the common case, and the
    // only refusal an open run makes.
    ...(tally.structuralRejections.length === 0
      ? {}
      : { structuralRejections: tally.structuralRejections }),
    // Absent when no per-chunk cap dropped anything (S9).
    ...(tally.truncations.length === 0 ? {} : { truncations: tally.truncations }),
  };
}