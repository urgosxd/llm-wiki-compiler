import { sql } from "drizzle-orm";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { requireApiKey, type ApiKeyMiddleware } from "../auth.js";
import { complete } from "../core/llm_clients.js";
import { resolveStack } from "../core/stack_resolver.js";
import {
  withRequestTransaction,
  type Database,
  type TransactionalHandler,
} from "../db.js";
import {
  apiError,
  pydanticBoolean,
  pydanticInt,
  pydanticString,
  pydanticUuid,
  toFastApiValidationError,
} from "../errors.js";
import type {
  ApiError,
  PydanticErrorDetail,
  ValidationFailure,
} from "../errors.js";

/**
 * Description-synthesis backfill — the TypeScript port of
 * `app/routers/synthesize.py`.
 *
 *   POST /stacks/{stack_id}/synthesize-descriptions        backfill many at once
 *   POST /aks/v1/entities/{name}/synthesize-description    backfill one
 *
 * Both are opt-in and both spend money: one LLM call per entity that has
 * grounding passages. They exist because a Stack can be ingested without
 * synthesis (`synthesize_descriptions=false`) and enriched later.
 *
 * ## Both routes live on one root-mounted router, like the Python module
 *
 * `synthesize.py` declares `APIRouter()` with **no prefix** and gives each route
 * its absolute path, which is why `server.ts` mounts this router at `/` rather
 * than under a shared prefix. Splitting the two endpoints across the `/stacks`
 * and `/aks/v1` routers would work, but the 405 `Allow` walk reproduces
 * Starlette's flat route list, and keeping the routes together keeps that walk
 * faithful.
 *
 * ## The body contract is FastAPI's, not Express's
 *
 * `BackfillRequest` is a Pydantic model, so the request body passes through
 * Starlette's own per-content-type rules before validation. Measured:
 *
 * | request | oracle |
 * |---|---|
 * | no body at all, or `application/json` with zero bytes | 422 `missing` on `["body"]` |
 * | `application/json` body `null` / `5` / `[]` | 422 `model_attributes_type` |
 * | `text/plain` (or no content type) with a body | 422 `model_attributes_type` with the **raw text** as `input` |
 * | body `{}` | accepted; `only_missing` defaults to `true` |
 * | unknown keys | ignored |
 *
 * `express.json` only parses a JSON content type and only when there are bytes,
 * which happens to line up with three of those rows: a skipped body leaves
 * `req.body === undefined`, and an empty JSON body parses to `{}`. The two cases
 * that need care are therefore "was there a body at all" (`content-length`) and
 * "what text was it" (the raw stream, which this module reads itself — exactly
 * as `documents.ts` does for multipart).
 *
 * Known divergence, inherited from the app's shared body parser: **malformed**
 * JSON is Express's 400, while the oracle answers 422 `json_invalid`. That gap is
 * app-wide and recorded in `odd/tasks/python-to-typescript-port.md`.
 *
 * ## Validation order is contractual
 *
 * FastAPI validates the path parameter and the body before the handler runs, and
 * reports both failure sets together, path entries first. Measured:
 * `POST /stacks/nope/synthesize-descriptions` with `{"only_missing":null}`
 * answers 422 with `uuid_parsing` for `["path","stack_id"]` followed by
 * `bool_type` for `["body","only_missing"]`. Both are emitted from here.
 */

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** `BackfillRequest` — the optional filters for a backfill run. */
const BackfillRequest = z.object({
  // `Optional[list[UUID]] = None`: absent and explicit `null` both mean "every
  // entity", so `.nullable()` comes before `.default(null)`.
  entity_ids: z.array(pydanticUuid()).nullable().default(null),
  // `bool = True` — the default is what makes an empty body a full backfill.
  only_missing: pydanticBoolean().default(true),
});

/** `BackfillResult` — mirrors the Pydantic model's field order. */
const BackfillResult = z.object({
  stack_id: pydanticUuid(),
  entities_considered: pydanticInt(),
  entities_synthesized: pydanticInt(),
  entities_skipped: pydanticInt(),
});

/** Response for `POST /aks/v1/entities/{name}/synthesize-description`. */
const SynthesizeOneResult = z.object({
  entity_name: pydanticString(),
  description: pydanticString().nullable(),
  synthesized: pydanticBoolean(),
});

/** FastAPI's body-level `missing` entry, when no body was sent at all. */
const MISSING_BODY: PydanticErrorDetail = {
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
function modelAttributesType(
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
const StackIdParams = z.object({ stack_id: pydanticUuid() });

/** Path-parameter validator for `{name}`. */
const EntityNameParams = z.object({ name: pydanticString() });

// ---------------------------------------------------------------------------
// Query-parameter reading (the single-entity endpoint's signature)
// ---------------------------------------------------------------------------

/**
 * Reads one raw query-string value, keeping FastAPI's last-occurrence rule.
 *
 * Express's default `simple` parser yields `string | string[]`; Starlette hands
 * the last occurrence to the parameter.
 */
function readQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const last: unknown = value[value.length - 1];
    return typeof last === "string" ? last : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

/** Collects `keys` from the query string, omitting absent ones. */
function readQuery(req: Request, keys: readonly string[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of keys) {
    const value = readQueryValue(req.query[key]);
    if (value !== undefined) {
      raw[key] = value;
    }
  }
  return raw;
}

/** Query schema for `POST /aks/v1/entities/{name}/synthesize-description`. */
const SynthesizeOneQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
});

const SYNTHESIZE_ONE_QUERY_KEYS = ["stack_id", "domain"] as const;

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/** Sends a `RequestValidationError`-shaped body: `{"detail": [...]}`. */
function sendValidationError(res: Response, failure: ValidationFailure): void {
  res.status(failure.status).json(failure.body);
}

// ---------------------------------------------------------------------------
// Request body, read the way Starlette reads it
// ---------------------------------------------------------------------------

/** What the body contributes before validation. */
type RawBody =
  /** No body was sent: Pydantic reports `missing` for the whole body. */
  | { readonly kind: "absent" }
  /** A body arrived but no JSON parser claimed it: the raw text is the value. */
  | { readonly kind: "text"; readonly text: string }
  /** `express.json` parsed it: this is the JSON value to validate. */
  | { readonly kind: "json"; readonly value: unknown };

/**
 * Reads the request body as Starlette would hand it to a Pydantic model.
 *
 * Express's `body-parser` already consumed the JSON case (it parses an
 * `application/json` body only when the request has one), so `req.body !==
 * undefined` means "a JSON value was parsed". Everything else — a `text/plain`
 * body, no declared content type — is left unread on the stream and is read here,
 * because Python passes that text through as the body value.
 *
 * `content-length: 0` on a JSON request is body-parser's "empty json body" special
 * case: it yields `{}` — indistinguishable from a literal `{}` — so the header is
 * what separates the two. A zero-length **chunked** JSON body would still be read
 * as `{}` here where the oracle reports `missing`; clients do not send that and
 * the harness cannot construct it, so the divergence is documented rather than
 * guessed at.
 */
async function readRequestBody(req: Request): Promise<RawBody> {
  const parsed: unknown = req.body;

  if (parsed !== undefined) {
    const contentLength = req.headers["content-length"];
    if (contentLength === "0") {
      return { kind: "absent" };
    }
    return { kind: "json", value: parsed };
  }

  if (req.readableEnded) {
    return { kind: "absent" };
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? { kind: "absent" } : { kind: "text", text };
}

// ---------------------------------------------------------------------------
// Description synthesis (shared by both endpoints)
// ---------------------------------------------------------------------------

/** Response budget for one description. `complete(prompt, max_tokens=300)`. */
export const SYNTHESIS_MAX_TOKENS = 300;

/**
 * How many grounding chunks one description may see.
 *
 * `order by length(dc.content) asc limit 3` in Python: the three *shortest*
 * passages that mention the entity, because short passages are the densely
 * relevant ones. The order is visible in the prompt, so it is reproduced exactly
 * — including the join, which yields one row per (chunk, source-document) pair
 * and can therefore repeat a chunk.
 */
export const SYNTHESIS_CHUNK_LIMIT = 3;

/** Interpolates the description prompt from its three inputs. */
export function buildSynthesisPrompt(
  entityName: string,
  entityType: string,
  domainContextNames: readonly string[],
  chunkText: string,
): string {
  // `", ".join(sorted(names))` — a code-point sort, then a comma-space join.
  const domainContext = [...domainContextNames].sort(compareCodePoints).join(", ");

  return `You are writing a compiled description for one entity in a knowledge graph.

ENTITY: ${entityName}
TYPE: ${entityType}

OTHER ENTITIES IN THIS DOMAIN (reference them naturally if relevant):
${domainContext}

SOURCE PASSAGES THAT MENTION THIS ENTITY:
${chunkText}

Write a description that is 2-4 sentences, reflects what the passages
say, references siblings naturally when relevant, and contains no
filler. Return ONLY the description as plain prose.`;
}

/** Python's code-point string ordering (see `core/page_generator.ts`). */
function compareCodePoints(left: string, right: string): number {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  for (;;) {
    const leftStep = leftIterator.next();
    const rightStep = rightIterator.next();
    if (leftStep.done === true || rightStep.done === true) {
      if (leftStep.done === true && rightStep.done === true) {
        return 0;
      }
      return leftStep.done === true ? -1 : 1;
    }
    const leftCode = leftStep.value.codePointAt(0) ?? 0;
    const rightCode = rightStep.value.codePointAt(0) ?? 0;
    if (leftCode !== rightCode) {
      return leftCode < rightCode ? -1 : 1;
    }
  }
}

/** One `ontology_entities` row as the synthesis reads it. */
type SynthesisEntityRow = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
};

/**
 * `_synthesize_one` — ground one entity's description in its source passages.
 *
 * Returns `true` when a description was written and `false` when there was
 * nothing to ground in (no chunks mention the entity, or the entity is gone).
 * A `false` still commits, which is why the caller counts it as *skipped* rather
 * than as a failure.
 *
 * The chunk search is `content ilike '%<name>%'` against chunks of documents that
 * contributed to the entity, scoped to the Stack. The name is interpolated into
 * the pattern verbatim, so a `%` in an entity name acts as a wildcard — that is
 * the oracle's behaviour and it is preserved, not corrected.
 */
export async function synthesizeOne(
  tx: Database,
  stackId: string,
  entityId: string,
  domainContextNames: readonly string[],
): Promise<boolean> {
  const entityRows = await tx.execute<SynthesisEntityRow>(sql`
    select name, type from ontology_entities where id = ${entityId}
  `);
  const entity = entityRows[0];
  if (entity === undefined) {
    return false;
  }

  const chunkRows = await tx.execute<{ readonly content: string }>(sql`
    select dc.content
    from document_chunks dc
    join entity_source_documents esd
      on esd.document_id = dc.document_id
      and esd.entity_id = ${entityId}
    where dc.stack_id = ${stackId}
      and dc.content ilike ${`%${entity.name}%`}
    order by length(dc.content) asc
    limit ${SYNTHESIS_CHUNK_LIMIT}
  `);
  const chunks = chunkRows.map((row) => row.content);
  if (chunks.length === 0) {
    return false;
  }

  const chunkText = chunks.join("\n\n---\n\n");
  const newDescription = await complete(
    buildSynthesisPrompt(entity.name, entity.type, domainContextNames, chunkText),
    SYNTHESIS_MAX_TOKENS,
  );

  // `updated_at = now()` is written by the Python handler, not a trigger.
  await tx.execute(sql`
    update ontology_entities
    set description = ${newDescription},
        updated_at = now()
    where id = ${entityId}
  `);
  return true;
}

/** Every entity name in the Stack, in the order the domain context uses. */
async function fetchEntityNames(tx: Database, stackId: string): Promise<string[]> {
  const rows = await tx.execute<{ readonly name: string }>(sql`
    select name from ontology_entities where stack_id = ${stackId}
  `);
  return rows.map((row) => row.name);
}

// ---------------------------------------------------------------------------
// POST /stacks/{stack_id}/synthesize-descriptions
// ---------------------------------------------------------------------------

/** One candidate row for the backfill. */
type BackfillCandidateRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
};

/**
 * `POST /stacks/{stack_id}/synthesize-descriptions` — backfill, many at once.
 *
 * Candidate selection, in the Python order:
 *
 * 1. every entity in the Stack;
 * 2. narrowed to `entity_ids` when that list is **non-empty** (`if
 *    payload.entity_ids:` is a truthiness test, so `[]` selects everything —
 *    measured: `{"entity_ids":[]}` reports all 13 entities as considered);
 * 3. narrowed to `description is null or length(description) < 20` when
 *    `only_missing` is true.
 *
 * `entities_considered` counts the candidates, and every candidate ends up in
 * either `entities_synthesized` or `entities_skipped`, so those two always sum to
 * it. Counts are never asserted by tests: they follow the LLM and the extraction,
 * both of which vary between identical runs.
 */
async function backfillStack(req: Request, res: Response, tx: Database): Promise<void> {
  const body = await readRequestBody(req);

  // Path and body are validated together, path entries first (measured).
  const stackId = StackIdParams.safeParse({ stack_id: req.params["stack_id"] });

  let bodyFailure: ValidationFailure | undefined;
  let payload: { entity_ids: string[] | null; only_missing: boolean } | undefined;

  switch (body.kind) {
    case "absent":
      bodyFailure = { status: 422, body: { detail: [MISSING_BODY] } };
      break;
    case "text":
      bodyFailure = {
        status: 422,
        body: { detail: [modelAttributesType(body.text, ["body"])] },
      };
      break;
    case "json": {
      const parsed = BackfillRequest.safeParse(body.value);
      if (parsed.success) {
        payload = parsed.data;
      } else {
        bodyFailure = toFastApiValidationError(parsed.error, "body", body.value);
      }
      break;
    }
  }

  if (!stackId.success || payload === undefined) {
    sendValidationError(res, {
      status: 422,
      body: {
        detail: [
          ...(stackId.success
            ? []
            : toFastApiValidationError(stackId.error, "path", {
                stack_id: req.params["stack_id"],
              }).body.detail),
          ...(bodyFailure === undefined ? [] : bodyFailure.body.detail),
        ],
      },
    });
    return;
  }

  // `resolve_stack(conn, stack_id=stack_id)` — a domain slug has no meaning on
  // this endpoint, so `domain` is always null here.
  const stack = await resolveStack(tx, stackId.data.stack_id, null);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  const entityIdFilter =
    payload.entity_ids === null || payload.entity_ids.length === 0
      ? sql.empty()
      : sql`and id = any(${toUuidArrayLiteral(payload.entity_ids)}::uuid[])`;
  const missingFilter = payload.only_missing
    ? sql`and (description is null or length(description) < 20)`
    : sql.empty();

  const candidates = await tx.execute<BackfillCandidateRow>(sql`
    select id, name, description
    from ontology_entities
    where stack_id = ${stack.stack.id}
    ${entityIdFilter}
    ${missingFilter}
  `);

  const allNames = await fetchEntityNames(tx, stack.stack.id);

  let synthesized = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const wrote = await synthesizeOne(tx, stack.stack.id, candidate.id, allNames);
    if (wrote) {
      synthesized += 1;
    } else {
      skipped += 1;
    }
  }

  res.json(
    BackfillResult.parse({
      stack_id: stack.stack.id,
      entities_considered: candidates.length,
      entities_synthesized: synthesized,
      entities_skipped: skipped,
    }),
  );
}

/**
 * Renders `uuid[]` parameter text, the way `toPostgresArrayLiteral` does for
 * `text[]`.
 *
 * Element quoting is Postgres' own array-literal form, so a UUID always lands as
 * one element. Duplicated with `core/aks_serializers.ts` rather than imported:
 * that module's helper is declared for `text[]` and is outside this slice's edit
 * surface, and the two call sites cast to different array types.
 */
function toUuidArrayLiteral(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value.replaceAll('"', '\\"')}"`);
  return `{${quoted.join(",")}}`;
}

// ---------------------------------------------------------------------------
// POST /aks/v1/entities/{name}/synthesize-description
// ---------------------------------------------------------------------------

/** One `ontology_entities` row as the single-entity result reads it. */
type EntityDescriptionRow = {
  readonly name: string;
  readonly description: string | null;
};

/**
 * `POST /aks/v1/entities/{name}/synthesize-description` — backfill, one entity.
 *
 * The entity is found by exact, case-insensitive name inside the Stack, so a name
 * from a different Stack is a 404. The response is a plain dict in Python, which
 * means the field order is the literal insertion order:
 * `entity_name, description, synthesized`.
 *
 * The description is re-read **after** the write, so `description` is whatever is
 * now in the row — the freshly synthesized text, or the previous value when
 * nothing could be grounded (`synthesized: false`).
 */
async function synthesizeOneEntity(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const raw = readQuery(req, SYNTHESIZE_ONE_QUERY_KEYS);
  const query = SynthesizeOneQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const stack = await resolveStack(tx, query.data.stack_id, query.data.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  // A path parameter is always a string, so this parse cannot fail for a request
  // Express routed here; it exists so the value is narrowed without a cast.
  const name = EntityNameParams.parse({ name: req.params["name"] }).name;

  const entityRows = await tx.execute<{ readonly id: string }>(sql`
    select id from ontology_entities
    where stack_id = ${stack.stack.id} and lower(name) = lower(${name})
  `);
  const entity = entityRows[0];
  if (entity === undefined) {
    sendApiError(res, apiError(404, `Entity '${name}' not found in Stack`));
    return;
  }

  const allNames = await fetchEntityNames(tx, stack.stack.id);
  const wrote = await synthesizeOne(tx, stack.stack.id, entity.id, allNames);

  const resultRows = await tx.execute<EntityDescriptionRow>(sql`
    select name, description from ontology_entities where id = ${entity.id}
  `);
  const result = resultRows[0];
  if (result === undefined) {
    // The row was deleted between the update and this read. Python would raise
    // on `result["name"]` and answer 500; the port states it instead of
    // dereferencing a missing row.
    throw new Error("ontology_entities row disappeared during description synthesis");
  }

  res.json(
    SynthesizeOneResult.parse({
      entity_name: result.name,
      description: result.description,
      synthesized: wrote,
    }),
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface SynthesizeRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: SynthesizeRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the synthesis router.
 *
 * Mounted at `/` with no path argument, because `synthesize.py` puts the full
 * path on each route (`/stacks/...` and `/aks/v1/...`). Prefixing the mount would
 * move both endpoints and break the 405 `Allow` walk.
 *
 * Registration order follows the Python decorator order: the Stack backfill
 * first, the single-entity route second.
 */
export function createSynthesizeRouter(
  deps: SynthesizeRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.post("/stacks/:stack_id/synthesize-descriptions", deps.wrap(backfillStack));
  router.post(
    "/aks/v1/entities/:name/synthesize-description",
    deps.wrap(synthesizeOneEntity),
  );

  return router;
}
