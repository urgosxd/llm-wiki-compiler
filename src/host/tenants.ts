/**
 * @file src/host/tenants.ts
 * @description Which project a request belongs to, and the per-project state the
 * host must not share between them.
 *
 * ## The defect this closes
 *
 * `startHost` took ONE `ViewerSnapshot`, frozen at startup, and served it to every
 * request. A snapshot captures a project's `root`, counts, page list, and graph at
 * build time, so a second project reaching the same listener would have been shown
 * the FIRST project's pages. Nothing about that fails loudly — it returns 200 with
 * another tenant's content — which is why it is a tenancy defect rather than a bug.
 *
 * ## Why the tenant is resolved per request, from the path
 *
 * A single listener serving many projects needs a routing key that exists before
 * any project is known. A path prefix (`/p/<slug>/...`) is that key: it needs no
 * header, no cookie, and no ambient state, so the same request means the same thing
 * regardless of who sent it. Host-header routing was rejected because Host is
 * exactly what the DNS-rebind check already validates; reusing it as a tenant key
 * would couple two unrelated decisions.
 *
 * ## Snapshots are built lazily and cached, not eagerly
 *
 * Building a snapshot reads the project's pages, so doing it for every registered
 * tenant at startup would make boot time scale with tenant count and fail entirely
 * if one project is unreadable. A tenant is built on first use instead, and a
 * failure is reported to THAT request without affecting its neighbours.
 */

import type { ViewerSnapshot } from "../viewer/types.js";
import { buildViewerSnapshot } from "../viewer/snapshot.js";

/** One project the host serves. */
export interface TenantEntry {
  /** URL segment that selects this tenant. Must be a single path segment. */
  readonly slug: string;
  /** Absolute project root, resolved by the caller that registered it. */
  readonly root: string;
}

/** A resolved tenant, with the snapshot its requests read from. */
export interface ResolvedTenant {
  readonly slug: string;
  readonly root: string;
  readonly snapshot: ViewerSnapshot;
}

/** Why a tenant could not be resolved, so the caller picks its own status. */
export type TenantFailure =
  | { readonly code: "unknown_tenant"; readonly slug: string }
  | { readonly code: "unavailable"; readonly slug: string; readonly message: string };

/** The outcome of resolving a request to a tenant. */
export type TenantResolution =
  | { readonly ok: true; readonly tenant: ResolvedTenant }
  | { readonly ok: false; readonly error: TenantFailure };

/**
 * Per-tenant snapshot cache keyed by slug.
 *
 * A Map rather than an object so a slug like `__proto__` is an ordinary key instead
 * of a prototype write — tenant slugs come from configuration, and a lookup key must
 * never be able to alter the lookup structure.
 */
const snapshots = new Map<string, Promise<ViewerSnapshot>>();

/**
 * Extract the tenant slug from a request path.
 *
 * The contract is `/p/<slug>/...`; everything else belongs to the single-project
 * surface and is handled by the caller's default tenant.
 *
 * @param pathname - Request path, without query string.
 * @returns The slug, or undefined when the path is not tenant-scoped.
 */
export function tenantSlugOf(pathname: string): string | undefined {
  const match = /^\/p\/([^/]+)(?:\/|$)/.exec(pathname);
  return match?.[1];
}

/**
 * Resolve a tenant by slug, building its snapshot on first use.
 *
 * A failed build is NOT cached: a project that is momentarily unreadable must not
 * be poisoned for the rest of the process's life. The rejection is removed from the
 * map before propagating, so the next request retries.
 *
 * @param entry - Registered tenant.
 * @returns The resolved tenant, or a coded failure.
 */
export async function resolveTenant(entry: TenantEntry): Promise<TenantResolution> {
  let pending = snapshots.get(entry.slug);
  if (pending === undefined) {
    pending = buildViewerSnapshot(entry.root);
    snapshots.set(entry.slug, pending);
    // Remove on failure so a transient read error does not become permanent.
    pending.catch(() => {
      if (snapshots.get(entry.slug) === pending) snapshots.delete(entry.slug);
    });
  }
  try {
    const snapshot = await pending;
    return { ok: true, tenant: { slug: entry.slug, root: entry.root, snapshot } };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "unavailable",
        slug: entry.slug,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Drop every cached snapshot.
 *
 * Exposed for tests and for a caller that has mutated a project outside the host
 * and needs the next request to observe it. Production does not call this: the
 * viewer deliberately does not live-watch the filesystem.
 */
export function clearTenantSnapshots(): void {
  snapshots.clear();
}
