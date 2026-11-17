/**
 * The viewer's two page endpoints: the `/api/pages` bootstrap envelope and the
 * per-page `/api/page/:directory/:slug` payload.
 *
 * Split out of `server.ts` at the `handleApi*` seam so that file stays about
 * transport — security headers, origin policy, routing — while everything that
 * decides what a page LOOKS LIKE over the wire lives together. Both handlers
 * serve from the frozen `ViewerSnapshot` and never touch the filesystem.
 *
 * The directory segment of `/api/page/:directory/:slug` is the security-relevant
 * input here. It used to be a comparison against two literals; a non-default
 * profile's entity types are addressable too, so it is now confined by an
 * allowlist DERIVED FROM THE ACTIVE PROFILE — see {@link isAllowedDirectory} for
 * why that is a membership test on a raw segment rather than a decode-and-match.
 *
 * ## Why `/api/pages` resolves a Stack per request
 *
 * It served one snapshot built at boot, so a Stack created afterwards was served as an
 * empty corpus until the process restarted and a deactivated Stack kept being served —
 * S5/T14 of `odd/tasks/production-blockers-viewer-and-foundation.md`. A request that names
 * its Stack (`?stackId=`) now has that Stack validated against its `stacks` row the same way
 * `/api/reviews` validates it, and gets a snapshot built on first read and cached under the
 * epoch the row reports ({@link PagesSnapshotCache}). A request that names NONE keeps being
 * served the boot snapshot, which is S9's recorded narrowing: the bundled shell fetches this
 * route with no query, so refusing there would blank every database-backed dashboard.
 */

import type { ServerResponse } from "http";
import { sql } from "drizzle-orm";
import { stackIdProblem } from "@repo/foundation";
import {
  MissingStackColumnError,
  missingActiveColumnCause,
  missingActiveColumnRefusal,
} from "@repo/foundation/stack-migration";
import { pageTimestamp, viewerPageKind } from "./page-fields.js";
import { assertSafeSlug, PathSafetyError } from "./path-safety.js";
import {
  namedStackRefusal,
  stackLookupFailedRefusal,
  tryRenderBody,
  writeJson,
  writeJsonError,
  writeRenderFailed,
  writeStackRefusal,
} from "./respond.js";
import { buildViewerSnapshot } from "./snapshot.js";
import { UNRESOLVED_CITATION_CODE } from "./types.js";
import type { ViewerPage, ViewerPageDirectory, ViewerSnapshot } from "./types.js";
import type { PageDirectory } from "../export/types.js";
import { createDimensionsDatabase } from "../dimensions/activation.js";
import type { StackAuthority } from "../dimensions/stack-authority.js";
import type { StackResolution } from "../services/stacks/stack-store.js";

/** Profile id reported when the project runs the built-in default profile. */
const DEFAULT_PROFILE_ID = "default";

/**
 * The two directories every project can address, whatever profile it runs.
 * Typed as `PageDirectory` so widening that shared union without revisiting this
 * allowlist is a compile error rather than a silently unreachable directory.
 */
const DEFAULT_DIRECTORIES: readonly PageDirectory[] = ["concepts", "queries"];

/**
 * `/api/pages` — the full bootstrap envelope, for the Stack THIS request names.
 *
 * The boot snapshot is the answer for a request that names no Stack (S9's narrowing: the bundled
 * shell fetches with no query), and the file backend's own answer when no database is configured.
 * Every NAMED request is served from a snapshot of the Stack it named, which is what makes a
 * Stack created or retired a moment ago visible to the next read instead of to the next restart.
 *
 * @param res - Response to write, including any refusal.
 * @param snapshot - The boot snapshot; supplies the project root, and is the unnamed answer.
 * @param url - This request's URL, carrying the Stack the caller named.
 * @param cache - This process's per-Stack snapshot cache.
 */
export async function handleApiPages(
  res: ServerResponse,
  snapshot: ViewerSnapshot,
  url: URL,
  cache: PagesSnapshotCache,
): Promise<void> {
  const source = await pagesSourceFor(res, (url.searchParams.get("stackId") ?? "").trim());
  if (source.kind === "refused") return;
  if (source.kind === "boot") return writePagesEnvelope(res, snapshot);
  writePagesEnvelope(res, await stackSnapshot(snapshot.root, source, cache));
}

/** Write the bootstrap envelope for one snapshot. */
function writePagesEnvelope(res: ServerResponse, snapshot: ViewerSnapshot): void {
  writeJson(res, 200, {
    project: snapshot.project,
    stateStatus: snapshot.stateStatus,
    profileId: DEFAULT_PROFILE_ID,
    counts: {
      concepts: snapshot.counts.concepts,
      queries: snapshot.counts.queries,
      sourceFiles: snapshot.counts.sourceFiles,
      pendingReviews: snapshot.counts.pendingReviews,
      compiledSources: snapshot.counts.compiledSources,
      stale: snapshot.counts.stale,
      orphaned: snapshot.counts.orphaned,
    },
    graph: graphSummary(snapshot),
    sourceFilenames: snapshot.sourceFilenames,
    index: { available: snapshot.index.available, href: snapshot.index.href },
    recentPages: snapshot.recentPages,
    pages: snapshot.pages.map(pageListRow),
    updatedAt: snapshot.generatedAt,
  });
}

/**
 * What one `/api/pages` request reads, or the refusal that was already written.
 *
 * `boot` is the snapshot this process froze at startup, and it is the answer for a request that
 * names NO Stack — the narrowed S9 recorded in
 * `odd/tasks/production-blockers-viewer-and-foundation.md`: the bundled shell fetches this route
 * with no query, so refusing here would blank the dashboard of every database-backed deployment.
 * `refused` is a kind of its own rather than an absent answer, because a refusal is not a source.
 */
type PagesSource =
  | { readonly kind: "boot" }
  | { readonly kind: "stack"; readonly stackId: string; readonly epoch: string }
  | { readonly kind: "refused" };

/** The database handle this module reads one `stacks` row through. */
type PagesDatabase = ReturnType<typeof createDimensionsDatabase>["db"];

/**
 * One snapshot per Stack, cached, with the epoch it was built from.
 *
 * ## What invalidates it, in one sentence
 *
 * The `stacks` row's `updated_at`: an entry is served only when the epoch stored beside it
 * equals the row's current `updated_at`, and `POST /stacks` (insert, `now()`) and
 * `DELETE /stacks/:id` (`set active = false, updated_at = now()`) both advance that column.
 * A Stack with no entry has none to serve, and a retired Stack is refused BEFORE this map is
 * consulted, so no entry can outlive its Stack's deactivation.
 *
 * ## Why it lives in the handler's closure
 *
 * One map per handler, created by its owner. A module-level map would be the "built once per
 * process" defect at a finer grain: it would serve one host's Stacks to the next host built in
 * the same process, which is every test that builds two.
 *
 * ## Page writes move it too
 *
 * A page write advances that same column — in the SAME transaction that commits the rows, by
 * `advanceStackEpoch` in `packages/wiki/src/dimensions/wiki/page-store.ts` — so the epoch a
 * later read compares against has moved, the cached snapshot no longer matches it, and the
 * Stack's corpus is rebuilt instead of being served as it stood at the first read. A corpus
 * that grows after a Stack's first read therefore stays visible.
 */
export interface PagesSnapshotCache {
  /** The snapshot built from this exact epoch, or `undefined` when the cache holds another. */
  get(stackId: string, epoch: string): ViewerSnapshot | undefined;
  /** Remember one Stack's snapshot under the epoch it was built from. */
  set(stackId: string, epoch: string, snapshot: ViewerSnapshot): void;
}

/**
 * Build an empty per-Stack cache. One per handler closure; never a module singleton.
 *
 * @returns A cache keyed by Stack id and validated by epoch.
 */
export function createPagesSnapshotCache(): PagesSnapshotCache {
  const entries = new Map<string, { epoch: string; snapshot: ViewerSnapshot }>();
  return {
    get: (stackId, epoch) => {
      const entry = entries.get(stackId);
      return entry !== undefined && entry.epoch === epoch ? entry.snapshot : undefined;
    },
    set: (stackId, epoch, snapshot) => {
      entries.set(stackId, { epoch, snapshot });
    },
  };
}

/**
 * Settle, and validate, the Stack one `/api/pages` request is about.
 *
 * The refusal codes are the four that already exist rather than a second vocabulary for the same
 * facts, and a named id is validated exactly as `/api/reviews` validates it.
 *
 * ## An UNNAMED request is served the boot snapshot, not refused
 *
 * Deliberately different from `/api/reviews`, and the difference is measured rather than
 * stylistic: the bundled shell fetches `/api/pages` with no query at all
 * (`packages/wiki/src/viewer/assets/viewer.js:104`) and renders `Could not load /api/pages` when
 * it fails (`:260`), so answering 409 there blanks the dashboard of every database-backed
 * deployment. The boot snapshot is what such a deployment served before this change and what it
 * keeps serving; a caller that wants a SPECIFIC Stack names it. S9 of
 * `odd/tasks/production-blockers-viewer-and-foundation.md` records this narrowing with the six
 * pinned assertions that decided it, so nobody restores the refusal as a "fix".
 *
 * @param res - Response to write any refusal on.
 * @param named - The trimmed `stackId` query value; empty when the request named none.
 * @returns The backend to read, or `refused` once the envelope was written.
 */
async function pagesSourceFor(res: ServerResponse, named: string): Promise<PagesSource> {
  if (named === "") return { kind: "boot" };
  const problem = stackIdProblem(named);
  if (problem !== undefined) {
    writeJsonError(res, 400, "invalid_stack_id", problem);
    return { kind: "refused" };
  }
  const dimensions = createDimensionsDatabase(process.env);
  try {
    return await namedPagesSource(res, dimensions.db, named);
  } catch (error) {
    writeStackRefusal(res, stackLookupFailedRefusal(named, error));
    return { kind: "refused" };
  } finally {
    await dimensions.close();
  }
}

/**
 * The Stack a validated id names, dated with the epoch the cache is keyed by.
 *
 * @param res - Response to write the refusal on.
 * @param db - Handle the row is read through.
 * @param stackId - A validated Stack id.
 * @returns The Stack to read from, or `refused` once the refusal was written.
 */
async function namedPagesSource(
  res: ServerResponse,
  db: PagesDatabase,
  stackId: string,
): Promise<PagesSource> {
  const row = await stackEpochRow(db, stackId);
  const refusal = namedStackRefusal(stackId, row.resolution);
  if (refusal !== undefined) {
    writeStackRefusal(res, refusal);
    return { kind: "refused" };
  }
  return { kind: "stack", stackId, epoch: row.epoch };
}

/**
 * What the `stacks` row says: whether the Stack may be used, and the epoch it last moved at.
 *
 * ONE read of the row, because both answers are needed before the cache is consulted and a
 * second query would be a second snapshot of a row that can change between them. `updated_at`
 * is selected as text so the epoch compared here is byte-stable across driver versions instead
 * of depending on how a `Date` serialises.
 *
 * The missing-migration refusal is `@repo/foundation`'s, reused rather than restated: a
 * database that never ran `db/migration_stack_active.sql` must name that file here exactly as
 * it does on every other Stack lookup.
 *
 * @param db - Handle the row is read through.
 * @param stackId - A validated Stack id.
 * @returns The tri-state resolution and the `updated_at` epoch (`""` for an absent row).
 * @throws {MissingStackColumnError} when the database never ran the migration.
 */
async function stackEpochRow(
  db: PagesDatabase,
  stackId: string,
): Promise<{ resolution: StackResolution; epoch: string }> {
  try {
    const rows = await db.execute<{ active: boolean; epoch: string }>(
      sql`select active, updated_at::text as epoch from stacks where id = ${stackId}`,
    );
    const row = rows[0];
    if (row === undefined) return { resolution: "absent", epoch: "" };
    return { resolution: row.active ? "active" : "inactive", epoch: row.epoch };
  } catch (error) {
    const cause = missingActiveColumnCause(error);
    if (cause === undefined) throw error;
    // Named, and never swallowed: Postgres's error stays reachable as `cause`.
    throw new MissingStackColumnError(missingActiveColumnRefusal(), { cause });
  }
}

/**
 * The snapshot for one Stack: the cached one while its epoch holds, a fresh one otherwise.
 *
 * `buildViewerSnapshot` receives the authority resolved from the REQUEST, which is what makes
 * every Stack-scoped read inside it describe this Stack instead of re-reading the environment.
 *
 * @param root - Project root the snapshot is labelled with.
 * @param source - The Stack this request names, with the epoch it was resolved at.
 * @param cache - This process's per-Stack snapshot cache.
 * @returns The snapshot to serve.
 */
async function stackSnapshot(
  root: string,
  source: Extract<PagesSource, { kind: "stack" }>,
  cache: PagesSnapshotCache,
): Promise<ViewerSnapshot> {
  const cached = cache.get(source.stackId, source.epoch);
  if (cached !== undefined) return cached;
  const authority: StackAuthority = { kind: "stack", stackId: source.stackId };
  const built = await buildViewerSnapshot(root, process.env, authority);
  cache.set(source.stackId, source.epoch, built);
  return built;
}

/**
 * Node/edge/dangling totals for the dashboard's graph panel and its
 * "needs attention" card. Summarised here so the dashboard does not have
 * to fetch the full `/api/graph` adjacency payload for three integers.
 */
function graphSummary(snapshot: ViewerSnapshot): Record<string, number> {
  return {
    nodeCount: snapshot.graph.nodes.length,
    edgeCount: snapshot.graph.edges.length,
    danglingCount: snapshot.graph.nodes.filter((node) => node.isDangling === true).length,
  };
}

/** Count a page's warnings carrying the given stable code. */
function countWarnings(page: ViewerPage, code: string): number {
  return page.warnings.filter((warning) => warning.code === code).length;
}

/** Per-page row shape returned in `/api/pages.pages`. */
function pageListRow(page: ViewerPage): Record<string, unknown> {
  return {
    id: page.id,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    title: page.title,
    kind: viewerPageKind(page),
    summary: typeof page.frontmatter.summary === "string" ? page.frontmatter.summary : "",
    updatedAt: pageTimestamp(page.frontmatter),
    warnings: page.warnings,
    freshness: page.freshness,
    citationCount: page.citations.length,
    unresolvedCitationCount: countWarnings(page, UNRESOLVED_CITATION_CODE),
    ...entityTypeField(page),
  };
}

/**
 * The page's `entityType`, serialised ONLY for a typed entity page. Omitted (key
 * absent) on every default page, so a default project's rows are byte-identical
 * and a client can treat absence as "this is a default concept or query".
 */
function entityTypeField(page: ViewerPage): Record<string, unknown> {
  return page.entityType !== undefined ? { entityType: page.entityType } : {};
}

/**
 * `/api/page/:directory/:slug` — single page payload with server-rendered
 * sanitized HTML. Serves default `concepts`/`queries` pages and, on a project
 * running a non-default profile, typed entity pages at their entity type
 * (`/api/page/articles/<slug>`). Any warnings come from the collector
 * (missing/malformed frontmatter, missing title) or the citation annotator.
 */
export function handleApiPage(
  res: ServerResponse,
  pathname: string,
  snapshot: ViewerSnapshot,
  isLoopback: boolean,
): void {
  const segments = pathname.replace(/^\/api\/page\//, "").split("/");
  if (segments.length !== 2) {
    writeJsonError(res, 400, "bad_request", "Expected /api/page/:directory/:slug");
    return;
  }
  const [directorySegment, encodedSlug] = segments;
  const target = safeDecodeSlug(directorySegment, encodedSlug, addressableDirectories(snapshot));
  if (!target) {
    writeJsonError(res, 400, "bad_request", "Invalid directory or slug.");
    return;
  }
  const page = snapshot.pages.find(
    (p) => p.pageDirectory === target.directory && p.slug === target.slug,
  );
  if (!page) {
    writeJsonError(res, 404, "page_not_found", `${target.directory}/${target.slug}`);
    return;
  }
  writePageOrRenderFailure(res, page, snapshot, isLoopback);
}

/** Render the page body and write its payload, or the `render_failed` envelope. */
function writePageOrRenderFailure(
  res: ServerResponse,
  page: ViewerPage,
  snapshot: ViewerSnapshot,
  isLoopback: boolean,
): void {
  const rendered = tryRenderBody(page.body, snapshot, isLoopback);
  if (rendered === null) {
    writeRenderFailed(res);
    return;
  }
  writeJson(res, 200, pagePayload(page, snapshot, rendered.html));
}

/**
 * Every directory segment this snapshot will address: the two default literals
 * plus the ACTIVE PROFILE's declared entity type ids. Built from the frozen
 * snapshot, so it is the profile's own declaration and never anything derived
 * from the request. A default project contributes nothing extra, so no typed
 * directory is addressable there.
 */
function addressableDirectories(snapshot: ViewerSnapshot): ReadonlySet<string> {
  return new Set<string>([...DEFAULT_DIRECTORIES, ...(snapshot.entityTypes ?? [])]);
}

/**
 * Decode the slug and confine the directory so a bad input on either fails with
 * one uniform 400. Resolves with `null` for any structural rejection.
 */
function safeDecodeSlug(
  directorySegment: string,
  encodedSlug: string,
  allowed: ReadonlySet<string>,
): { directory: ViewerPageDirectory; slug: string } | null {
  if (!isAllowedDirectory(directorySegment, allowed)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedSlug);
  } catch {
    return null;
  }
  if (!isSafeSlug(decoded)) return null;
  return { directory: directorySegment, slug: decoded };
}

/**
 * A directory segment is addressable only when it clears the SAME structural
 * floor a slug does — no `.`/`..`, no separators, no NUL — and is a member of
 * the profile-derived allowlist. Never a pattern match on the request.
 *
 * The segment is deliberately NOT percent-decoded first. `concepts`, `queries`
 * and every profile entity type id are slug-safe by construction (the grammar in
 * `src/profile/identity.ts`, plus `rejectReservedEntityTypeNames` in
 * `src/profile/validate.ts` keeping entity types disjoint from the two default
 * names), so a legitimate directory never needs encoding. Refusing to decode
 * leaves exactly one spelling per directory and denies a caller the decode pass
 * that would be needed to smuggle `..`, a separator, or a NUL through as one.
 */
function isAllowedDirectory(segment: string, allowed: ReadonlySet<string>): boolean {
  return isSafeSlug(segment) && allowed.has(segment);
}

/** True when `value` clears `assertSafeSlug`; a `PathSafetyError` is the rejection. */
function isSafeSlug(value: string): boolean {
  try {
    assertSafeSlug(value);
    return true;
  } catch (err) {
    if (err instanceof PathSafetyError) return false;
    throw err;
  }
}

/** Build the JSON payload for `/api/page/:dir/:slug`. */
function pagePayload(
  page: ViewerPage,
  snapshot: ViewerSnapshot,
  renderedHtml: string,
): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    html: renderedHtml,
    citations: page.citations,
    outgoingLinks: page.outgoingLinks,
    frontmatter: page.frontmatter,
    warnings: page.warnings,
    freshness: page.freshness,
    updatedAt: pageTimestamp(page.frontmatter),
    // Literal, NOT `pageTimestamp`: this field means "when was the page first
    // written", so it must never inherit an `updatedAt`.
    createdAt:
      typeof page.frontmatter.createdAt === "string" ? (page.frontmatter.createdAt as string) : "",
    generatedAt: snapshot.generatedAt,
    ...(page.entityType !== undefined && page.entityContext ? { entityContext: page.entityContext } : {}),
    ...entityTypeField(page),
  };
}
