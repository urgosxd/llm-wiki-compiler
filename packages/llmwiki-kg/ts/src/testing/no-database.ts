/**
 * @file packages/llmwiki-kg/ts/src/testing/no-database.ts
 * @description The one wording, and the one decision, every database-backed suite in this package
 * shares when no database can be obtained.
 *
 * ## Why the suites FAIL instead of skipping (S3)
 *
 * A database-backed suite that cannot reach Postgres used to SKIP, and every runner in this
 * repository reports a skip as a PASS. The run printed `Tests 40 skipped (40)` beside a zero exit
 * status, so the suite executed not one assertion and the only trace of it was a count nobody
 * read. That is how the CI false-green survived: the job was green while the ingest, page, stack,
 * backfeed, document and consolidation suites asserted nothing at all. A skip is not a smaller
 * test, it is a green result with the test removed, and nobody watches a number that is already
 * green.
 *
 * The rule is therefore enforced at the DECISION POINT rather than suite by suite: each suite's
 * probe reaches {@link noDatabase}, which THROWS, and a throw during collection fails the file. No
 * suite can opt out by forgetting to check a flag, and the failure is a failing file, not a
 * warning inside a green one.
 *
 * ## The single documented opt-out (S4)
 *
 * Exactly one escape hatch exists, `LLMWIKI_TEST_ALLOW_NO_DATABASE=1`, and it is the ONLY path from
 * "no database" to a green run. It returns the observed detail as the skip reason, which is what
 * the suites printed before this rule existed, so an offline run can still be honest about what it
 * dropped instead of silently passing.
 *
 * ## Why the failure names three things
 *
 * A loud failure that does not say how to fix itself gets bypassed. The message therefore names the
 * override variable a developer or CI job can point at an existing Postgres, the PINNED image the
 * run would start itself (`pgvector/pgvector:pg16`, the tag the repository's own compose stack and
 * `test/fixtures/ephemeral-postgres.ts` use, never `latest`), Docker as the prerequisite that
 * supplies that image, and the opt-out by name so nobody has to guess that it exists.
 * `test/fixtures/no-database-fails-loudly.test.ts` pins those four names by RUNNING the suites with
 * an unreachable database, so this text cannot drift into something less actionable.
 *
 * ## Why this module lives inside the package
 *
 * `packages/llmwiki-kg/ts/tsconfig.json` sets `rootDir: "src"`, so a module under `src/` cannot
 * import anything above it (TS6059). `test/fixtures/test-database-handoff.ts` already owns this
 * wording for the root suites; it is unreachable from here, which is why the same ~20 lines of
 * actionable text used to be copy-pasted into seven harnesses plus `db.test.ts`, where seven copies
 * of a failure message are seven chances to fix it in six places. This module is the in-package
 * twin those callers can actually import, so the wording exists once per compilation boundary and
 * both copies are pinned by the same run-based test.
 *
 * The per-suite first line stays at the call site: each suite names itself there, and keeping that
 * sentence byte-identical is what makes importing this module a pure extraction with no change in
 * observable behaviour.
 */

/** The pinned image a run is expected to start when nothing else supplies a database. */
const PINNED_POSTGRES_IMAGE = "pgvector/pgvector:pg16";

/** The one documented opt-out; it restores the old skip behavior and nothing else does. */
const DATABASE_OPT_OUT_ENV_VAR = "LLMWIKI_TEST_ALLOW_NO_DATABASE";

/** The override variable a developer or CI job sets to supply its own Postgres. */
const DATABASE_URL_ENV_VAR = "LLMWIKI_TEST_DATABASE_URL";

/**
 * Turn "no database" into the skip reason the gates read, or into the actionable failure.
 *
 * @param headline - The first line of the failure, naming the suite that needed the database. It is
 *   passed in because each suite has always named itself, and this extraction must not reword them.
 * @param detail - What was observed, so the failure names the server someone should fix.
 * @returns The skip reason; used only when `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` is set.
 * @throws When no database can be obtained and the opt-out is not set.
 */
export function noDatabase(headline: string, detail: string): string {
  if (process.env[DATABASE_OPT_OUT_ENV_VAR]?.trim() === "1") return detail;
  throw new Error(
    [
      headline,
      `Observed: ${detail}`,
      "Skipping is not an option here: a skip is reported as a pass while asserting nothing.",
      "Supply a database in any of these ways:",
      `  - start Docker, so this run can start its pinned ${PINNED_POSTGRES_IMAGE} container, or`,
      `  - set ${DATABASE_URL_ENV_VAR} to a reachable Postgres that carries the vector extension, or`,
      `  - set ${DATABASE_OPT_OUT_ENV_VAR}=1 to accept the old skip behavior for this run.`,
    ].join("\n"),
  );
}
