/**
 * @file packages/llmwiki-kg/ts/src/routes/synthesize/backfill.ts
 * @description `POST /stacks/{stack_id}/synthesize-descriptions`.
 *
 * Split out of `routes/synthesize.ts` as its own unit because candidate
 * selection — the truthiness test on `entity_ids`, the `only_missing` narrow, and
 * the path-then-body validation order — is specific to the bulk endpoint.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import { resolveStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { toFastApiValidationError } from "../../errors.js";
import type { ValidationFailure } from "../../errors.js";
import { BackfillRequest, BackfillResult, MISSING_BODY, StackIdParams, modelAttributesType } from "./models.js";
import { readRequestBody } from "./request-body.js";
import { fetchEntityNames, synthesizeOne } from "./description.js";
import { sendApiError, sendValidationError } from "./query.js";

// ---------------------------------------------------------------------------
// POST /stacks/{stack_id}/synthesize-descriptions
// ---------------------------------------------------------------------------

/** One candidate row for the backfill. */
export type BackfillCandidateRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
};

/** A backfill request whose path and body both validated. */
interface ValidatedBackfill {
  readonly ok: true;
  readonly stackId: string;
  readonly payload: { entity_ids: string[] | null; only_missing: boolean };
}

/** Why a backfill request was refused, in FastAPI's 422 envelope shape. */
interface RefusedBackfill {
  readonly ok: false;
  readonly failure: ValidationFailure;
}

/** Reads the body's raw shape, before any model validation. */
async function readBodyOutcome(
  req: Request,
): Promise<
  | { readonly payload: { entity_ids: string[] | null; only_missing: boolean } }
  | { readonly failure: ValidationFailure }
> {
  const body = await readRequestBody(req);
  switch (body.kind) {
    case "absent":
      return { failure: { status: 422, body: { detail: [MISSING_BODY] } } };
    case "text":
      return {
        failure: { status: 422, body: { detail: [modelAttributesType(body.text, ["body"])] } },
      };
    case "json": {
      const parsed = BackfillRequest.safeParse(body.value);
      return parsed.success
        ? { payload: parsed.data }
        : { failure: toFastApiValidationError(parsed.error, "body", body.value) };
    }
  }
}

/**
 * Validates the path parameter and the body together, path entries first.
 *
 * FastAPI reports both failure sets in one 422 (measured:
 * `POST /stacks/nope/synthesize-descriptions` with `{"only_missing":null}` yields
 * `uuid_parsing` for `["path","stack_id"]` then `bool_type` for
 * `["body","only_missing"]`), so they cannot be short-circuited.
 */
async function validateRequest(req: Request): Promise<ValidatedBackfill | RefusedBackfill> {
  const stackId = StackIdParams.safeParse({ stack_id: req.params["stack_id"] });
  const body = await readBodyOutcome(req);

  if (stackId.success && "payload" in body) {
    return { ok: true, stackId: stackId.data.stack_id, payload: body.payload };
  }

  const pathDetails = stackId.success
    ? []
    : toFastApiValidationError(stackId.error, "path", {
        stack_id: req.params["stack_id"],
      }).body.detail;
  const bodyDetails = "failure" in body ? body.failure.body.detail : [];
  return { ok: false, failure: { status: 422, body: { detail: [...pathDetails, ...bodyDetails] } } };
}

/** Candidate rows for the run, narrowed by the two optional filters. */
async function selectCandidates(
  tx: Database,
  stackId: string,
  payload: { entity_ids: string[] | null; only_missing: boolean },
): Promise<BackfillCandidateRow[]> {
  const entityIdFilter =
    payload.entity_ids === null || payload.entity_ids.length === 0
      ? sql.empty()
      : sql`and id = any(${toUuidArrayLiteral(payload.entity_ids)}::uuid[])`;
  const missingFilter = payload.only_missing
    ? sql`and (description is null or length(description) < 20)`
    : sql.empty();

  return tx.execute<BackfillCandidateRow>(sql`
    select id, name, description
    from ontology_entities
    where stack_id = ${stackId}
    ${entityIdFilter}
    ${missingFilter}
  `);
}

/**
 * Grounds one description per candidate, counting writes against skips.
 *
 * Every candidate ends in exactly one of the two counts, so they always sum to
 * `entities_considered`.
 */
async function synthesizeCandidates(
  tx: Database,
  stackId: string,
  candidates: readonly BackfillCandidateRow[],
  allNames: readonly string[],
): Promise<{ synthesized: number; skipped: number }> {
  let synthesized = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const wrote = await synthesizeOne(tx, stackId, candidate.id, allNames);
    if (wrote) {
      synthesized += 1;
    } else {
      skipped += 1;
    }
  }
  return { synthesized, skipped };
}

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
export async function backfillStack(req: Request, res: Response, tx: Database): Promise<void> {
  const validated = await validateRequest(req);
  if (!validated.ok) {
    sendValidationError(res, validated.failure);
    return;
  }
  const { stackId, payload } = validated;

  // `resolve_stack(conn, stack_id=stack_id)` — a domain slug has no meaning on
  // this endpoint, so `domain` is always null here.
  const stack = await resolveStack(tx, stackId, null);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  const candidates = await selectCandidates(tx, stack.stack.id, payload);
  const allNames = await fetchEntityNames(tx, stack.stack.id);
  const counts = await synthesizeCandidates(tx, stack.stack.id, candidates, allNames);

  res.json(
    BackfillResult.parse({
      stack_id: stack.stack.id,
      entities_considered: candidates.length,
      entities_synthesized: counts.synthesized,
      entities_skipped: counts.skipped,
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
export function toUuidArrayLiteral(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value.replaceAll('"', '\\"')}"`);
  return `{${quoted.join(",")}}`;
}

