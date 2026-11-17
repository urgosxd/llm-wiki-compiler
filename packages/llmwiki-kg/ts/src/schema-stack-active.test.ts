/**
 * @file packages/llmwiki-kg/ts/src/schema-stack-active.test.ts
 * @description `stacks.active` must exist, be NOT NULL, and really default to `true`.
 *
 * The column carries decision 1.3 ("3 como inactivo"): deactivating a Stack is a flag, not a
 * delete. It is asserted through the PUBLIC schema of this process's own database — the same
 * database `scripts/apply-schemas.sh` builds — and never by reading the DDL back as text, so a
 * migration that is written but not REGISTERED fails here instead of shipping.
 *
 * Every database-backed suite FAILS, never skips, when no database can be obtained; a skip is a
 * pass that asserts nothing (`./testing/no-database.ts`).
 */
import { describe, expect, it } from "vitest";

import { withClient } from "./testing/per-run-database.js";
import { suiteDatabase } from "./testing/suite-database.js";

/** This process's database and the gate for the block below; THROWS if none can be obtained. */
const probe = await suiteDatabase(
  "The stacks.active schema suite needs a Postgres database.",
);

describe.skipIf(probe.skipReason !== false)("stacks.active", () => {
  it("declares a NOT NULL boolean defaulting to true", async () => {
    await withClient(probe.url, async (client) => {
      const columns = await client<
        { data_type: string; is_nullable: string; column_default: string | null }[]
      >`select data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'stacks' and column_name = 'active'`;
      expect(columns).toEqual([
        { data_type: "boolean", is_nullable: "NO", column_default: "true" },
      ]);
    });
  });

  it("defaults an insert that omits the column to true", async () => {
    await withClient(probe.url, async (client) => {
      const rows = await client<{ active: boolean }[]>`
        insert into stacks (name, domain) values ('active-default', 'active-default')
        returning active`;
      expect(rows).toEqual([{ active: true }]);
    });
  });
});
