/**
 * @file packages/llmwiki-kg/ts/src/routes/documents/response.ts
 * @description Row → response DTO.
 *
 * Split out of `routes/documents.ts` as its own unit because `DocumentResponse`
 * both validates the row and fixes its JSON key order, and every endpoint returns
 * through it.
 */

import { DocumentResponse } from "../../dto.js";
import type { DocumentResponseDto } from "../../dto.js";
import type { DocumentRow } from "./model.js";

/** `DocumentResponse(**row)` — validates and fixes the key order in one step. */
export function toDocumentResponse(row: DocumentRow): DocumentResponseDto {
  return DocumentResponse.parse(row);
}
