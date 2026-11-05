/**
 * Cross-PROCESS exclusion, which is the whole point of moving the lock to Postgres.
 *
 * Two connections in one process prove session scoping; they do not prove the lock
 * is visible to another machine, which is what the file lock could never do. This
 * spawns a real child and holds the lock from here.
 *
 * The DSN is this process's OWN database (see `test/fixtures/per-run-database.ts`) and
 * the child is handed that same DSN, so what the child is refused is a lock on THIS
 * database — the same shape as two hosts sharing one Stack's database.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tryAcquirePostgresLock } from "../src/utils/lock-postgres.js";
import { isPerRunDatabaseName, perRunDatabase } from "./fixtures/per-run-database.js";
import { DEFAULT_TEST_DATABASE_URL } from "./fixtures/test-database.js";

/** This process's own database; provisioning fails loudly rather than skipping. */
const DSN = (await perRunDatabase()).url;

/** Run a child that tries the lock once, reporting whether it got it. */
function childAcquires(key: string): boolean {
  const modulePath = fileURLToPath(new URL("../src/utils/lock-postgres.ts", import.meta.url));
  // Written to a temp file rather than passed to `--eval`: the child needs
  // top-level await, which the eval transform rejects.
  const scriptPath = join(tmpdir(), `lock-probe-${randomUUID()}.mts`);
  writeFileSync(scriptPath, `
import { tryAcquirePostgresLock } from ${JSON.stringify(modulePath)};
const held = await tryAcquirePostgresLock(${JSON.stringify(DSN)}, ${JSON.stringify(key)});
process.stdout.write(held === null ? "busy" : "held");
await held?.release();
process.exit(0);
`);
  try {
    const out = execFileSync("npx", ["tsx", scriptPath], { encoding: "utf-8", timeout: 30_000 });
    return out.trim() === "held";
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

describe("advisory lock across processes", () => {
  it("hands the child a database of its own, not the shared one", () => {
    // The child receives THIS DSN, so the cross-process claim is only about this
    // database. It still proves what a same-process pair cannot: the lock is shared
    // state seen by another machine's session.
    expect(isPerRunDatabaseName(new URL(DSN).pathname.slice(1))).toBe(true);
    expect(DSN).not.toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it("refuses the lock to a different process while this one holds it", async () => {
    const key = `/xproc/${randomUUID()}`;
    const held = await tryAcquirePostgresLock(DSN, key);

    expect(childAcquires(key)).toBe(false);
    await held?.release();
    expect(childAcquires(key)).toBe(true);
  }, 120_000);
});
