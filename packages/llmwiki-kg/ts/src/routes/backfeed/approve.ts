/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/approve.ts
 * @description `POST /aks/v1/backfeed/approve` — absorb the proposal.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import { consolidateBackfeedProposal } from "../../core/consolidation.js";
import type { Database } from "../../db.js";
import { BackfeedApprovalRequest, BackfeedApprovalResult } from "../../dto.js";
import type { BackfeedApprovalResultDto } from "../../dto.js";
import { apiError, toFastApiValidationError } from "../../errors.js";
import { readStoredProposal } from "./row.js";
import { sendApiError, sendValidationError } from "./query.js";
import { checkProposalAgainstOntology, loadStackOntology } from "./ontology-gate.js";

/** The queue row an approval needs: what it points at and what it holds. */
type ApprovalItem = {
  readonly id: string;
  readonly stack_id: string;
  readonly status: string;
  readonly proposal: unknown;
};

/** The counts an approval reports, in the DTO's field order. */
function approvalResult(
  itemId: string,
  entitiesAbsorbed: number,
  relationshipsAbsorbed: number,
): BackfeedApprovalResultDto {
  return {
    item_id: itemId,
    entities_absorbed: entitiesAbsorbed,
    relationships_absorbed: relationshipsAbsorbed,
    status: "approved",
  };
}

/** The item being approved, or `undefined` when no row has that id. */
async function readApprovalItem(
  tx: Database,
  itemId: string,
): Promise<ApprovalItem | undefined> {
  const rows = await tx.execute<ApprovalItem>(sql`
    select id, stack_id, status, proposal
    from backfeed_queue
    where id = ${itemId}
  `);
  return rows[0];
}

/** Absorbs the stored proposal into the ontology, returning what it wrote. */
async function absorbProposal(
  tx: Database,
  item: ApprovalItem,
): Promise<{ entitiesAbsorbed: number; relationshipsAbsorbed: number }> {
  const proposal = readStoredProposal(item.proposal);
  return consolidateBackfeedProposal(
    tx,
    item.stack_id,
    proposal.entities,
    proposal.relationships,
  );
}

/** Flips the queue row to `approved`, recording who reviewed it and when. */
async function markApproved(
  tx: Database,
  payload: {
    readonly item_id: string;
    readonly reviewed_by: string | null;
    readonly review_note: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    update backfeed_queue
    set status = 'approved',
        reviewed_at = now(),
        reviewed_by = ${payload.reviewed_by},
        review_note = ${payload.review_note}
    where id = ${payload.item_id}
  `);
}

/**
 * `POST /aks/v1/backfeed/approve` — absorb the proposal, 200.
 *
 * Three measured outcomes beyond the happy path:
 *
 * - unknown id -> 404 `Backfeed item <uuid> not found`;
 * - already **rejected** -> 409, and the ontology is untouched;
 * - already **approved** -> 200 with both counts set to **0**. Re-approval is
 *   idempotent and does not re-absorb, so the second call reports zeros rather
 *   than the counts the first call reported.
 *
 * The response is `BackfeedApprovalResult` — counts, not the item — so an
 * approval never returns the queue row.
 */
export async function approveItem(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const rawBody: unknown = req.body;
  const parsed = BackfeedApprovalRequest.safeParse(rawBody);
  if (!parsed.success) {
    sendValidationError(res, toFastApiValidationError(parsed.error, "body", rawBody));
    return;
  }

  const payload = parsed.data;
  const item = await readApprovalItem(tx, payload.item_id);
  if (item === undefined) {
    sendApiError(res, apiError(404, `Backfeed item ${payload.item_id} not found`));
    return;
  }

  if (item.status === "rejected") {
    sendApiError(res, apiError(409, "Cannot approve an item that has been rejected"));
    return;
  }

  if (item.status === "approved") {
    // Idempotent path: do not absorb again.
    res.json(BackfeedApprovalResult.parse(approvalResult(payload.item_id, 0, 0)));
    return;
  }

  // Refuse before writing anything: a partial approval would report a count the
  // human reads as success while an item was silently dropped.
  const proposal = readStoredProposal(item.proposal);
  const ontology = await loadStackOntology(tx, item.stack_id);
  const refusal = checkProposalAgainstOntology(ontology, proposal);
  if (refusal !== undefined) {
    res.status(refusal.status).json(refusal.body);
    return;
  }

  const absorbed = await absorbProposal(tx, item);
  await markApproved(tx, payload);
  res.json(
    BackfeedApprovalResult.parse(
      approvalResult(payload.item_id, absorbed.entitiesAbsorbed, absorbed.relationshipsAbsorbed),
    ),
  );
}