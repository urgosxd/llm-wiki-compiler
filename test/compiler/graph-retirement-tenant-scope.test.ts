/**
 * @file test/compiler/graph-retirement-tenant-scope.test.ts
 * @description Graph retirement touches ONLY the named Stack's rows, pinned as a
 * committed test instead of a one-time database probe.
 *
 * ## What this case pins
 *
 * `S7` of `odd/tasks/graph-retirement-live.md` requires the tenant boundary to be
 * asserted rather than assumed: "retirement must only touch the named Stack's rows."
 * The mechanism is a single statement — `forgetDocumentRows`
 * (`packages/llmwiki-kg/ts/src/core/document-consolidation.ts:563`) runs
 * `delete from stack_documents where stack_id = ${stackId} and storage_path = ${source}`
 * — and the Stack comes from `options.stackId`, bound at
 * `packages/wiki/src/dimensions/kg/index.ts:473`. The scoping is therefore a property
 * of the SQL predicate, not of a caller-side filter, which is exactly why it needs a
 * row-level assertion: a predicate that loses its `stack_id` clause still deletes
 * quietly and still reports a successful compile.
 *
 * ## The second Stack holds the SAME `storage_path` on purpose
 *
 * The compiler registers a document with the SOURCE IDENTITY in `storage_path`
 * (`dimensions/kg/index.ts:441`–`:444`), so two Stacks that ingested the same source
 * hold rows with an identical `storage_path` and differ only by `stack_id`. That is
 * the shape that makes `storage_path` alone ambiguous: a delete scoped by
 * `storage_path` silently reaches the other tenant, while a compile over a Stack with
 * a unique path would pass even with the predicate gone. The second tenant is this
 * suite's own harness Stack, so its rows belong to the fixture and never to an
 * operator.
 *
 * ## The REAL kg dimension runs, and no port is injected
 *
 * `compileAndReport` is called with `embeddings: false` and no `dimensionsPort`, so
 * `resolveDimensions` builds the real graph dimension and the retirement really
 * executes the SQL above against this process's database. A recording port would
 * prove which identities compile asked to forget and nothing at all about scoping.
 *
 * ## Why a one-time probe was not enough
 *
 * The boundary was proven once, by a scratch database probe in an earlier slice of
 * this work, and that proof died with the scratch directory: nothing in the suite
 * would have noticed if a later edit dropped the `stack_id` clause. This file is the
 * durable half — it fails on real rows when the predicate is removed, which is
 * recorded in `odd/tasks/graph-retirement-live.md` as the measured mutation.
 *
 * There is no `describe.skipIf`: the harness throws loudly when no database can be
 * obtained, and a skipped case asserts nothing about a deletion.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";

import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { resolveStackForCommand } from "../../packages/wiki/src/services/stacks/resolve-stack.js";
import type { CompileOptions } from "../../packages/wiki/src/utils/types.js";
import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { seedDeletedSourceRows } from "./retirement-port-project.js";

/** Identity the seed records, and the `storage_path` the graph keys it under. */
const DELETED_SOURCE_IDENTITY = "https://example.test/deleted-source";

const harness = await createKgPostgresHarness("graph-retirement-tenant-scope");

/**
 * Graph enabled, and the Stack this suite created: the compile retires inside ONE tenant.
 *
 * The Stack used to be resolved (and provisioned) at the default domain because this
 * environment named none. That provisioning is deleted by S1, so the run NAMES the Stack
 * it owns — exactly what an operator does once `POST /stacks` has answered.
 */
const RETIREMENT_ENV: NodeJS.ProcessEnv = {
  AKS_DATABASE_URL: DATABASE_URL,
  LLMWIKI_DIMENSIONS: "kg",
  AKS_STACK_ID: harness.stackId,
};

/** Compile options shared by the seeding run and the measured run. */
const COMPILE_OPTIONS: Partial<CompileOptions> = { env: RETIREMENT_ENV, embeddings: false };

afterAll(() => harness.cleanup());

/**
 * Register the deleted source's document, and one chunk of it, under one Stack.
 *
 * Both inserts state the columns `schema.sql` requires and let every other column
 * default, so this seeds exactly the rows retirement and its cascade can remove.
 *
 * @param stackId - Tenant to hold the rows.
 */
async function seedDocumentWithChunk(stackId: string): Promise<void> {
  await harness.db.execute(sql`
    insert into stack_documents (stack_id, filename, storage_path, size_bytes, source_hash)
    values (${stackId}, 'deleted-source.md', ${DELETED_SOURCE_IDENTITY}, 12, 'hash-of-deleted-source')
  `);
  await harness.db.execute(sql`
    insert into document_chunks (document_id, stack_id, chunk_index, content, content_hash)
    select id, ${stackId}::uuid, 0, 'text', 'chunk-hash-of-deleted-source'
    from stack_documents where stack_id = ${stackId}::uuid and storage_path = ${DELETED_SOURCE_IDENTITY}
  `);
}

/**
 * Rows of `stack_documents` holding the deleted source.
 *
 * @param stackId - Tenant to count within, or `undefined` for every Stack.
 * @returns The row count.
 */
async function documentRows(stackId?: string): Promise<number> {
  const inTenant = stackId === undefined ? sql`true` : sql`stack_id = ${stackId}`;
  const rows = await harness.db.execute<{ count: number }>(sql`
    select count(*)::int as count from stack_documents
    where storage_path = ${DELETED_SOURCE_IDENTITY} and ${inTenant}
  `);
  return rows.map((row) => row.count)[0] ?? 0;
}

/**
 * Rows of `document_chunks` whose document holds the deleted source, in one Stack.
 *
 * Children are counted through their document rather than by `stack_id` alone, so the
 * count is the cascade's own trace and not a number this fixture put there.
 *
 * @param stackId - Tenant to count within.
 * @returns The row count.
 */
async function chunkRows(stackId: string): Promise<number> {
  const rows = await harness.db.execute<{ count: number }>(sql`
    select count(*)::int as count from document_chunks
    where stack_id = ${stackId}
      and document_id in (
        select id from stack_documents where storage_path = ${DELETED_SOURCE_IDENTITY}
      )
  `);
  return rows.map((row) => row.count)[0] ?? 0;
}

/**
 * The OTHER tenant, created beside the one the run names.
 *
 * This case used to get its second tenant for free: the run resolved the default Stack, and
 * `harness.stackId` was a different row. S1 deletes that Stack, the run now names
 * `harness.stackId`, and the boundary the case measures would collapse into one tenant — the
 * deletion seeded under the run's own Stack twice, measured against itself. So the second
 * tenant is created here, by name, like any other Stack.
 *
 * @returns The id of the row it created.
 */
async function otherTenant(): Promise<string> {
  const id = randomUUID();
  const domain = `other-tenant-${randomUUID().slice(0, 8)}`;
  await harness.db.execute(
    sql`insert into stacks (id, name, domain) values (${id}::uuid, ${domain}, ${domain})`,
  );
  return id;
}

describe("graph retirement tenant scope", () => {
  it("retires the deleted source only inside the Stack that owns it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "retirement-tenant-"));
    try {
      captureProcessIo();
      // The Stack this run NAMES, so the deletion belongs to the tenant the compile reads —
      // otherwise the run has nothing to retire and the boundary below would prove nothing.
      const owningStack = await resolveStackForCommand(harness.db, RETIREMENT_ENV);
      const untouched = await otherTenant();
      await seedDeletedSourceRows(harness.db, owningStack);
      await seedDocumentWithChunk(owningStack);
      await seedDocumentWithChunk(untouched);
      const totalBefore = await documentRows();

      const result = await compileAndReport(dir, COMPILE_OPTIONS);

      // The run really processed the deletion and succeeded, so what follows is an
      // observed scoped retirement rather than a run that never got that far.
      expect(result).toMatchObject({ deleted: 1, errors: [] });
      // The other tenant's rows — same `storage_path`, different Stack — are intact.
      expect(await documentRows(untouched)).toBe(1);
      expect(await chunkRows(untouched)).toBe(1);
      // And exactly one row left the table: the owning Stack's, no more.
      expect(await documentRows()).toBe(totalBefore - 1);
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
