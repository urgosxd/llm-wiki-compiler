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
/** The two admission contracts this endpoint offers, in the option's own spelling. */
export const INGEST_CONTRACTS = ["open", "strict"] as const;

/**
 * Query-parameter validator for `ontology_contract`.
 *
 * ## What it selects, and why it is named this way
 *
 * It selects the extraction ADMISSION CONTRACT, using the vocabulary the
 * programmatic option already uses (`ExtractionOptions.contract`, whose two values
 * are exactly `open` and `strict`). That reuse is the point: there is one meaning of
 * "strict" in this package and this parameter does not invent a second one.
 *
 * - absent, or `open` — the DEFAULT, and the behaviour the ingest endpoint has had
 *   since the open contract landed. The Stack's declaration ORIENTS the extraction: a
 *   candidate the catalog does not name is kept with the type and predicate the model
 *   proposed (S1, S7).
 * - `strict` — the previous pipeline's behaviour, restored as an explicit opt-in. The
 *   declaration is an ADMISSION FILTER: a triplet whose entity type or predicate it
 *   does not name is dropped, counted in the document's `audit.ontology` section, and
 *   no `audit.open` section is written because nothing was kept against the catalog.
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
