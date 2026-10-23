/**
 * @file packages/llmwiki-kg/ts/src/routes/pages.ts
 * @description The `/aks/v1/pages` router — public surface.
 *
 * Generates and serves entity pages: one page per entity, and the whole Stack as
 * a ZIP of markdown files.
 *
 * The module was split into `src/routes/pages/` to keep each file under the
 * project's size limits. It remains the single import site, so `server.ts` and
 * the tests import `routes/pages.js` unchanged:
 *
 * | Concern | Module |
 * | --- | --- |
 * | Query reading + query schemas | `pages/query.ts` |
 * | README, filenames, entry list | `pages/archive.ts` |
 * | The ZIP container | `pages/zip.ts` |
 * | `GET /aks/v1/pages/{entity_name}` | `pages/one-page.ts` |
 * | `GET /aks/v1/pages` | `pages/all-pages.ts` |
 * | Router construction | `pages/router.ts` |
 *
 * ## Route order and mount point
 *
 * Mounted at `/aks/v1/pages`, mirroring `APIRouter(prefix="/aks/v1/pages", ...)`,
 * with auth on the router as `dependencies=[Depends(require_api_key)]` is in
 * Python. Registration order follows the Python decorator order: the
 * parameterised `/:entity_name` route is declared first and the bare `""` route
 * second. That is harmless here (the two paths differ in segment count) but it
 * keeps the 405 `Allow` walk in `http-contract.ts` visiting layers in the same
 * order Starlette does.
 *
 * ## The archive is a byte-level contract
 *
 * The README text, the `+00:00` timestamp form and the four filename
 * substitutions are transcribed from the oracle's own archive rather than
 * approximated, and `pages/zip.ts` writes the container by hand so the bytes
 * match `zipfile.ZipFile(..., ZIP_DEFLATED)`.
 *
 * The one deliberate HTTP detail is that the body is written and then ended, so
 * Express answers `transfer-encoding: chunked` exactly as the oracle's
 * `StreamingResponse` does — `res.end(buffer)` would set a `Content-Length` the
 * oracle never sends. See `pages/all-pages.ts` for the measurement table.
 */

export {
  buildArchiveEntries,
  buildReadme,
  pageFilename,
  pythonUtcIsoformat,
} from "./pages/archive.js";
export type { ArchiveEntry } from "./pages/archive.js";

export { buildZipArchive } from "./pages/zip.js";

export { createPagesRouter } from "./pages/router.js";
export type { PagesRouterDependencies } from "./pages/router.js";
