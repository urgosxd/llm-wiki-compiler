/**
 * @file packages/llmwiki-kg/ts/src/pydantic/wire.ts
 * @description FastAPI's error wire shapes.
 *
 * These types are the contract the HTTP layer emits: `{"detail": [...]}` with a
 * `loc` array per issue. Kept apart from the primitives and the mapper so a
 * route can type an error response without importing Zod at all.
 */

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** Where a value came from; FastAPI prefixes every `loc` array with it. */
export type LocPrefix = "body" | "path" | "query";

/** One entry of FastAPI's `422 {"detail": [...]}` array. */
export interface PydanticErrorDetail {
  readonly type: string;
  readonly loc: (string | number)[];
  readonly msg: string;
  /**
   * The offending value exactly as received. For `missing` this is the *parent*
   * object (or `null` for path/query) — see {@link missingInput}.
   */
  readonly input: unknown;
  readonly ctx?: Record<string, unknown>;
}

/** FastAPI's validation-failure envelope. */
export interface ValidationFailure {
  readonly status: 422;
  readonly body: { readonly detail: PydanticErrorDetail[] };
}

/** FastAPI's ordinary error envelope: one `detail` string, not an array. */
export interface ApiError {
  readonly status: number;
  readonly body: { readonly detail: string };
}

/**
 * Non-validation error helper. FastAPI renders `HTTPException` as
 * `{"detail": "<message>"}`, which is structurally different from the 422 array
 * above; 400/404/409 all use this shape.
 */
export function apiError(status: number, detail: string): ApiError {
  return { status, body: { detail } };
}
