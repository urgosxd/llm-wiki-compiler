/**
 * @file test/fixtures/test-dotenv.ts
 * @description Point CLI subprocesses at a committed environment corpus instead of
 * the operator's real `.env`.
 *
 * ## The trap this closes
 *
 * `src/cli/environment.ts` calls `require("dotenv/config")`, and dotenv resolves
 * `./.env` from the subprocess cwd -- it does not search upward. Every test that
 * spawns the CLI therefore loaded the developer's real environment: real API keys,
 * real `AKS_STACK_ID`, real provider selection.
 *
 * That made two suites fail on a populated machine while passing on CI. Neither was
 * a product defect:
 *
 *   - `test/okf-mcp-stdio.test.ts` asserts one candidate was staged.
 *     `listCandidates` consults `withCandidateSource(process.env, ...)`, which
 *     returns a rows source as soon as `AKS_STACK_ID` is set -- so it read Postgres,
 *     not the temp root, and compared 0 against 1.
 *   - `test/parity-default.test.ts` captures an MCP resource list, which grew from
 *     the fixture corpus to every row of a live 2137-Stack database.
 *
 * ## Why a separate file rather than cleaning `process.env`
 *
 * Deleting the variables from the parent would not help: the subprocess re-reads
 * `.env` from disk on its own. The only lever is telling dotenv to read something
 * else, which is `DOTENV_CONFIG_PATH`. Pointing it at a committed corpus also makes
 * the subprocess environment reviewable in the repository rather than implicit in
 * whoever ran the suite.
 *
 * Note that `StdioClientTransport` does NOT inherit the parent environment by
 * default -- the SDK passes only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`.
 * So the override has to be handed to the transport explicitly, which is why
 * `mcp-test-env.ts` merges `process.env` back in alongside this path.
 */

import path from "node:path";

/**
 * Repository-relative path of the committed test environment corpus.
 *
 * Named `.conf` rather than `.env.test` on purpose: `.gitignore` excludes `.env.*`
 * so that a real `.env.prod` is never committed, and a corpus the tests depend on
 * has to be tracked.
 */
export const TEST_DOTENV = path.resolve("test/fixtures/dotenv-test.conf");

/**
 * Environment overrides that make a spawned CLI read the corpus.
 *
 * Spread this into a subprocess `env` alongside `process.env`. Callers that build
 * their own environment should still include it, or they silently fall back to the
 * operator's `.env`.
 *
 * @returns The override object, with an absolute path so cwd cannot change the target.
 */
export function testDotenvEnv(): NodeJS.ProcessEnv {
  return { DOTENV_CONFIG_PATH: TEST_DOTENV };
}
