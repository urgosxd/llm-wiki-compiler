/**
 * Commander action for `llmwiki compile`.
 *
 * Two shapes of the same verb:
 *
 *   - `llmwiki compile` — the ordinary run: detect source changes and compile what moved.
 *   - `llmwiki compile --recompile <page...>` — regenerate the named pages at the CURRENT
 *     synthesis version, even though their sources did not change. This is the documented
 *     lever the compile's synthesis-version line points at: `PROMPT_VERSION` is stamped
 *     per page and a bump invalidates nothing, so a page compiled under an older prompt
 *     keeps that wording until someone asks for it to be regenerated. `all` means every
 *     page the wiki stores.
 *
 * The verb RETURNS an exit code rather than swallowing it: a `--recompile` request that
 * names a page the wiki does not store, or a page no source owns, is refused with the
 * reason printed and a non-zero code, because a scoped regeneration that silently did
 * nothing is worse than no lever at all.
 */

import { existsSync } from "fs";
import { compile, compileRecompiling } from "../compiler/index.js";
import * as output from "../utils/output.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { CompileOptions } from "../utils/types.js";

/** Exit code of a run that finished (or had nothing to do). */
const EXIT_OK = 0;
/** Exit code of a run that was refused, or that reported a compile error. */
const EXIT_REFUSED = 1;

/**
 * Run the compile command from the current working directory.
 * @param options - Optional behaviour overrides forwarded from the CLI flag set.
 * @param recompilePages - Pages to regenerate (`--recompile`), or `undefined` for an
 *   ordinary compile. Accepts page ids, bare slugs, or the literal `all`.
 * @returns Process exit code: 0 when the run completed, 1 when it was refused or failed.
 */
export default async function compileCommand(
  options: CompileOptions = {},
  recompilePages?: readonly string[],
): Promise<number> {
  if (recompilePages !== undefined) return await runRecompile(recompilePages, options);
  if (!existsSync(SOURCES_DIR)) {
    output.status(
      "!",
      output.warn('No sources found. Run `llmwiki ingest <url>` first.'),
    );
    return EXIT_OK;
  }

  await compile(process.cwd(), options);
  return EXIT_OK;
}

/**
 * Regenerate the requested pages and report why if the request cannot be honoured.
 *
 * Review mode is refused rather than silently ignored: `--review` writes candidates under
 * `.llmwiki/candidates/` instead of mutating `wiki/`, so combining them would produce a
 * "regenerated" page that never reaches the wiki the version line measured.
 *
 * @param pages - Pages to regenerate, as the operator typed them.
 * @param options - The compile options the run carries.
 * @returns Process exit code.
 */
async function runRecompile(
  pages: readonly string[],
  options: CompileOptions,
): Promise<number> {
  if (options.review) {
    output.status("!", output.error(
      "--recompile cannot be combined with --review: a regenerated page is written to the " +
        "wiki, never held as a candidate.",
    ));
    return EXIT_REFUSED;
  }
  if (!existsSync(SOURCES_DIR)) {
    output.status("!", output.error(
      "Cannot recompile: this project has no sources/ directory to regenerate a page from.",
    ));
    return EXIT_REFUSED;
  }
  const result = await compileRecompiling(process.cwd(), pages);
  for (const message of result.errors) output.status("✗", output.error(message));
  return result.errors.length === 0 ? EXIT_OK : EXIT_REFUSED;
}
