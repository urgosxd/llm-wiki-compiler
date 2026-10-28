/**
 * @file test/mcp/list-stacks.test.ts
 * @description Pin what `list_stacks` answers, against a real database.
 *
 * ## What is actually contractual here
 *
 * The tool was requested so a client could discover Stack ids instead of scraping
 * `GET /stacks`. Its contract MIRRORS that route: it lists what the connection can
 * see, and marks the one this deployment is bound to. It deliberately does not
 * narrow to the bound Stack, because `auth.ts` records that identity is not
 * attached per request and "there is no per-key row ownership" — the boundary is the
 * API key plus one deployment per Stack-set, not a row filter.
 *
 * An earlier version of this file asserted "no Stack from another tenant leaks".
 * That was removed: it asserted isolation the product does not implement, it passed
 * only against a policy-bypassing superuser DSN, and it would have encoded a false
 * security claim as a green test.
 *
 * What remains is the part a caller depends on: the bound Stack is present, is
 * marked current, and survives a limit of one — the deployment measured it 2915th of
 * 2916 by `updated_at`, so recency ordering alone hid it from every bounded listing.
 */
import { describe, it, expect } from "vitest";
import { stackHarnessRunner } from "../fixtures/stack-harness.js";
import { listStacks } from "../../src/services/stacks/stack-store.js";

const withHarness = stackHarnessRunner("list-stacks");

describe("list_stacks", () => {
  it("returns the bound Stack first", async () => {
    await withHarness(async (harness) => {
      if (!harness.reachable) return;
      const stacks = await listStacks(harness.db, harness.stackId);
      expect(stacks.length).toBeGreaterThan(0);
      expect(stacks[0]?.id).toBe(harness.stackId);
    });
  });

  it("marks only the bound Stack as current", async () => {
    await withHarness(async (harness) => {
      if (!harness.reachable) return;
      const stacks = await listStacks(harness.db, harness.stackId);
      const current = stacks.filter((stack) => stack.isCurrent);
      expect(current).toHaveLength(1);
      expect(current[0]?.id).toBe(harness.stackId);
    });
  });

  it("keeps the bound Stack first even when another was updated later", async () => {
    await withHarness(async (harness) => {
      if (!harness.reachable) return;
      // Recency alone would put this one first: it is updated in the future. Without
      // the `id = bound` tiebreaker the bound Stack falls behind it, and at the
      // deployment's real size it fell out of every bounded listing entirely.
      const newerId = crypto.randomUUID();
      const domain = `list-stacks-newer-${crypto.randomUUID().slice(0, 8)}`;
      await harness.db.execute(
        `insert into stacks (id, name, domain, updated_at)
         values ('${newerId}', 'newer', '${domain}', now() + interval '1 hour')`,
      );
      try {
        const stacks = await listStacks(harness.db, harness.stackId);
        expect(stacks[0]?.id).toBe(harness.stackId);
      } finally {
        await harness.db.execute(`delete from stacks where id = '${newerId}'`).catch(() => undefined);
      }
    });
  });

  it("honours a limit of one without dropping the bound Stack", async () => {
    await withHarness(async (harness) => {
      if (!harness.reachable) return;
      const stacks = await listStacks(harness.db, harness.stackId, 1);
      expect(stacks).toHaveLength(1);
      expect(stacks[0]?.id).toBe(harness.stackId);
    });
  });

  it("omits the ontology column, so a listing stays cheap", async () => {
    await withHarness(async (harness) => {
      if (!harness.reachable) return;
      const [first] = await listStacks(harness.db, harness.stackId, 1);
      expect(first).toBeDefined();
      expect(Object.hasOwn(first as object, "ontology")).toBe(false);
    });
  });

});
