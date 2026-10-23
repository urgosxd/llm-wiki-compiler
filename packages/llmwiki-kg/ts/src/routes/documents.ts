/**
 * @file packages/llmwiki-kg/ts/src/routes/documents.ts
 * @description The documents router — public surface.
 *
 * Upload, list, read and delete `stack_documents` records. TypeScript port of
 * `app/routers/documents.py`.
 *
 * The module was split into `src/routes/documents/` to keep each file under the
 * project's size limits. It remains the single import site, so `server.ts` and
 * the tests import `routes/documents.js` unchanged:
 *
 * | Concern | Module |
 * | --- | --- |
 * | Column list + row shape | `documents/model.ts` |
 * | Path params + `file` field 422s | `documents/params.ts` |
 * | Row → response DTO | `documents/response.ts` |
 * | `POST /stacks/:id/documents` | `documents/upload.ts` |
 * | `GET /stacks/:id/documents` | `documents/list.ts` |
 * | `GET /documents/:doc_id` | `documents/get.ts` |
 * | `DELETE /documents/:doc_id` | `documents/delete.ts` |
 * | Router construction | `documents/router.ts` |
 *
 * ## The oracle's observable order
 *
 * Measured, not inferred from reading the Python:
 *
 * 1. **Form parsing** (Starlette, before any handler runs): a missing boundary,
 *    malformed delimiters, a part with no `name`, an oversized non-file part, or
 *    too many parts each answer `400`. `POST /stacks/not-a-uuid/documents` with
 *    no boundary is a `400`, not a `422`.
 * 2. **Request validation** (path parameter + `file` field), reported together
 *    with the path entry first. A bad `stack_id` plus a missing `file` answers
 *    `422` with both entries.
 * 3. **Stack existence** → `404`. An unknown stack with no `file` is the `422`
 *    from step 2, not a 404 — validation wins.
 * 4. **Upload limits** → `413` oversized, `400` empty, both *after* the stack
 *    check. An oversized upload to an unknown stack is a `404`.
 *
 * ## Uploads are idempotent by content hash
 *
 * The handler hashes the bytes and looks for `(stack_id, source_hash)` before
 * inserting. A repeat upload returns the *existing* record — same `id`, same
 * `filename` — with the same `201`. This is enforced as well by
 * `unique_hash_per_stack`, which the check simply short-circuits.
 *
 * The check-then-insert is racy, and preserved as such: two simultaneous uploads
 * of identical bytes can both pass the check, and the loser's insert then fails
 * on `unique_hash_per_stack` with a 23505 that surfaces as a 500 — which is what
 * the Python oracle does. Turning it into `on conflict do nothing` would change
 * an observable 500 into a silent success.
 */

export { createDocumentsRouter } from "./documents/router.js";
export type { DocumentsRouterDependencies } from "./documents/router.js";
