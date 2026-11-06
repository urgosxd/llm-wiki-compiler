/**
 * @file packages/llmwiki-kg/ts/src/routes/pages/one-page.ts
 * @description `GET /aks/v1/pages/{entity_name}`.
 *
 * ## The page states the entity's classification status
 *
 * A page is prose synthesized from the compiled graph, and it reads as settled fact
 * — which is wrong for an entity the catalog never classified. The response
 * therefore opens with a notice naming the recorded state whenever the entity is not
 * confirmed `classified`, so a reader is told that the label is the extractor's
 * proposal rather than a catalog type (S41, S42). A classified entity's markdown is
 * returned untouched, and a row with no recorded decision gets no notice at all:
 * there is nothing to report, and inventing one would put our bookkeeping into text
 * a human is meant to read.
 *
 * The notice is never persisted — it is composed per response — so the page cache
 * keeps storing exactly what the model wrote, and its `graph_version` invalidation
 * is unaffected.
 *
 * ## Why the notice lives in the markdown
 *
 * `AKSEntityPage` is a closed AKS model (`entity_name`, `markdown`, `generated_at`,
 * `source_entity_id`, `graph_version`, `source_type`, `cached`) with no extension
 * point, and AKS defines none for a page. The markdown body is the only field a
 * consumer renders, so it is the only place a reader can actually see the status.
 *
 * ## Homonyms resolve deterministically
 *
 * The entity is found within the Stack by exact, case-insensitive name. Several rows
 * may share that name since the identity migration, so the row is chosen by
 * `pickEntityIdByName` — a classified row first, then the most confident, then by id
 * — instead of by `rows[0]`, which whichever plan ran decided.
 */

import type { Request, Response } from "express";
import { z } from "zod";

import { pickEntityIdByName } from "../../core/graph_read.js";
import { getOrGeneratePage } from "../../core/page_generator.js";
import { resolveStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { AKSEntityPage } from "../../dto.js";
import { apiError, pydanticString, toFastApiValidationError } from "../../errors.js";
import { EntityPageQuery, ENTITY_PAGE_QUERY_KEYS, readQuery, sendApiError, sendValidationError } from "./query.js";

/** Path-parameter validator for `:entity_name`. FastAPI's `str` path param. */
export const EntityNameParams = z.object({ entity_name: pydanticString() });

// GET /aks/v1/pages/{entity_name}
// ---------------------------------------------------------------------------

/**
 * The state-specific clause of the notice, per state that is not `classified`.
 *
 * A state outside this map — including the future addition of one — produces no
 * notice rather than a wrong sentence: an unknown label must never be described with
 * a claim nobody made.
 */
const NOTICE_CLAUSES: Readonly<Record<string, string>> = {
  free_no_match: "no canonical type in this Stack's catalog matched it",
  free_uncertain: "the classifier could not decide a canonical type",
  pending: "no classifier decision has been recorded yet",
  failed: "the classifier failed, so no canonical type was assigned",
};

/** How the notice names one recorded state. */
function noticeLabel(state: string): string {
  return state === "pending" || state === "failed" ? state : `unclassified (${state})`;
}

/**
 * The markdown notice to prepend to a page, or `null` when none is due.
 *
 * @param row - The entity's classification columns.
 * @returns The notice line, or `null` for a classified or undecided entity.
 */
export function classificationNotice(row: {
  readonly classification_state: string | null;
  readonly proposed_type: string | null;
}): string | null {
  const state = row.classification_state;
  const clause = state === null ? undefined : NOTICE_CLAUSES[state];
  if (state === null || clause === undefined) return null;
  const proposal =
    row.proposed_type === null
      ? "No canonical type was assigned to it"
      : `The label "${row.proposed_type}" is the extractor's proposal`;
  return (
    `> **Classification: ${noticeLabel(state)}.** ${proposal}; ${clause}. ` +
    "Read this page as source-backed but unclassified, not as a settled type."
  );
}

/**
 * `GET /aks/v1/pages/{entity_name}` — one page, generated or cached.
 *
 * The entity is resolved **within the Stack** by exact, case-insensitive name
 * (`lower(name) = lower(%s)`), so `?domain=x` and a name from another Stack is a
 * 404 rather than a cross-Stack read. The 404 echoes the requested text.
 *
 * `get_or_generate_page` returning nothing means the row disappeared between the
 * lookup and the read; Python answers `500` with
 * `"Failed to generate entity page"` and this port emits the same JSON body.
 */
export async function getEntityPage(req: Request, res: Response, tx: Database): Promise<void> {
  const raw = readQuery(req, ENTITY_PAGE_QUERY_KEYS);
  const query = EntityPageQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const stack = await resolveStack(tx, query.data.stackId, query.data.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  // A path parameter is always a string, so this parse cannot fail for a request
  // Express routed here; it exists so the value is narrowed without a cast.
  const entityName = EntityNameParams.parse({ entity_name: req.params["entity_name"] })
    .entity_name;

  const entity = await pickEntityIdByName(tx, stack.stack.id, entityName);
  if (entity === null) {
    sendApiError(res, apiError(404, `Entity '${entityName}' not found in Stack`));
    return;
  }

  const page = await getOrGeneratePage(tx, entity.id);
  if (page === null) {
    sendApiError(res, apiError(500, "Failed to generate entity page"));
    return;
  }

  const notice = classificationNotice(entity);
  res.json(
    AKSEntityPage.parse({
      ...page,
      markdown: notice === null ? page.markdown : `${notice}\n\n${page.markdown}`,
    }),
  );
}
