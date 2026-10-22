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

/** Path-parameter validator for `:stack_id`, keyed by the FastAPI parameter name. */
export const StackIdParams = z.object({ stack_id: pydanticUuid() });

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
export const IngestQuery = z.object({
  synthesize_descriptions: pydanticBoolean().optional(),
});
