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
 * ## What this module cannot do: a file with BOTH modes
 *
 * The mode it declares is the FILE's, so a suite that asserts rows in some cases and files in others
 * must not import it at all: importing it would leave its row-backed cases without the database they
 * need. Such a suite declares the mode itself — dropping `AKS_DATABASE_URL` where the file path is
 * asserted and restoring it where rows are — and that is a per-case decision no fixture can make.
 * {@link useFileMode} exists for the caller that wants the declaration written as a call beside its
 * own hooks rather than as a bare import; it registers the same hook for the same file. Neither form
 * is scoped to one `describe`: a scoped mode inside an importing file does not exist.
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
 * mirror-image case, and the same reasoning applies one level down: this hook is the ONLY place a
 * suite drops its inherited database, so there is no second channel to drift from it.
 */

import { beforeEach } from "vitest";

/** Variable the dimension layer reads its DSN from when it is given no argument. */
const DIMENSIONS_DATABASE_URL_ENV_VAR = "AKS_DATABASE_URL";

/** Register the file-mode hook for the scope it is called in. */
function declareFileMode(): void {
  beforeEach(() => {
    delete process.env[DIMENSIONS_DATABASE_URL_ENV_VAR];
  });
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

// THE declaration: importing this module is how a file says it has no database.
declareFileMode();
