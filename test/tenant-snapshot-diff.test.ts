/**
 * @file test/tenant-snapshot-diff.test.ts
 * @description Guard the guard: the tenant snapshot DIFF must report every mutation kind.
 *
 * ## Why a differ needs its own test
 *
 * `test/fixtures/tenant-snapshot.ts` is the primary guard of this branch (S6): every
 * cross-tenant case in the request-stack suites asserts "the ambient Stack is unchanged"
 * by running its rows through `diffTenantSnapshots` and requiring `""`. That sentence is
 * only worth something if `""` MEANS unchanged. A differ that reported `""` too eagerly —
 * comparing counts, comparing sets, iterating the wrong list — would turn every
 * cross-tenant assertion in the repository into a tautology, and it would do so while
 * looking green everywhere. So the differ is tested against each mutation kind the
 * invariant cares about: an added row, a removed row, a row CHANGED in place (which is a
 * removal plus an addition, because the row itself is the comparison unit), a move that
 * keeps the counts equal, and a duplicate removed from a pair.
 *
 * ## What these cases do NOT cover
 *
 * Nothing here touches Postgres: the capture side (`snapshotTenantRows`) and the table
 * list it iterates are exercised by the suites that use them, under a real database.
 * These cases pin the COMPARISON, which is where a silent false negative would live.
 */

import { describe, expect, it } from "vitest";
import { diffTenantSnapshots, type TenantSnapshot } from "./fixtures/tenant-snapshot.js";

const base: TenantSnapshot = {
  "wiki.pages": ['{"id":"p1","title":"Alpha"}', '{"id":"p2","title":"Beta"}'],
  "wiki.review_candidates": ['{"id":"c1"}'],
};

describe("diffTenantSnapshots detects every mutation kind (S6)", () => {
  it("identical snapshots produce an empty report", () => {
    expect(diffTenantSnapshots(base, { ...base })).toBe("");
  });

  it("an ADDED row is reported", () => {
    const after: TenantSnapshot = {
      ...base,
      "wiki.pages": [...base["wiki.pages"]!, '{"id":"p3","title":"Gamma"}'],
    };
    expect(diffTenantSnapshots(base, after)).toContain('wiki.pages + {"id":"p3","title":"Gamma"}');
  });

  it("a REMOVED row is reported", () => {
    const after: TenantSnapshot = { ...base, "wiki.pages": ['{"id":"p1","title":"Alpha"}'] };
    expect(diffTenantSnapshots(base, after)).toContain('wiki.pages - {"id":"p2","title":"Beta"}');
  });

  it("a CHANGED row is reported as removal + addition", () => {
    const after: TenantSnapshot = {
      ...base,
      "wiki.pages": ['{"id":"p1","title":"Alpha"}', '{"id":"p2","title":"BETA-EDITED"}'],
    };
    const report = diffTenantSnapshots(base, after);
    expect(report).toContain('wiki.pages - {"id":"p2","title":"Beta"}');
    expect(report).toContain('wiki.pages + {"id":"p2","title":"BETA-EDITED"}');
  });

  it("a MOVE with equal counts is reported", () => {
    const after: TenantSnapshot = {
      ...base,
      "wiki.pages": ['{"id":"p1","title":"Alpha"}', '{"id":"p9","title":"Moved"}'],
    };
    expect(diffTenantSnapshots(base, after)).not.toBe("");
  });

  it("a duplicate row removed from a pair is reported (multiset)", () => {
    const dupBefore: TenantSnapshot = { "wiki.pages": ['{"id":"p1"}', '{"id":"p1"}'] };
    const dupAfter: TenantSnapshot = { "wiki.pages": ['{"id":"p1"}'] };
    expect(diffTenantSnapshots(dupBefore, dupAfter)).toBe('wiki.pages - {"id":"p1"}');
  });
});
