/**
 * @file test/fixtures/test-database-handoff-adopted-source.test.ts
 * @description Keep the RETIRED `adopted` source readable, so a record an older run wrote is not
 * reported as corrupt.
 *
 * ## The decision this test protects
 *
 * `test/fixtures/testcontainers-postgres.ts` no longer publishes an `adopted` record: continuing on
 * a server this run did not create is the defect the record format exists to report, so that branch
 * now writes `unavailable` with a reason. The union member was nevertheless KEPT in
 * `TestDatabaseSource`, on purpose and for one reason only — a record already sitting in
 * `.llmwiki/test-database.json` from a run that predates the retirement must still PARSE instead of
 * being discarded as corrupt. `readTestDatabaseHandoff` reports an unparseable record as
 * `undefined`, and the setup file turns that into a database nobody re-published.
 *
 * Nothing else exercises that member, so deleting it (or narrowing `isSource`) would be invisible
 * today. This file is the pin: the on-disk bytes of such a record, read through the public reader.
 *
 * ## Why raw JSON and not `writeTestDatabaseHandoff`
 *
 * The shape under test is the one an OLDER run left on disk, not whatever today's writer produces.
 * Writing the literal bytes means a change to the writer cannot quietly redefine the input, and the
 * record deliberately carries NO `reason`: `HANDOFF_FIELD_RULES` requires one only in prose for
 * `unavailable`, and `adopted` must parse without it.
 *
 * ## Why the record lives in a temp directory
 *
 * The reader resolves its file through `LLMWIKI_TEST_DB_HANDOFF_FILE`, which this test supplies as a
 * synthetic environment object rather than mutating `process.env`; the run's own record under
 * `.llmwiki/` is never opened, and nothing is written inside the repository.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  readTestDatabaseHandoff,
  TEST_DATABASE_HANDOFF_FILE_ENV_VAR,
  TEST_DATABASE_HANDOFF_VERSION,
} from "./test-database-handoff.js";

/** A scratch directory outside the worktree; removed when this file finishes. */
const scratch = mkdtempSync(path.join(tmpdir(), "llmwiki-adopted-handoff-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("a handoff record written by a run that adopted a server", () => {
  it("parses as adopted instead of being reported as corrupt", () => {
    const file = path.join(scratch, "test-database.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: TEST_DATABASE_HANDOFF_VERSION,
        token: "0123456789abcdef",
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "adopted",
        url: "postgresql://aks:aks@127.0.0.1:5434/aks",
        container: { id: "c0ffee", name: "llmwiki-shared-test-db" },
        reused: true,
      }),
      "utf8",
    );

    const record = readTestDatabaseHandoff({ [TEST_DATABASE_HANDOFF_FILE_ENV_VAR]: file });

    expect(record).toBeDefined();
    expect(record?.source).toBe("adopted");
    expect(record?.reused).toBe(true);
    expect(record?.container?.name).toBe("llmwiki-shared-test-db");
  });
});
