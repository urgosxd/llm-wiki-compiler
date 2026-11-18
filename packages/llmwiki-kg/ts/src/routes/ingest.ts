/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest.ts
 * @description The KG pipeline's public surface — two routes, two phases.
 *
 * The TypeScript port of `app/routers/ingest.py`, carrying the two-step shape the
 * wiki has always had: an ingest STORES a document's chunks, a compile EXTRACTS
 * its graph. Both endpoints:
 *
 *   POST /stacks/{stackId}/documents/{doc_id}/ingest  -> 200 with a summary
 *   POST /stacks/{stackId}/documents/{doc_id}/compile -> 200 with a summary
 *
 * ## Phase one — ingest stores
 *
 * Ingest loads the document, chunks and embeds it, persists the rows in
 * `document_chunks`, and responds. It produces NO graph row — no
 * `ontology_entities`, no `ontology_relationships` — and makes NO model call: no
 * extraction, no classification, no consolidation.
 *
 * ## Phase two — compile extracts
 *
 * Compile reads the chunks phase one stored and runs the LLM pipeline over them:
 * extraction, classification and consolidation. The document body is irrelevant
 * to it, `document_chunks` is its whole input, which is what lets one ingested
 * document be compiled whenever a caller wants it.
 *
 * ## Nothing calls compile automatically
 *
 * There is no compile-on-ingest, no scheduler and no watcher, so an ingested
 * document that has never been compiled is the NORMAL state, not an error state.
 * Phase two runs only when a caller asks for it.
 *
 * The module was split into `src/routes/ingest/` to keep each file under the
 * project's size limits. It remains the single import site, so `server.ts` and
 * the tests import `routes/ingest.js` unchanged:
 *
 * | Concern | Module |
 * | --- | --- |
 * | Response model + request validators | `ingest/models.ts` |
 * | Request validation + document reads | `ingest/request.ts` |
 * | Phase one: load, chunk, embed, persist chunks | `ingest/pipeline.ts` |
 * | Phase two: stored chunks -> graph rows, extraction included | `ingest/compile-chunks.ts` |
 * | The compile route that reads the stored chunks | `ingest/compile.ts` |
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
 * Both routes are declared in `ingest/router.ts`, side by side and sharing one
 * auth surface, as `dependencies=[Depends(require_api_key)]` is in Python.
 */

export { createIngestRouter } from "./ingest/router.js";
export type { IngestRouterDependencies } from "./ingest/router.js";
