/**
 * @file test/dimensions/template-lock-rows.test.ts
 * @description The advisory template lock as a row, with the file reader's verdicts.
 *
 * `readTemplateLock` returns a four-way verdict -- `ok`, `absent`, `malformed`,
 * `unavailable` -- and the module is explicit that "faults never masquerade as a missing
 * lock". The row backend must preserve that distinction: collapsing `malformed` into
 * `absent` would let a corrupt lock look like an uninstalled template, which is the one
 * confusion the file reader was written to prevent.
 *
 * The parser is reused, not reimplemented: `parseTemplateLock` already owns the exact-key
 * and per-version rules, so these tests pin that the ROW path reaches it, not that the
 * rules work (lock.ts's own suite covers those).
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  saveTemplateLock, readTemplateLockRow,
} from "../../src/dimensions/wiki/template-lock-store.js";
import { parseTemplateLock } from "../../src/profile/templates/lock.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** A minimal valid v1 lock document. */
const LOCK_V1 = {
  schemaVersion: 1,
  templateId: "team",
  version: "1.2.3",
  publisher: "acme",
  sourceType: "local",
  installedAt: "2026-01-01T00:00:00.000Z",
  profileDigest: "a".repeat(64), // the parser requires lowercase SHA-256 hex, not a short id
};

/** A Stack harness, torn down whatever the body does. */
async function withHarness(body: (harness: KgPostgresHarness) => Promise<void>): Promise<void> {
  const harness = await createKgPostgresHarness(`tl-${randomUUID().slice(0, 8)}`);
  try {
    await body(harness);
  } finally {
    await harness.cleanup();
  }
}

describe("template lock as a row", () => {
  it("round-trips a valid lock through the strict parser", () =>
    withHarness(async (harness) => {
      await saveTemplateLock(harness.db, harness.stackId, LOCK_V1, "digest-1");

      const stored = await readTemplateLockRow(harness.db, harness.stackId);

      // The parser is the authority; reaching `ok` proves the stored document survived
      // jsonb round-tripping without losing or reordering a required key.
      expect(parseTemplateLock(stored?.document)).toMatchObject({ kind: "ok" });
      expect(stored?.digest).toBe("digest-1");
    }));

  it("returns undefined for a Stack with no lock, distinct from malformed", () =>
    withHarness(async (harness) => {
      // Undefined is "no template installed"; it must not be reported as a fault.
      expect(await readTemplateLockRow(harness.db, harness.stackId)).toBeUndefined();
    }));

  it("lets a malformed document stay malformed rather than becoming absent", () =>
    withHarness(async (harness) => {
      // A lock missing a required key. The store must hand it back AS STORED so the
      // parser can reject it -- never silently drop the row.
      await saveTemplateLock(harness.db, harness.stackId, { schemaVersion: 1 }, "digest-2");

      const stored = await readTemplateLockRow(harness.db, harness.stackId);

      expect(stored).toBeDefined();
      expect(parseTemplateLock(stored!.document)).toMatchObject({ kind: "malformed" });
    }));

  it("replaces the previous lock rather than accumulating versions", () =>
    withHarness(async (harness) => {
      await saveTemplateLock(harness.db, harness.stackId, LOCK_V1, "digest-1");
      await saveTemplateLock(harness.db, harness.stackId, { ...LOCK_V1, version: "2.0.0" }, "digest-3");

      const stored = await readTemplateLockRow(harness.db, harness.stackId);

      // One installed template per Stack is the only state the file backend had.
      expect((stored?.document as { version: string }).version).toBe("2.0.0");
      expect(stored?.digest).toBe("digest-3");
    }));
});
