/**
 * @file test/dimensions/kg-runtime-app-role-write.test.ts
 * @description The `kg` dimension's WRITE path under the application role, with
 * row-level security actually enforced.
 *
 * ## Why this file exists
 *
 * Every other suite in this repository connects as `aks`, which is a SUPERUSER
 * with `BYPASSRLS`. Measured on that connection, row-level security is INERT: the
 * policies never run, so "the two Stacks stayed apart" proves only that the SQL
 * carried a `where stack_id = ...`, never that the database would refuse a
 * mistake. That is a weaker guarantee than the word "isolation" suggests, and it
 * is exactly the gap `kg-runtime-rls-trap` names.
 *
 * Dropping to `llmwiki_app` found a real defect: `registerDocumentRow` is the one
 * write in `core/document-consolidation.ts` that does NOT call `bindCallerStack`,
 * while its two siblings do. Under the app role the document insert is refused
 * with SQLSTATE 42501 and the whole graph write fails. It is harmless today only
 * because production connects as `aks`; a role migration would break document
 * registration with no test to catch it.
 *
 * ## Why the assertion is on the whole dimension, not on one function
 *
 * A unit test that called `registerDocumentRow` directly would have caught the
 * bug, but it would not prove the DIMENSION works: the fix could bind the tenant
 * in the wrong place and still pass. So this drives `prepare` + `commit` under the
 * app role, which is the path an operator actually runs.
 *
 * ## Skipping is loud, never vacuous
 *
 * `set local role` needs the role to exist. Without it this suite reports
 * SKIPPED, because a body that returns early is recorded as a pass and would make
 * this file a decoration.
 */

import { afterAll, describe, expect, it } from "vitest";

// FIRST import, and it must stay first: the vendored `config` reads `process.env`
// once at import time, so this module's side effect has to run before anything
// below reaches the provider layer. Measured, not assumed.
import "./kg-runtime-provider-env.js";

import { sql } from "drizzle-orm";
import { setToolResponse } from "../../packages/llmwiki-kg/ts/src/core/extraction-harness.js";
import { registerDocumentRow } from "llmwiki-kg";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";
import { asAppRole, sqlStateOf } from "./kg-runtime-app-role.js";

const harness = await createKgPostgresHarness("kg-app-write");
const { db, stackId, reachable } = harness;

/** One triplet between two entities, so the write exercises both tables. */
const EXTRACTION = {
  triplets: [
    {
      subject: { name: "Alpha", type: "TECHNOLOGY" },
      relation: { type: "USES" },
      object: { name: "Beta", type: "TECHNOLOGY" },
    },
  ],
};

/**
 * Is the application role available to drop into?
 *
 * Probed once, at collection time, so `skipIf` can report an honest SKIP rather
 * than a test body returning early inside a green result.
 */
const appRoleAvailable = await (async (): Promise<boolean> => {
  if (!reachable) return false;
  try {
    const rows = await db.execute(
      "select count(*)::int as n from pg_roles where rolname = 'llmwiki_app'",
    );
    return ((rows[0] as { n: number } | undefined)?.n ?? 0) > 0;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await harness.cleanup();
});

/** A document registration, with the body and source this suite asserts on. */
function registration() {
  return {
    stackId,
    source: `https://app-role.test/${stackId}.md`,
    body: "Alpha uses Beta.",
    title: "AppRole",
  };
}

describe("the kg write path under the application role", () => {
  it.skipIf(!appRoleAvailable)(
    "registers a document row, which its siblings already required a binding for",
    async () => {
      // The exact call that fails with 42501 when the tenant is unbound. Asserted
      // directly as well as through the dimension, because this is the defect: a
      // failure here names the missing binding in one line instead of surfacing as
      // a rejected graph write far from the cause.
      const documentId = await asAppRole({ db }, (tx) =>
        registerDocumentRow(tx as never, registration()),
      );

      expect(documentId).toBeTypeOf("string");
      const counted = await db.execute(
        `select count(*)::int as n from stack_documents where id = '${documentId}'`,
      );
      expect((counted[0] as { n: number }).n).toBe(1);
    },
    60_000,
  );

  it.skipIf(!appRoleAvailable)("lets the whole dimension commit its entities and edges", async () => {
    const { createKgDimension } = await import("../../src/dimensions/kg/index.js");
    setToolResponse([EXTRACTION]);

    // The real path an operator runs, dropping to the app role for the commit
    // only. `commit` receives the transaction, which is how the coordinator
    // supplies one, so this exercises the join branch rather than a private
    // connection the dimension would otherwise open as `aks`.
    const summary = await asAppRole({ db }, async (tx) => {
      const prepared = await createKgDimension({
        stackId,
        stackName: "kg-app-write",
        databaseUrl: testDatabaseUrl(),
      }).prepare({
        source: `https://app-role.test/dimension-${stackId}.md`,
        title: "Dimension",
        document: "---\ntitle: Dimension\n---\n",
        body: "Alpha uses Beta.",
      });
      const committed = await createKgDimension({
        stackId,
        stackName: "kg-app-write",
        databaseUrl: testDatabaseUrl(),
      }).commit(prepared, { tx: tx as never });
      return committed.summary;
    });

    expect(summary).toContain("2 entities");
    const names = (await db.execute(
      `select name from ontology_entities where stack_id = '${stackId}' order by name`,
    )) as { name: string }[];
    expect(names.map((row) => row.name)).toEqual(["Alpha", "Beta"]);
  }, 90_000);
});

describe("row-level security refuses what the dimension must never do", () => {
  it.skipIf(!appRoleAvailable)("rejects a document write for a Stack it did not bind", async () => {
    // The policy is the reason the binding matters. Without a bound tenant the
    // insert is refused, which is the fail-CLOSED direction: no data rather than
    // all data.
    const error = await asAppRole({ db }, (tx) =>
      (tx as { execute: (q: unknown) => Promise<unknown> }).execute(sql`
        insert into stack_documents (stack_id, filename, storage_path, size_bytes, content_type, source_hash)
        values (gen_random_uuid(), 'x', 'https://forbidden.test/x.md', 1, 'text/markdown', 'h')
      `),
    ).catch((caught: unknown) => caught);

    expect(error).toBeDefined();
    // 42501 is the policy refusal; anything else would be a different failure
    // wearing the same test.
    expect(sqlStateOf(error)).toBe("42501");
  }, 60_000);
});
