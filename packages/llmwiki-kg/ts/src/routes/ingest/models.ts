/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/models.ts
 * @description The `IngestionResult` response model and the request validators.
 *
 * Split out of `routes/ingest.ts` as its own unit because the FastAPI wire shapes
 * — including the field order that becomes the JSON key order — are a contract
 * the endpoint logic only consumes.
 */

import { z } from "zod";

import { pydanticBoolean, pydanticUuid } from "../../errors.js";


/**
 * `IngestionResult` — the response body, in Pydantic's declaration order.
 *
 * Declared here rather than in `dto.ts` because `dto.ts` is outside this slice's
 * edit surface. Field order is the response's JSON key order, and it matches the
 * oracle byte for byte.
 *
 * ## Where the degradation counters are, and why they are not here
 *
 * `mangledChunks` and `schemaViolations` are deliberately absent from this wire
 * shape: the nine keys above are the oracle contract, so the extraction run's
 * quality cannot travel on the response. It is recorded in the document's `audit`
 * blob instead — under the `extraction` section, optional and absent on a healthy
 * ingest — and read back through `GET /stacks/:stackId/documents/:doc_id`. A
 * caller that wants to know whether a small `entities_extracted` was a thin
 * document or an impaired run must read that, not this.
 */
export const IngestionResult = z.object({
  document_id: pydanticUuid(),
  chunks_created: z.number().int(),
  entities_extracted: z.number().int(),
  entities_in_stack: z.number().int(),
  relationships_extracted: z.number().int(),
  relationships_written: z.number().int(),
  relationships_in_stack: z.number().int(),
  truncated: z.boolean(),
  descriptions_synthesized: z.boolean(),
});

/** The response payload, derived from {@link IngestionResult} so they cannot drift. */
export type IngestionResultDto = z.infer<typeof IngestionResult>;

/**
 * `CompileResult` — the response body of `POST .../compile`, in declaration order.
 *
 * ## Why it is NOT `IngestionResult`
 *
 * A compile and an ingest report different work, and two of the ingest keys would have
 * to lie to fit:
 *
 * - there is no `chunks_created`, because a compile creates no chunk. `chunks_read`
 *   replaces it and counts the stored `document_chunks` rows the run extracted from,
 *   which is the number a reader actually wants after phase two.
 * - there is no `truncated`, because truncation is a READ-STAGE fact: it is measured
 *   when the document body is loaded and cut to the extraction limit. A compile never
 *   loads the body, so it could only report a constant, and a constant on a wire shape
 *   is worse than an absent key.
 *
 * The remaining seven keys keep the meaning they have on the ingest response, and
 * `entities_in_stack` / `relationships_in_stack` are counted after consolidation, so
 * they include this run.
 */
export const CompileResult = z.object({
  document_id: pydanticUuid(),
  chunks_read: z.number().int(),
  entities_extracted: z.number().int(),
  entities_in_stack: z.number().int(),
  relationships_extracted: z.number().int(),
  relationships_written: z.number().int(),
  relationships_in_stack: z.number().int(),
  descriptions_synthesized: z.boolean(),
});

/** The compile response payload, derived from {@link CompileResult} so they cannot drift. */
export type CompileResultDto = z.infer<typeof CompileResult>;

/**
 * `CompilePlan` — the response body of a `dry_run` compile, in declaration order.
 *
 * ## Why it is NOT `CompileResult`
 *
 * A plan describes work that has NOT happened. Reusing the compile result shape would
 * have forced five fields to lie: `chunks_read` would report chunks nobody extracted,
 * and `entities_extracted`, `entities_in_stack`, `relationships_*` and
 * `descriptions_synthesized` would all be zeroes that read like a run which found
 * nothing. A caller could not tell a cheap plan from an empty compile, which is exactly
 * the confusion this repository keeps finding.
 *
 * So the plan is its own shape and carries only what it can honestly report:
 *
 * - `dry_run` — always `true`. A literal rather than a boolean, because a payload that
 *   can say `false` can be mistaken for a completion.
 * - `planned_chunks` — the stored `document_chunks` rows this run would extract from.
 * - `planned_chat_requests` — the chat requests that implies BEFORE RETRIES. Extraction
 *   sends one chat request per chunk, so it equals `planned_chunks`; it is reported
 *   separately because the equal sign is a property of the extraction step, not of the
 *   chunk count, and a future change to how chunks are batched has exactly one place to
 *   show up. A real run can issue MORE than this: `withProviderRetry` retries a transient
 *   failure up to `TRANSIENT_ATTEMPTS` (3) times, so the bill can be up to three times
 *   the plan. The cap bounds planned requests, not the final number of requests sent.
 * - `cap` — the bound in force for this deployment, so the comparison is auditable
 *   without knowing how the environment is configured.
 * - `would_refuse` — what the real run would do, obtained by asking the cap module's own
 *   `assertWithinExtractionRequestCap` about `planned_chunks` and `cap` and catching its
 *   refusal, so the plan and the real run cannot disagree about the boundary.
 */
export const CompilePlan = z.object({
  dry_run: z.literal(true),
  planned_chunks: z.number().int(),
  planned_chat_requests: z.number().int(),
  cap: z.number().int(),
  would_refuse: z.boolean(),
});

/** The dry-run payload, derived from {@link CompilePlan} so they cannot drift. */
export type CompilePlanDto = z.infer<typeof CompilePlan>;

/** Path-parameter validator for `:stackId`, keyed by the parameter name. */
export const StackIdParams = z.object({ stackId: pydanticUuid() });

/** Path-parameter validator for `:doc_id`. */
export const DocIdParams = z.object({ doc_id: pydanticUuid() });

/**
 * Query-parameter validator for `synthesize_descriptions`.
 *
 * `Optional[bool] = Query(None)`: absent is `undefined`, and any present value
 * must be a boolean Pydantic can parse. Measured: `""` and `"maybe"` both answer
 * `bool_parsing`; `"true"`/`"false"` pass. A repeated parameter takes the
 * **last** value, which is what Express's query parser hands over as an array,
 * and what Starlette's `getlist(...)[-1]`-equivalent behaviour yields — measured
 * with `?synthesize_descriptions=true&synthesize_descriptions=false` and the
 * reverse order.
 */
/** The three admission contracts this endpoint offers, in the option's own spelling. */
export const INGEST_CONTRACTS = ["open", "strict", "persist"] as const;

/**
 * Query-parameter validator for `ontology_contract`.
 *
 * ## What it selects, and why it is named this way
 *
 * It selects the extraction ADMISSION CONTRACT, using the vocabulary the
 * programmatic option already uses (`ExtractionOptions.contract`, whose three values
 * are exactly `open`, `strict` and `persist`). That reuse is the point: there is one
 * meaning of "strict" in this package and this parameter does not invent a second one.
 *
 * The three sit on ONE axis — what happens to a triplet the ontology turns away — so
 * every value below names an answer rather than a feature:
 *
 * - absent, or `open` — the DEFAULT, and the behaviour the ingest endpoint has had
 *   since the open contract landed. The Stack's declaration ORIENTS the extraction: a
 *   candidate the catalog does not name is kept with the type and predicate the model
 *   proposed (S1, S7). Nothing is refused, so there is no second class to write.
 * - `strict` — the previous pipeline's behaviour, restored as an explicit opt-in. The
 *   declaration is an ADMISSION FILTER: a triplet whose entity type or predicate it
 *   does not name is dropped, counted in the document's `audit.ontology` section, and
 *   no `audit.open` section is written because nothing was kept against the catalog.
 * - `persist` — the declaration is enforced exactly as `strict` enforces it, and the
 *   triplet it turns away is KEPT. Both classes are stored with their class, their
 *   reason and the refused type, so the graph answers what the ontology decided instead
 *   of leaving the refusal unreadable. This is the contract the wiki `kg` dimension
 *   already behaves like, which is why it is nameable from this endpoint at all.
 *
 * The default is `open` on purpose. Openness is what S1 and S7 require of ingestion, so
 * a closed graph has to be asked for; a default that closed it would silently discard
 * supported knowledge from every Stack that never mentions this parameter.
 *
 * Anything else is a 422 in the query section, in the shape FastAPI gives a `Literal`
 * parameter — the endpoint already answers query failures that way.
 */
export const OntologyContractQuery = z.enum(INGEST_CONTRACTS);

export const IngestQuery = z.object({
  synthesize_descriptions: pydanticBoolean().optional(),
  ontology_contract: OntologyContractQuery.optional(),
});

/**
 * Query-parameter validator for `dry_run` — the COMPILE route's own override.
 *
 * ## Why this is NOT in {@link IngestQuery}
 *
 * It was, and that was a contract defect: both routes share `parseIngestRequest`, so
 * declaring the flag there made `POST .../ingest?dry_run=maybe` answer `422` where it has
 * always answered `200` — an unrequested behaviour change on an existing public route.
 * `dry_run` is a compile override, so it is validated on the COMPILE route alone (see
 * `parseDryRun` in `compile.ts`) and ingest answers exactly as it did before the flag
 * existed, for every value of it, garbage included.
 *
 * It accepts what `synthesize_descriptions` accepts (`1`/`true`/`0`/`false`) and refuses
 * anything else in the same query section of the same `422`, reported AFTER the ingest
 * parameters so the order stays `synthesize_descriptions`, `ontology_contract`, `dry_run`.
 */
export const CompileQuery = z.object({
  dry_run: pydanticBoolean().optional(),
});
