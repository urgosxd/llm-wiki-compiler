/**
 * @file test/fixtures/file-mode.ts
 * @description Declare that one test file runs with NO database configured.
 *
 * ## Why the mode has to be DECLARED, not inherited
 *
 * The runner seeds a database URL into every worker (`test/setup/test-database-url.ts`), so a suite
 * that asserts file-backed behaviour runs with a database configured whether it asked for one or
 * not. That used to be harmless. It is now a contradiction, because spec S2 of
 * `odd/tasks/single-stack-authority.md` makes the absence of a Stack an EXPLICIT mode, separated
 * from "a database is configured and its Stack went missing" by exactly one fact — is a database
 * configured — and only the second of the two is a failure. A suite that never configures a
 * database is therefore the ordinary file mode; a suite that inherits one it does not use is
 * neither mode, and it was pinning the masquerade: file-backed assertions that held only because
 * the code under test quietly returned the file backend when the environment named no Stack.
 *
 * So a test that wants the file backend says so the way production says it: no database
 * configured. This is that declaration, and it is one line in every file that needs it —
 * `import "./fixtures/file-mode.js";` — which is what makes the alignment checkable instead of a
 * per-suite judgement.
 *
 * ## Why an import, and not a call
 *
 * Importing this module IS the declaration: it registers the hook below for the file that imports
 * it. A file-scope import also runs before every `beforeAll`, which a `beforeEach` cannot promise,
 * so a suite that spawns a child process in `beforeAll` still starts that child without a database.
 *
 * ## A file with BOTH modes: {@link withFileMode}, and never the file-wide hook
 *
 * The mode the import declares is the FILE's, so a suite that asserts rows in some cases and files
 * in others must not run with it: the file-wide hook would leave its row-backed cases without the
 * database they need. Such a suite declares the mode per CASE instead, with {@link withFileMode}:
 * it removes the database for the duration of one body and restores exactly what it removed, so the
 * cases that want rows still have their database afterwards.
 *
 * A mixed file still IMPORTS this module, because that is where {@link withFileMode} lives, and the
 * import cannot be made conditional — so the same file states, once, that its mode is decided per
 * case ({@link usePerCaseFileMode}) and the file-wide hook then declines to act. That is not a
 * second mode: it is the same named no-database condition, entered and left per case instead of
 * being switched off for everything. What must not happen is a mixed file that quietly keeps its
 * inherited database for its file-backed cases — that is the masquerade this module exists to end,
 * one case at a time rather than one file at a time.
 *
 * {@link useFileMode} exists for the caller that wants the file-wide declaration written as a call
 * beside its own hooks rather than as a bare import; it registers the same hook for the same file.
 * It is NOT a scoped form: a scope for one `describe` or one case inside a file that also asserts
 * rows does not exist, and {@link withFileMode} is what a mixed file uses instead.
 *
 * ## Why `beforeEach`, and why nothing is restored
 *
 * `beforeEach` rather than a module-scope `delete`, for two reasons. It gives every case the same
 * starting point, so a case that DOES want rows sets its own database later and one that forgot to
 * is file-backed rather than accidentally row-backed; and it cannot be undone by a case that
 * restores `process.env` wholesale, since the hook runs after that restore. A file whose cases all
 * want files is unaffected either way, which is the point: the declaration reads the same in both.
 *
 * Nothing is restored afterwards, and that is measured rather than assumed: vitest runs each test
 * FILE in its own process (pool `forks`, `isolate` left at its default), so a deletion here cannot
 * reach another file's worker. `test/fixtures/env-stack.ts` documents the same measurement for the
 * mirror-image case, and the same reasoning applies one level down: within one file this hook and
 * {@link withFileMode} are the only two places a suite drops its inherited database, both in this
 * module, and a file uses one or the other — never neither.
 */

import { beforeEach } from "vitest";
import { TEST_DATABASE_URL_ENV_VAR } from "./test-database.js";

/** Variable the dimension layer reads its DSN from when it is given no argument. */
const DIMENSIONS_DATABASE_URL_ENV_VAR = "AKS_DATABASE_URL";

/**
 * Every variable that says "this run has a database".
 *
 * Both, because they are two spellings of one fact and the worker seeding keeps them in step (see
 * `test/setup/test-database-url.ts`): leaving the test-channel one behind would let a fixture open a
 * database inside a window whose whole declaration is that the run has none.
 */
const DATABASE_URL_ENV_VARS = [DIMENSIONS_DATABASE_URL_ENV_VAR, TEST_DATABASE_URL_ENV_VAR] as const;

/**
 * Whether the file-wide hook still acts.
 *
 * True for the 103 suites whose import IS the declaration. A mixed file turns it off from its own
 * module scope (see {@link usePerCaseFileMode}), which is why the hook reads this flag at RUN time
 * rather than deciding while the module is being loaded: the importing file's body executes after
 * this module's body and before the first test.
 */
let fileWideDeclaration = true;

/** Register the file-mode hook for the scope it is called in. */
function declareFileMode(): void {
  beforeEach(() => {
    if (!fileWideDeclaration) return;
    delete process.env[DIMENSIONS_DATABASE_URL_ENV_VAR];
  });
}

/**
 * Declare that THIS file decides its mode per case, so the file-wide hook does nothing.
 *
 * The declaration a mixed file makes, beside its import: the same file still imports this module
 * for {@link withFileMode}, and an import cannot be made conditional, so it says here — once, at
 * module scope — that the absence of a database is entered per case rather than for the file. Call
 * it at module scope, not inside a hook: the file-wide hook reads the flag per test, and a call
 * after a test began would apply only to the tests that followed.
 *
 * Forgetting it is loud rather than silent: the row-backed cases of a mixed file then run without
 * their database and fail on the connection, they do not quietly pass.
 */
export function usePerCaseFileMode(): void {
  fileWideDeclaration = false;
}

/**
 * Declare file mode for this file, written as a call rather than as a bare import.
 *
 * The same declaration {@link declareFileMode} registers on import, for a caller that wants it beside
 * its own hooks. Not a scoped form: see the module header on suites that need both modes.
 */
export function useFileMode(): void {
  declareFileMode();
}

/**
 * Run one test body with NO database configured, and put the environment back afterwards.
 *
 * THE per-case declaration, for a file that asserts rows in some cases and files in others. Inside
 * the body the run looks to the code under test exactly like a deployment with no database: both
 * variables that could name one are absent, so `isDatabaseConfigured` (the one predicate the Stack
 * authority and the host's Stack refusal share) answers `false`, which is the named `file` mode of
 * `odd/tasks/single-stack-authority.md` S2 rather than a Stack that went missing.
 *
 * Restored in a `finally`, and restored to what was there — a value returns as itself and an absent
 * variable returns as absent — so a case of the same file that asserts rows keeps the database it
 * was seeded with. Nesting is safe for the same reason; the outer call restores last.
 *
 * @param fn - The case body to run with no database configured; awaited before the restore.
 * @returns Whatever `fn` returned.
 */
export async function withFileMode<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = DATABASE_URL_ENV_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of DATABASE_URL_ENV_VARS) delete process.env[name];
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// THE declaration: importing this module is how a file says it has no database.
declareFileMode();
