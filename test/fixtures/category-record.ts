/**
 * @file Category member fixtures shared by the category suites.
 *
 * A member is stored as EVIDENCE, not as a bare id: the page it names, the reason
 * recorded when the page was assigned, and the canonical key of the criterion (or
 * name evidence) that justified it. The helper here builds the shape a caller
 * supplies, so each suite states only what its own case is about.
 */

import type { CategoryMemberDraft } from "../../packages/wiki/src/categories/index.js";

/**
 * Build one member entry.
 *
 * @param pageId - The member page id (`concepts/<slug>` or `queries/<slug>`).
 * @param reason - Why the page belongs, recorded at assignment time.
 * @param evidenceKey - Optional canonical key of the justification. Omitting it
 *   makes the store derive it from the category's inclusion criterion.
 * @returns The draft entry.
 */
export function categoryMember(
  pageId: string,
  reason: string,
  evidenceKey?: string,
): CategoryMemberDraft {
  return evidenceKey === undefined ? { pageId, reason } : { pageId, reason, evidenceKey };
}
