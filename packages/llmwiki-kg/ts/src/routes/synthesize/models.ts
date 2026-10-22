/**
 * @file packages/llmwiki-kg/ts/src/routes/synthesize/models.ts
 * @description Pydantic models and path-parameter validators for synthesis.
 *
 * Split out of `routes/synthesize.ts` as its own unit because the FastAPI body
 * contract — including the `missing` and `model_attributes_type` envelopes — is
 * a wire-shape concern both endpoints share, and it is what the 422 tests pin.
 */

import { z } from "zod";

import {
  pydanticBoolean,
  pydanticInt,
  pydanticString,
  pydanticUuid,
} from "../../errors.js";
import type { PydanticErrorDetail } from "../../errors.js";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** `BackfillRequest` — the optional filters for a backfill run. */
export const BackfillRequest = z.object({
  // `Optional[list[UUID]] = None`: absent and explicit `null` both mean "every
  // entity", so `.nullable()` comes before `.default(null)`.
  entity_ids: z.array(pydanticUuid()).nullable().default(null),
  // `bool = True` — the default is what makes an empty body a full backfill.
  only_missing: pydanticBoolean().default(true),
});

/** `BackfillResult` — mirrors the Pydantic model's field order. */
export const BackfillResult = z.object({
  stack_id: pydanticUuid(),
  entities_considered: pydanticInt(),
  entities_synthesized: pydanticInt(),
  entities_skipped: pydanticInt(),
});

/** Response for `POST /aks/v1/entities/{name}/synthesize-description`. */
export const SynthesizeOneResult = z.object({
  entity_name: pydanticString(),
  description: pydanticString().nullable(),
  synthesized: pydanticBoolean(),
});

/** FastAPI's body-level `missing` entry, when no body was sent at all. */
export const MISSING_BODY: PydanticErrorDetail = {
  type: "missing",
  loc: ["body"],
  msg: "Field required",
  input: null,
};

/**
 * FastAPI's body-level `model_attributes_type` entry, for a body Pydantic could
 * not read as a model.
 *
 * `input` is the offending value: the parsed JSON (`null`, `5`, `[]`) or, when no
 * JSON parser claimed the body, the **raw text** — measured:
 * `text/plain '{}'` answers `input: "{}"`.
 */
export function modelAttributesType(
  input: unknown,
  loc: readonly (string | number)[],
): PydanticErrorDetail {
  // Key order is `type, loc, msg, input`, matching every entry `toFastApiValidationError`
  // produces. Reordering them here would make this one body differ from the rest
  // of the app on the wire, which a byte-diff harness reads as a contract break.
  return {
    type: "model_attributes_type",
    loc: [...loc],
    msg: "Input should be a valid dictionary or object to extract fields from",
    input,
  };
}

/** Path-parameter validator for `{stack_id}`. */
export const StackIdParams = z.object({ stack_id: pydanticUuid() });

/** Path-parameter validator for `{name}`. */
export const EntityNameParams = z.object({ name: pydanticString() });
