/**
 * @file packages/llmwiki-kg/ts/src/testing/suite-database.ts
 * @description The bootstrap every database-backed suite in this package was repeating by hand.
 *
 * ## Why it exists
 *
 * Resolving the server, provisioning this process's own database and turning "no database" into
 * the shared refusal is four lines that `db.test.ts`, `core/consolidation-harness.ts` and the
 * `routes/*-harness.ts` files each carry a copy of. A fifth copy is what `fallow --gate new-only`
 * reports as NEW duplication (measured: `duplication_introduced: 3`), which is the gate doing its
 * job: the fourth copy of a fact is where the copies start disagreeing. A suite added after this
 * file should import it instead of pasting the block again.
 *
 * ## Why the probe runs at module load, and not in `beforeAll`
 *
 * `describe.skipIf` is evaluated during test COLLECTION, before any hook runs. A probe in
 * `beforeAll` leaves the gate reading its initial value, so the block runs (and fails) with no
 * database instead of reporting the reason. Every caller therefore awaits {@link suiteDatabase}
 * at module scope, exactly as the copies it replaces did.
 *
 * ## Why it still goes through `noDatabase`
 *
 * A skip is a pass that asserts nothing (`./no-database.ts`), so "no database" THROWS unless the
 * run declared `LLMWIKI_TEST_ALLOW_NO_DATABASE=1`. That decision stays in one place: this module
 * only replaces the hand-copied plumbing around it.
 */
import { noDatabase } from "./no-database.js";
import { perRunDatabase } from "./per-run-database.js";

/** The server a suite database is provisioned on: the host every suite in this package targets. */
const TEST_SERVER_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  process.env["LLMWIKI_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** What a suite needs to gate its database-backed block and to connect. */
export interface SuiteDatabaseProbe {
  /** Connection string every test in the suite uses. */
  readonly url: string;
  /** `false` when a database was obtained; the skip reason only under the documented opt-out. */
  readonly skipReason: string | false;
}

/**
 * Provision this process's database, or decide what to do without one.
 *
 * @param headline - The first line of the refusal, naming the suite that needed the database.
 * @returns The connection string and the `describe.skipIf` gate.
 */
export async function suiteDatabase(headline: string): Promise<SuiteDatabaseProbe> {
  const suite = await perRunDatabase(TEST_SERVER_URL).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  if (suite instanceof Error) {
    return { url: TEST_SERVER_URL, skipReason: noDatabase(headline, suite.message) };
  }
  return { url: suite.url, skipReason: false };
}
