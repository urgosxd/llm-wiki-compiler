/**
 * Load the project environment configuration at CLI startup.
 *
 * `dotenv/config` is require-cached, so calling this from more than one entry
 * point is idempotent and the first call wins. `src/cli/load-environment-at-import.ts`
 * calls it before the import graph is evaluated, and `src/cli.ts` calls it again
 * in its own body for callers that reach the program without that preload.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Load the project `.env` file into `process.env`. */
export function loadCliEnvironment(): void {
  require("dotenv/config");
}
