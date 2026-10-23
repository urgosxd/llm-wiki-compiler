/**
 * @file packages/llmwiki-kg/ts/src/errors.ts
 * @description Pydantic/FastAPI compatibility layer for Zod — public surface.
 *
 * This module was split into `src/pydantic/` to keep each file under the
 * project's size limits. It remains the single import site so no caller has to
 * know the internal layout:
 *
 * | Concern | Module |
 * | --- | --- |
 * | FastAPI wire shapes (`detail`, `loc`, `ApiError`) | `pydantic/wire.ts` |
 * | Pydantic error vocabulary + issue plumbing | `pydantic/pydantic-meta.ts` |
 * | UUID text parsing that accepts what Pydantic accepts | `pydantic/uuid-text.ts` |
 * | The Zod primitives | `pydantic/primitives.ts` |
 * | `ZodError` → FastAPI 422 body | `pydantic/mapper.ts` |
 *
 * ## Why the primitives are not plain `z.string()` / `z.number()`
 *
 * Zod and Pydantic disagree in ways a mapper alone cannot repair, because the
 * information is already gone by the time Zod's issue exists. See
 * `pydantic/primitives.ts` for the specifics.
 *
 * ## Nullability lives at the call site, not here
 *
 * Every primitive rejects `null` with the Pydantic *type* error and rejects a
 * missing key as `missing`. Adding `.nullable()` at the call site reproduces
 * `Optional[X]`. `Optional[X] = None` is `.nullable().default(null)`. That
 * distinction is load-bearing and must not be collapsed.
 *
 * ## Timestamps
 *
 * There is no `datetime` primitive on purpose: those fields are validated as
 * strings, because `Date` holds milliseconds while Postgres and Pydantic carry
 * microseconds. See `db.ts` and `odd/findings/timestamp-precision.md`.
 */

export type { LocPrefix, PydanticErrorDetail, ValidationFailure, ApiError } from "./pydantic/wire.js";
export { apiError } from "./pydantic/wire.js";

export {
  pydanticString,
  pydanticInt,
  pydanticFloat,
  pydanticBoolean,
  pydanticDict,
} from "./pydantic/primitives.js";
export type { StringOptions, NumberOptions } from "./pydantic/primitives.js";

export { pydanticUuid } from "./pydantic/uuid-text.js";

export { toFastApiValidationError } from "./pydantic/mapper.js";
