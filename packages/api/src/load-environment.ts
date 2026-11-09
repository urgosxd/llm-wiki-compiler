/**
 * @file packages/api/src/load-environment.ts
 * @description Load the project `.env` while the launcher's imports are being
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
 * ES modules evaluate every import of an entry before that entry's own body, so a
 * `loadEnvironment()` call sitting in `main.ts` would run AFTER those snapshots
 * were already taken: only the shell environment would reach the KG side, and a
 * `.env` — how the shared embedding credential is normally configured — would be
 * invisible to the credential bridge. `host` mode mounts the KG graph sub-app, so
 * that is not a hypothetical for the container.
 *
 * THIS MODULE MUST BE THE FIRST IMPORT OF `main.ts`. Import order is evaluation
 * order; moving it below another import silently restores the bug.
 *
 * ## Why `require` and not `import "dotenv/config"`
 *
 * `dotenv` publishes no type declaration for its `./config` subpath, and the
 * `createRequire` form is the one the CLI entry already used for it. `dotenv` is
 * a root runtime dependency of this repository, so the bundle keeps the call
 * external and the request is served by the installed package.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

require("dotenv/config");
