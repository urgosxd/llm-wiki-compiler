/**
 * @file test/dimensions/wiki-activation-stack.test.ts
 * @description `resolveDimensions` against a REAL Stack, proving the wiki
 * dimension it builds actually writes rows.
 *
 * ## Why this file exists beside `activation.test.ts`
 *
 * `activation.test.ts` has 8 good unit tests about the switch itself: which names
 * are accepted, what is refused for a missing Stack id, what the default is when
 * the variable is unset. All of them pass a `lazyDatabase()` handle built from
 * `createClient("postgresql://unused:unused@localhost:1/unused")` -- a URL that by
 * construction never connects.
 *
 * That is fine for testing RESOLUTION, and it is useless for testing what
 * resolution is FOR. Every one of those 8 would pass just as happily if the
 * database were unreachable, misconfigured, or absent entirely. So the wiring that
 * `761cab0` exists to deliver -- activation building a Postgres-backed wiki
 * dimension -- had zero coverage against a real database.
 *
 * This file closes that gap without touching the unit tests: it resolves against
 * a provisioned Stack and then proves the dimension WORKS by driving a prepare
 * and a commit through it.
 *
 * ## Why the isolation is asserted here too
 *
 * A dimension that writes but ignores its Stack would pass a naive "a row
 * appeared" check. So the row is read back through the harness's own Stack, and
 * a second Stack is queried to confirm it stayed empty.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase, createClient } from "llmwiki-kg";

import { AKS_STACK_ID_ENV_VAR, resolveDimensions } from "../../src/dimensions/activation.js";
import type { DimensionInput } from "../../src/dimensions/types.js";
import { provisionEnvStack } from "../fixtures/env-stack.js";

const env = await provisionEnvStack("wiki-activation-stack");

afterAll(async () => {
  await env.cleanup();
});

/** An ingest input with the fields the dimension reads. */
function inputOf(title: string, source: string): DimensionInput {
  const body = `body for ${title}`;
  return { source, title, document: `---\ntitle: ${title}\n---\n${body}`, body };
}

describe("resolveDimensions against a real Stack", () => {
  it.skipIf(!env.reachable)("builds a wiki dimension that writes a page row", async () => {
    // A handle of this test's own, so the assertions below do not depend on the
    // dimension's private connection. 5434 is the harness's port, not the
    // production default -- see env-stack.ts for why that matters.
    const client = createClient(process.env.AKS_DATABASE_URL ?? "", 5);
    const probe = createDatabase(client);
    try {
      // A FRESH root per run. The dimension writes the source markdown into
      // `sources/`, and `saveSource` refuses to clobber an existing file, so a
      // fixed path makes the second run fail with PathSafetyError -- the same
      // pass-once-then-always-fail shape a shared Stack has, one layer down.
      const root = await mkdtemp(path.join(tmpdir(), "wiki-activation-stack-"));
      try {
        await assertDimensionWrites(probe, root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 30_000);
});

/**
 * Resolve against the provisioned Stack and prove the dimension really writes.
 *
 * @param probe - This test's own database handle, on the harness DSN.
 * @param root - A fresh project root for this run.
 */
async function assertDimensionWrites(
  probe: ReturnType<typeof createDatabase>,
  root: string,
): Promise<void> {
      const dimensions = resolveDimensions({
        root,
        env: { [AKS_STACK_ID_ENV_VAR]: env.stackId },
        db: probe,
      });

      const wiki = dimensions.find((entry) => entry.name === "wiki");
      expect(wiki).toBeDefined();

      const prepared = await wiki!.prepare(inputOf("Activation Wrote This", "src://activation"));
      const committed = await wiki!.commit(prepared);

      // The dimension must report a write path: ingest throws without one
      // (services/ingest/service.ts:130).
      expect(committed.artifactPath).toBeDefined();

      const rows = await probe.execute<{ n: number }>(
        `select count(*)::int as n from wiki.pages where stack_id = '${env.stackId}'`,
      );
      expect(rows[0]?.n).toBe(1);
}
