/** @file Post-write refresh for trusted OKF imports (links, index, MOC, embeddings). */
import { resolveAndApplyLinks } from "../compiler/resolver.js";
import { refreshEmbeddingsDrainingPending } from "../utils/embeddings-refresh.js";
import { slugFromPageId, type PageId } from "../utils/page-id.js";
import { regenerateIndices } from "../dimensions/wiki/page-source-seam.js";
import { withPageSeams } from "../dimensions/wiki/page-source-seam.js";

/**
 * Rebuild derived artifacts after writing imported pages live.
 *
 * The embeddings refresh routes through the SHARED
 * {@link refreshEmbeddingsDrainingPending} — the same drain compile and
 * `review approve` use — so an OKF import UNIONS the imported page-ids into any
 * prior-pending marker and settles it per-id. Without this, a workflow of OKF
 * imports + refresh that never runs a plain compile would never drain
 * accumulated pending compile-embeddings, leaving them stale indefinitely. The
 * import already holds the project lock across this call (runOkfImport:
 * acquireLock → writeAll → refreshAfterImport, inside the try, before the
 * finally releaseLock), so the shared drain's lock-free Core is correct (the
 * self-locking wrapper would deadlock under the held lock).
 *
 * `env` is the import's environment, threaded here instead of defaulted to
 * `process.env`: every seam below writes to a Stack, and a default would resolve the
 * AMBIENT one — the cross-tenant write this seam used to perform while its caller had
 * already resolved the request's Stack.
 *
 * @param root - Project root path.
 * @param pageIds - Qualified page ids of the imported pages (`<namespace>/<slug>`).
 * @param env - The import's environment; the Stack the derived artifacts belong to.
 */
export async function refreshAfterImport(
  root: string,
  pageIds: PageId[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // resolveAndApplyLinks operates on bare slugs (default concepts/queries
  // pipeline). The OKF import already holds the project lock (runOkfImport), so
  // this routes through the lock-free resolution seam.
  const slugs = pageIds.map(slugFromPageId);
  // Seams, not bare root: on a Stack the resolver reads concept pages from ROWS,
  // and a call without a source lists a directory that holds no page files. The curated
  // store travels with them for the same reason: the overlay this phase runs restores
  // records about those rows, so it must read them from the Stack rather than from
  // whatever `.llmwiki/curated-links.json` this checkout happens to hold.
  await withPageSeams(env, (seams) =>
    resolveAndApplyLinks(
      root, slugs, slugs, seams.resolver, seams.sink, seams.remover, undefined, undefined,
      seams.curatedLinks));
  await regenerateIndices(root, env);
  // Union the imported page-ids into the shared pending-marker drain (preserves
  // the existing changed-id set; the drain adds prior-pending ids on top).
  await refreshEmbeddingsDrainingPending(root, pageIds);
}
