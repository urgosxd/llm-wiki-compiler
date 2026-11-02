/**
 * The viewer's ONE read of a non-default profile's typed entity pages.
 *
 * `buildViewerSnapshot` needs the same corpus three times over — as page-surface
 * records, as graph nodes, and as the route allowlist — so it is collected here
 * exactly once and handed out in all three shapes. Collecting it per consumer
 * would mean three directory scans that could disagree with each other about
 * what the project contains.
 *
 * Returns `undefined` for the built-in DEFAULT profile. That is the single gate
 * behind every typed surface: with no result there are no typed pages, no typed
 * graph inputs, and no addressable typed directory, so a default project's
 * envelope, page route, search and graph are byte-identical. It is also what
 * keeps `collectEntityPages` — which THROWS on the default profile by design —
 * from ever being called on that path.
 *
 * Fail-closed and path-safe like the `status` / profile-summary surfaces: a
 * corrupt / too-new / symlinked relation store (or any read error) drops the
 * relation edges rather than crashing the snapshot, since those problems are
 * already surfaced through the `profile` summary block. The entity collector
 * never throws on page data, so a bad page is simply skipped.
 *
 * Profile-INVALID typed pages are excluded through the SHARED
 * {@link invalidEntityPagePaths}, the same predicate the context pool and the
 * per-type counts use. Applying it once, here, is what makes the page list, the
 * graph, `status` and lint describe one corpus: a page that fails its declared
 * field contract is not promoted to a real graph node, and is likewise not
 * offered as a readable page. It stays visible as a `field-violation` problem in
 * the envelope's `profileProblems`.
 */

import { collectEntityPages, invalidEntityPagePaths } from "../profile/collect.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { buildPipelineDefinitions } from "./pipeline.js";
import type { EntityPageNode, GraphBuildOptions, RelationEdge } from "./graph.js";
import type { PipelineDefinitions } from "./pipeline.js";
import type { EntityPage, ProfilePack } from "../profile/types.js";

/** Everything the snapshot needs from the active profile's typed entity pages. */
export interface TypedViewerInputs {
  /**
   * The profile's DECLARED entity type ids, including any with no pages. The
   * allowlist `/api/page/<dir>/<slug>` validates its directory segment against.
   */
  entityTypes: string[];
  /** Every profile-VALID typed entity page, with its frontmatter and body. */
  pages: EntityPage[];
  /** The additive typed nodes + relation edges for {@link buildGraphData}. */
  graph: GraphBuildOptions;
  /**
   * What the profile DECLARES about lifecycles and relation types — the
   * `#/pipeline` panel's half that no count collector carries. Projected from
   * the SAME loaded pack the pages came from, so the panel can never describe a
   * different profile than the one that produced the corpus beside it.
   */
  pipeline: PipelineDefinitions;
}

/**
 * Collect the active non-default profile's typed entity pages once, in every
 * shape the viewer snapshot needs.
 *
 * @param root - Absolute project root directory.
 * @returns The typed inputs, or `undefined` for the built-in default profile.
 */
export async function collectTypedViewerInputs(
  root: string,
): Promise<TypedViewerInputs | undefined> {
  const loaded = await loadNonDefaultProfile(root);
  if (loaded === undefined) return undefined;
  const { pages, problems } = await collectEntityPages(root, loaded.profile);
  const invalid = invalidEntityPagePaths(problems);
  const valid = pages.filter((page) => !invalid.has(page.filePath));
  return {
    entityTypes: Object.keys(loaded.profile.entities),
    pages: valid,
    // `relations` is empty: the relation subsystem was removed, so this build
    // has no live graph to draw. The field stays because `GraphBuildOptions`
    // still accepts it and the renderer tolerates an empty edge list.
    graph: {
      entityPages: valid.map(toEntityPageNode),
      relations: [],
    },
    pipeline: buildPipelineDefinitions(loaded.profile),
  };
}

/**
 * Project a collected entity page down to the graph builder's identity-only
 * node input, dropping frontmatter, body, and the absolute `filePath` the graph
 * has no use for.
 */

/**
 * Project a collected entity page down to the graph builder's identity-only
 * node input, dropping frontmatter, body, and the absolute `filePath` the graph
 * has no use for.
 */
function toEntityPageNode(page: EntityPage): EntityPageNode {
  return {
    id: page.id,
    entityType: page.entityType,
    slug: page.slug,
    directory: page.directory,
    ...(page.title !== undefined ? { title: page.title } : {}),
  };
}
