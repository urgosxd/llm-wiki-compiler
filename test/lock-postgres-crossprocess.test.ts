/**
 * Cross-PROCESS exclusion, which is the whole point of moving the lock to Postgres.
 *
 * Two connections in one process prove session scoping; they do not prove the lock
 * is visible to another machine, which is what the file lock could never do. This
 * spawns a real child and holds the lock from here.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tryAcquirePostgresLock } from "../src/utils/lock-postgres.js";
import { testDatabaseUrl } from "./fixtures/test-database.js";

const DSN = testDatabaseUrl();
const suite = DSN === "" ? describe.skip : describe;

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

suite("advisory lock across processes", () => {
  it("refuses the lock to a different process while this one holds it", async () => {
    const key = `/xproc/${randomUUID()}`;
    const held = await tryAcquirePostgresLock(DSN, key);

    expect(childAcquires(key)).toBe(false);
    await held?.release();
    expect(childAcquires(key)).toBe(true);
  }, 120_000);
});
