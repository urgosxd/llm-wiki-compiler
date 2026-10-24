/**
 * @file test/host/tenant-routing.test.ts
 * @description One listener, several projects — and each project's requests are
 * answered from ITS OWN snapshot.
 *
 * WHY THIS EXISTS. `startHost` took one `ViewerSnapshot`, frozen at startup, and
 * served it to every request. A snapshot captures a project's root, counts, and
 * pages at build time, so a second project on the same listener would have been
 * shown the FIRST project's content — a 200 with another tenant's data, which is
 * why it is a tenancy defect and not merely a bug. No test could catch it while
 * only one project could reach the host.
 *
 * The assertions are on CONTENT, not status: two 200s that return the same page
 * list would pass a status-only test and prove nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { startHost } from "../../src/host/server.js";
import { clearTenantSnapshots, tenantSlugOf } from "../../src/host/tenants.js";

/** A project whose single concept page is named after `label`. */
async function projectNamed(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `tenant-${label}-`)));
  const concepts = path.join(root, "wiki", "concepts");
  await mkdir(concepts, { recursive: true });
  await writeFile(
    path.join(concepts, `${label}.md`),
    `---\ntitle: ${label}\nsources:\n  - a.md\n---\n\nBody for ${label}.\n`,
    "utf8",
  );
  return root;
}

afterEach(() => {
  clearTenantSnapshots();
});

describe("tenant slug extraction", () => {
  it("takes the segment after /p/ and ignores everything else", () => {
    expect(tenantSlugOf("/p/alpha/api/pages")).toBe("alpha");
    expect(tenantSlugOf("/p/alpha")).toBe("alpha");
    // Not tenant-scoped: the default project's surface.
    expect(tenantSlugOf("/api/pages")).toBeUndefined();
    expect(tenantSlugOf("/")).toBeUndefined();
  });
});

describe("a host serving two projects", () => {
  it("answers each tenant from its own snapshot, not the default one", async () => {
    const defaultRoot = await projectNamed("defaultproj");
    const alphaRoot = await projectNamed("alphaproj");
    const snapshot = await buildViewerSnapshot(defaultRoot);

    const handle = await startHost({
      viewerSnapshot: snapshot,
      port: 0,
      tenants: [{ slug: "alpha", root: alphaRoot }],
    });
    try {
      const base = `http://${handle.host}:${handle.port}`;
      const defaultPages = await fetch(`${base}/api/pages`);
      const tenantPages = await fetch(`${base}/p/alpha/api/pages`);
      expect(defaultPages.status).toBe(200);
      expect(tenantPages.status).toBe(200);

      const tenantBody = JSON.stringify(await tenantPages.json());
      // The tenant must see ITS page. The default project's page must not leak in,
      // which is the exact failure a single shared snapshot produced.
      expect(tenantBody).toContain("alphaproj");
      expect(tenantBody).not.toContain("defaultproj");

      const defaultBody = JSON.stringify(await defaultPages.json());
      expect(defaultBody).toContain("defaultproj");
    } finally {
      await handle.close();
    }
  }, 60_000);

  it("answers 404 for a slug that was never registered", async () => {
    const root = await projectNamed("solo");
    const snapshot = await buildViewerSnapshot(root);
    const handle = await startHost({ viewerSnapshot: snapshot, port: 0, tenants: [] });
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/p/ghost/api/pages`);
      // An unknown tenant must not fall through to the default project, which
      // would serve one tenant's content to a request naming another.
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it("gives TWO registered tenants different snapshots", async () => {
    // The case the other tests miss: they register one tenant, so a cache keyed by
    // a shared constant would still pass. Two tenants on ONE host is what actually
    // proves the snapshot is per-tenant rather than per-host.
    const defaultRoot = await projectNamed("hostdefault");
    const alpha = await projectNamed("alphatenant");
    const beta = await projectNamed("betatenant");
    const snapshot = await buildViewerSnapshot(defaultRoot);

    const handle = await startHost({
      viewerSnapshot: snapshot,
      port: 0,
      tenants: [
        { slug: "alpha", root: alpha },
        { slug: "beta", root: beta },
      ],
    });
    try {
      const base = `http://${handle.host}:${handle.port}`;
      const alphaBody = JSON.stringify(await (await fetch(`${base}/p/alpha/api/pages`)).json());
      const betaBody = JSON.stringify(await (await fetch(`${base}/p/beta/api/pages`)).json());

      expect(alphaBody).toContain("alphatenant");
      expect(alphaBody).not.toContain("betatenant");
      expect(betaBody).toContain("betatenant");
      expect(betaBody).not.toContain("alphatenant");
    } finally {
      await handle.close();
    }
  }, 60_000);

  it("keeps the default surface working when tenants are registered", async () => {
    const root = await projectNamed("mainproj");
    const other = await projectNamed("otherproj");
    const snapshot = await buildViewerSnapshot(root);
    const handle = await startHost({
      viewerSnapshot: snapshot,
      port: 0,
      tenants: [{ slug: "other", root: other }],
    });
    try {
      const base = `http://${handle.host}:${handle.port}`;
      // Adding tenants must not change the single-project surface.
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
      expect((await fetch(`${base}/p/other/api/health`)).status).toBe(200);
    } finally {
      await handle.close();
    }
  }, 60_000);
});
