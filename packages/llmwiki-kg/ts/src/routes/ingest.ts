/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest.ts
 * @description Ingestion endpoint — public surface.
 *
 * The TypeScript port of `app/routers/ingest.py`. One endpoint:
 *
 *   POST /stacks/{stack_id}/documents/{doc_id}/ingest -> 200 with a summary
 *
 * The module was split into `src/routes/ingest/` to keep each file under the
 * project's size limits. It remains the single import site, so `server.ts` and
 * the tests import `routes/ingest.js` unchanged:
 *
 * | Concern | Module |
 * | --- | --- |
 * | Response model + request validators | `ingest/models.ts` |
 * | Request validation + document reads | `ingest/request.ts` |
 * | Chunk, extract, consolidate, respond | `ingest/pipeline.ts` |
 * | Router construction | `ingest/router.ts` |
 *
 * ## The status code is 200, not 201
 *
 * The Python handler declares no `status_code`, so FastAPI defaults a POST to
 * `200`. The task brief quoted a 201 for this endpoint; the live oracle answers
 * **200**, measured three times (successful ingest, re-ingest, and the
 * truncation case). The port follows the oracle.
 *
 * ## Declares its full path
 *
 * Mounted at the application root, mirroring the Python router
 * (`APIRouter(tags=["ingestion"], ...)` with an absolute path and no prefix).
 * Auth is mounted in `ingest/router.ts`, as `dependencies=[Depends(require_api_key)]`
 * is in Python.
 */

export { createIngestRouter } from "./ingest/router.js";
export type { IngestRouterDependencies } from "./ingest/router.js";
