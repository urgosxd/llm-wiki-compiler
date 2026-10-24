import { sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { requireApiKey, type ApiKeyMiddleware } from "../auth.js";
import {
  withRequestTransaction,
  type Database,
  type TransactionalHandler,
} from "../db.js";
import { StackCreate, StackResponse, StackUpdate } from "../dto.js";
import type { StackResponseDto } from "../dto.js";
import { apiError, pydanticUuid, toFastApiValidationError } from "../errors.js";
import type { ApiError, ValidationFailure } from "../errors.js";

/**
 * `/stacks` router — the TypeScript port of `app/routers/stacks.py`.
 *
 * Five endpoints (create, list, read, partial update, delete) reproduced
 * against the live Python oracle. Everything below that is not obvious is a
 * measurement, not a preference; the surprises are called out where they live.
 *
 * ## Row shape and column order are contractual
 *
 * {@link STACK_COLUMNS} repeats `_STACK_COLUMNS` from the Python module
 * verbatim, including order. The JSON key order of every response therefore
 * comes from that list plus `StackResponse`'s declaration order, which is the
 * same order. A response is serialized by parsing the row through
 * `StackResponse`, exactly like Python's `StackResponse(**row)`.
 *
 * ## Raw SQL, not drizzle's query builder
 *
 * The Python handlers build SQL text (`select ... order by updated_at desc`,
 * `insert ... returning ...`, a dynamic `set` clause). Reproducing that with
 * drizzle's builder would mean re-expressing the same statements in a second
 * dialect of the same idea; emitting the SQL directly keeps the port the same
 * shape as the original. Column names in the dynamic `set` clause come from the
 * fixed {@link STACK_UPDATE_FIELDS} allowlist and are emitted with
 * `sql.identifier`, so they are never caller-controlled.
 */

/** Oracle column list, in oracle order. Mirrors `_STACK_COLUMNS`. */
const STACK_COLUMNS =
  "id, name, domain, description, scope, compilation_strategy, synthesize_descriptions, created_at, updated_at";

/** A `stacks` row as selected by {@link STACK_COLUMNS}. */
type StackRow = {
  id: string;
  name: string;
  domain: string;
  description: string | null;
  scope: string;
  compilation_strategy: string | null;
  synthesize_descriptions: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * `StackUpdate`'s fields, in the Python model's declaration order.
 *
 * Iterating this list (rather than the request body's own key order) matches
 * `model_dump(exclude_unset=True)`, which emits fields in model order, and it
 * makes the `set` clause impossible to poison with an arbitrary key.
 */
const STACK_UPDATE_FIELDS = [
  "name",
  "description",
  "scope",
  "compilation_strategy",
  "synthesize_descriptions",
  "ontology",
] as const;

/**
 * The one updatable field stored as `jsonb`, and therefore bound differently.
 *
 * Kept out of the generic assignment path rather than special-casing inside it:
 * a bare object parameter would be sent untyped, and `JSON.stringify(null)` is
 * the four bytes `null` rather than SQL NULL, which would store the JSON value
 * `null` instead of clearing the column.
 */
const JSONB_FIELD = "ontology";

/**
 * Renders one `column = value` assignment for the dynamic `set` clause.
 *
 * Every caller-supplied object goes through here, so the only names reaching
 * `sql.identifier` are the fixed allowlist entries in
 * {@link STACK_UPDATE_FIELDS}.
 *
 * @param field - A field from {@link STACK_UPDATE_FIELDS}.
 * @param value - The value to write, already validated for that field.
 * @returns The assignment fragment, with an explicit `jsonb` cast when needed.
 */
function assignmentFor(field: string, value: unknown): SQL {
  if (field !== JSONB_FIELD) {
    return sql`${sql.identifier(field)} = ${value}`;
  }
  // `null` clears the declaration; anything else is serialised so Postgres
  // receives a jsonb document rather than an untyped parameter.
  return value === null
    ? sql`${sql.identifier(field)} = null`
    : sql`${sql.identifier(field)} = ${JSON.stringify(value)}::jsonb`;
}

/**
 * Renders a Stack's ontology as the jsonb value an insert should store.
 *
 * Stringified BEFORE binding, then cast once. This is driver-specific and was
 * measured, not assumed: drizzle hands a JS object to its parameter binder in a
 * form Postgres refuses (the query throws outright), while a JSON string cast to
 * `jsonb` arrives as a jsonb *object* — which is what `valid_ontology_is_object`
 * requires. Binding the raw object therefore fails every create that supplies a
 * declaration, and the failure is a 500 rather than a 422, because it happens
 * inside the query rather than in validation.
 *
 * `undefined` and `null` both mean "no declaration" and must become SQL NULL,
 * never the JSON document `null` — otherwise "unconfigured" would be
 * indistinguishable from "configured to a JSON null" and the null semantics the
 * ingest path depends on would be quietly defeated.
 *
 * @param ontology - The parsed request field; absent and null are equivalent.
 * @returns A `jsonb`-cast fragment, or SQL NULL when there is no declaration.
 */
function ontologyLiteral(ontology: unknown): SQL | null {
  return ontology === undefined || ontology === null
    ? null
    : sql`${JSON.stringify(ontology)}::jsonb`;
}

/**
 * Path-parameter validator for `:stack_id`.
 *
 * Deliberately an object with the parameter's own name as its key, not the bare
 * {@link pydanticUuid} primitive. FastAPI reports a path parameter failure as
 * `loc: ["path", "stack_id"]`, and `toFastApiValidationError` derives the tail
 * of `loc` from the Zod issue path. Parsing a bare primitive at the root would
 * leave that path empty and produce `loc: ["path"]`, so the value is wrapped in
 * a one-key object whose key *is* the FastAPI parameter name.
 *
 * The wrapper also makes `input` come out right for free: the mapper reads it
 * from the same path, so it reports the raw `"not-a-uuid"` text rather than a
 * container.
 */
const StackIdParams = z.object({ stack_id: pydanticUuid() });

/** Result of validating the path parameter, before any SQL runs. */
type StackIdParse =
  | { readonly ok: true; readonly stackId: string }
  | { readonly ok: false; readonly failure: ValidationFailure };

/**
 * Validates `:stack_id` the way FastAPI's `UUID` path parameter does.
 *
 * Resolves to the canonical lowercase hyphenated UUID, which is what Pydantic
 * serializes — so the 404 detail always carries the normalized form even when
 * the client sent the simple, braced, `urn:uuid:` or uppercase variant.
 */
function parseStackId(raw: unknown): StackIdParse {
  const parsed = StackIdParams.safeParse({ stack_id: raw });
  if (!parsed.success) {
    return {
      ok: false,
      failure: toFastApiValidationError(parsed.error, "path", { stack_id: raw }),
    };
  }
  return { ok: true, stackId: parsed.data.stack_id };
}

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/** Sends a `RequestValidationError`-shaped body: `{"detail": [...]}`. */
function sendValidationError(res: Response, failure: ValidationFailure): void {
  res.status(failure.status).json(failure.body);
}

/**
 * Narrows a parsed JSON body to a plain object.
 *
 * Used only for `Object.hasOwn` presence tracking; `StackUpdate` has already
 * rejected every non-object shape by the time this is called, so a `false`
 * result means the invariant above was broken, not that the client sent
 * something odd.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `StackResponse(**row)` — validates and fixes the key order in one step. */
function toStackResponse(row: StackRow): StackResponseDto {
  return StackResponse.parse(row);
}

/**
 * `POST /stacks` — create a Stack, 201 with `StackResponse`.
 *
 * The uniqueness check is the app-level `select id from stacks where domain = %s`
 * followed by a 409, exactly as written in Python.
 *
 * Racy under concurrency, and preserved as such: two simultaneous requests with
 * the same domain can both pass the check, and the loser's `insert` then fails
 * on `stacks_domain_key` with a 23505 that surfaces as a 500 — which is also
 * what the Python oracle does. Turning this into `on conflict do nothing` /
 * `on conflict ... returning` would silently change the observable contract
 * (a 500 becoming a 409 or an upsert), so it is deliberately NOT "improved".
 */
async function createStack(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const rawBody: unknown = req.body;
  const parsed = StackCreate.safeParse(rawBody);
  if (!parsed.success) {
    sendValidationError(res, toFastApiValidationError(parsed.error, "body", rawBody));
    return;
  }

  const payload = parsed.data;

  const existing = await tx.execute<{ id: string }>(
    sql`select id from stacks where domain = ${payload.domain}`,
  );
  if (existing.length > 0) {
    sendApiError(
      res,
      apiError(409, `Stack with domain '${payload.domain}' already exists`),
    );
    return;
  }

  const rows = await tx.execute<StackRow>(sql`
    insert into stacks (name, domain, description, scope,
                        compilation_strategy, synthesize_descriptions, ontology)
    values (${payload.name}, ${payload.domain}, ${payload.description},
            ${payload.scope}, ${payload.compilation_strategy},
            ${payload.synthesize_descriptions}, ${ontologyLiteral(payload.ontology)})
    returning ${sql.raw(STACK_COLUMNS)}
  `);

  const row = rows[0];
  if (row === undefined) {
    throw new Error("insert into stacks returned no row");
  }

  res.status(201).json(toStackResponse(row));
}

/** `GET /stacks` — every Stack, most recently updated first. */
async function listStacks(
  _req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  // `order by updated_at desc` is contractual: after touching the middle row it
  // moves to the front of the list. Omitting the ORDER BY would let Postgres
  // return heap order, which only looks sorted until a row is updated.
  const rows = await tx.execute<StackRow>(sql`
    select ${sql.raw(STACK_COLUMNS)}
    from stacks
    order by updated_at desc
  `);

  res.json(rows.map(toStackResponse));
}

/** `GET /stacks/:stack_id` — one Stack, or 404. */
async function getStack(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const stackId = parseStackId(req.params["stack_id"]);
  if (!stackId.ok) {
    sendValidationError(res, stackId.failure);
    return;
  }

  const rows = await tx.execute<StackRow>(sql`
    select ${sql.raw(STACK_COLUMNS)}
    from stacks
    where id = ${stackId.stackId}
  `);

  const row = rows[0];
  if (row === undefined) {
    sendApiError(res, apiError(404, `Stack ${stackId.stackId} not found`));
    return;
  }

  res.json(toStackResponse(row));
}

/** A parsed `StackUpdate` body. */
type StackUpdateParse = ReturnType<typeof StackUpdate.safeParse>;

/** What `updateStackRow` needs once the request has validated. */
interface StackUpdateInput {
  readonly stackId: string;
  readonly present: readonly (typeof STACK_UPDATE_FIELDS)[number][];
  readonly values: Record<string, unknown>;
}

/** Sends whichever envelope the refusal carries. */
function refuseUpdate(res: Response, refusal: UpdateRefusal): void {
  if ("failure" in refusal) {
    sendValidationError(res, refusal.failure);
  } else {
    sendApiError(res, refusal.error);
  }
}

/**
 * Builds the update input from an already-validated request.
 *
 * Precondition: {@link validateUpdate} returned `undefined`, so both parses
 * succeeded and the raw body is an object.
 */
function updateInput(
  stackId: StackIdParse,
  body: StackUpdateParse,
  rawBody: unknown,
): StackUpdateInput {
  if (!stackId.ok || !body.success) {
    throw new TypeError("PATCH /stacks reached the update with an invalid request");
  }
  const present = STACK_UPDATE_FIELDS.filter((field) =>
    Object.hasOwn(rawBody as object, field),
  );
  return {
    stackId: stackId.stackId,
    present,
    values: body.data as Record<string, unknown>,
  };
}

/** Either a 422 `RequestValidationError` body or a 400 `HTTPException` body. */
type UpdateRefusal =
  | { readonly failure: ValidationFailure }
  | { readonly error: ApiError };

/**
 * Validates the path parameter and the body before either error is returned.
 *
 * Path entries come first. Measured on the oracle: `PATCH /stacks/not-a-uuid`
 * with `{"name": ""}` answers 422 with the `uuid_parsing` entry for
 * `["path","stack_id"]` followed by the `string_too_short` entry for
 * `["body","name"]`. Reporting only one of the two would be a silent contract
 * change. `{"bogus": 1}` and `{}` are both "no updatable field supplied" — Zod
 * strips the unknown key, so the 400 is what the oracle answers for both.
 *
 * @returns `undefined` when the update may proceed.
 */
function validateUpdate(
  stackId: StackIdParse,
  body: StackUpdateParse,
  rawBody: unknown,
): UpdateRefusal | undefined {
  if (!stackId.ok || !body.success) {
    const details = [
      ...(stackId.ok ? [] : stackId.failure.body.detail),
      ...(body.success
        ? []
        : toFastApiValidationError(body.error, "body", rawBody).body.detail),
    ];
    return { failure: { status: 422, body: { detail: details } } };
  }

  // `exclude_unset`, reproduced from the RAW body's key presence. `StackUpdate`
  // gives every field `.default(null)`, so the parsed value cannot distinguish
  // "absent" from "explicitly null" — both come out `null`. An absent key must
  // leave the column untouched, while `{"description": null}` must write NULL,
  // so `Object.hasOwn` on the raw JSON object is the only source of that
  // information: the body is read twice, once through Zod for values and once
  // raw for presence.
  if (!isRecord(rawBody)) {
    throw new TypeError("PATCH /stacks validated a body that is not an object");
  }

  if (STACK_UPDATE_FIELDS.every((field) => !Object.hasOwn(rawBody, field))) {
    return { error: apiError(400, "At least one field must be provided") };
  }
  return undefined;
}

/**
 * Applies the partial update and returns the new row, or `undefined` when no
 * Stack has that id.
 *
 * `updated_at = now()` is appended by the Python handler, not by a trigger; it
 * is what reorders the list response.
 */
async function updateStackRow(
  tx: Database,
  update: StackUpdateInput,
): Promise<StackRow | undefined> {
  const { stackId, present, values } = update;
  const assignments = present.map((field) => assignmentFor(field, values[field]));

  const rows = await tx.execute<StackRow>(sql`
    update stacks
    set ${sql.join(assignments, sql`, `)}, updated_at = now()
    where id = ${stackId}
    returning ${sql.raw(STACK_COLUMNS)}
  `);
  return rows[0];
}

/** `PATCH /stacks/:stack_id` — partial update with `exclude_unset` semantics. */
async function updateStack(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const stackId = parseStackId(req.params["stack_id"]);
  const rawBody: unknown = req.body;
  const body = StackUpdate.safeParse(rawBody);

  const refusal = validateUpdate(stackId, body, rawBody);
  if (refusal !== undefined) {
    refuseUpdate(res, refusal);
    return;
  }

  const update = updateInput(stackId, body, rawBody);
  const row = await updateStackRow(tx, update);
  if (row === undefined) {
    sendApiError(res, apiError(404, `Stack ${update.stackId} not found`));
    return;
  }
  res.json(toStackResponse(row));
}

/** `DELETE /stacks/:stack_id` — 204 with a genuinely empty body. */
async function deleteStack(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const stackId = parseStackId(req.params["stack_id"]);
  if (!stackId.ok) {
    sendValidationError(res, stackId.failure);
    return;
  }

  const rows = await tx.execute<{ id: string }>(
    sql`delete from stacks where id = ${stackId.stackId} returning id`,
  );
  if (rows.length === 0) {
    sendApiError(res, apiError(404, `Stack ${stackId.stackId} not found`));
    return;
  }

  // `.end()` with no payload: the oracle answers 204 with a zero-length body,
  // not `{}` and not `null`. `res.status(204).json(...)` would emit a body.
  res.status(204).end();
}

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface StacksRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: StacksRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the `/stacks` router.
 *
 * Each handler is wrapped in its own transaction via the route wrapper (never a
 * transaction-owning `app.use` middleware — see `db.ts` for why that cannot work
 * on Express 5). Auth is mounted on the router, mirroring
 * `dependencies=[Depends(require_api_key)]`, so every route here is guarded while
 * `/health` stays open.
 */
export function createStacksRouter(
  deps: StacksRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.post("/", deps.wrap(createStack));
  router.get("/", deps.wrap(listStacks));
  router.get("/:stack_id", deps.wrap(getStack));
  router.patch("/:stack_id", deps.wrap(updateStack));
  router.delete("/:stack_id", deps.wrap(deleteStack));

  return router;
}
