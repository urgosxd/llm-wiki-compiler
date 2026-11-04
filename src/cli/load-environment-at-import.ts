/**
 * @file src/cli/load-environment-at-import.ts
 * @description Load the project `.env` while the entry module's imports are being
 * evaluated, before anything snapshots `process.env`.
 *
 * ## Why a side-effect module instead of a call in the entry's body
 *
 * Two modules of the vendored KG core read the environment when they are
 * EVALUATED, not when a dimension runs:
 *
 * - `packages/llmwiki-kg/ts/src/config.ts` parses `process.env` into the `config`
 *   singleton at module init.
 * - `packages/llmwiki-kg/ts/src/db.ts` calls `createClient(config.DATABASE_URL)`
 *   at module init.
 *
 * ES modules evaluate every import of an entry before that entry's own body, so
 * a `loadCliEnvironment()` call sitting in `src/cli.ts` ran AFTER those snapshots
 * were already taken. Only the shell environment reached the KG side, which made
 * a `.env` — how the shared embedding credential is normally configured —
 * invisible to the credential bridge and surfaced as the fail-closed
 * "no API key is configured" error.
 *
 * THIS MODULE MUST BE THE FIRST IMPORT OF `src/cli.ts`. Import order is
 * evaluation order; moving it below another import silently restores the bug.
 *
 * `src/cli.ts` still calls `loadCliEnvironment()` in its own body. That is
 * harmless because the function is idempotent: `dotenv/config` is a
 * `require`-cached module, so a second call cannot read the file twice, and
 * dotenv never overrides a variable that is already set.
 */

import { loadCliEnvironment } from "./environment.js";

loadCliEnvironment();
