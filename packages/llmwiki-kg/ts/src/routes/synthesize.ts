/**
 * @file packages/llmwiki-kg/ts/src/routes/synthesize.ts
 * @description Description-synthesis backfill — public surface.
 *
 * The TypeScript port of `app/routers/synthesize.py`.
 *
 *   POST /stacks/{stack_id}/synthesize-descriptions        backfill many at once
 *   POST /aks/v1/entities/{name}/synthesize-description    backfill one
 *
 * Both are opt-in and both spend money: one LLM call per entity that has
 * grounding passages. They exist because a Stack can be ingested without
 * synthesis (`synthesize_descriptions=false`) and enriched later.
 *
 * The module was split into `src/routes/synthesize/` to keep each file under the
 * project's size limits. It remains the single import site, so `server.ts` and
 * the tests import `routes/synthesize.js` unchanged:
 *
 * | Concern | Module |
 * | --- | --- |
 * | Pydantic models + path validators | `synthesize/models.ts` |
 * | Query reading + error senders | `synthesize/query.ts` |
 * | Starlette-shaped body reading | `synthesize/request-body.ts` |
 * | Grounding one description | `synthesize/description.ts` |
 * | `POST /stacks/{id}/synthesize-descriptions` | `synthesize/backfill.ts` |
 * | `POST /aks/v1/entities/{name}/…` | `synthesize/one-entity.ts` |
 * | Router construction | `synthesize/router.ts` |
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
 * "what text was it" (the raw stream, which `synthesize/request-body.ts` reads
 * itself — exactly as `documents.ts` does for multipart).
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
 * `bool_type` for `["body","only_missing"]`. Both are emitted from
 * `synthesize/backfill.ts`.
 */

export {
  SYNTHESIS_MAX_TOKENS,
  SYNTHESIS_CHUNK_LIMIT,
  buildSynthesisPrompt,
  synthesizeOne,
} from "./synthesize/description.js";

export { createSynthesizeRouter } from "./synthesize/router.js";
export type { SynthesizeRouterDependencies } from "./synthesize/router.js";
