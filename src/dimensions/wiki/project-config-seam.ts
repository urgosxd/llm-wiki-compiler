/**
 * @file src/dimensions/wiki/project-config-seam.ts
 * @description Resolve a project's config from the corpus it actually has.
 *
 * ## Why this lives here and not beside the config reader
 *
 * `project/config.ts` is imported by `sources/selection.ts`, which
 * `utils/source-writer.ts` imports, which the wiki store imports — so that module
 * sits UNDERNEATH the dimension layer. Reaching up from it to `activation.ts`
 * closed a dependency cycle through the whole store stack.
 *
 * Every other backend seam in this codebase lives in `dimensions/wiki/` for the
 * same reason: the layer that knows about databases owns the decision to open
 * one, and the layers above stay free of it.
 *
 * ## Why the Stack wins, and why absence does not fall back
 *
 * `review` and `sources` describe how ONE STACK is reviewed and discovered. A file
 * per checkout let two clones serving one Stack disagree with nothing to report
 * it. A Stack with no row therefore means "this Stack has no config", never
 * "borrow the checkout's" — borrowing would restore the divergence silently.
 */

import { createClient, createDatabase, kgConfig } from "@repo/kg";
import { readProjectConfig, type StoredProjectConfig } from "./project-config-store.js";

/**
 * The environment variable names this seam reads.
 *
 * Declared here rather than imported from `dimensions/activation.ts`: that module
 * imports `wiki/database`, and importing it from inside the wiki layer closes a
 * dependency cycle through the store (measured: four cycles). The values are part
 * of the deployment contract, not of activation's implementation, so duplicating
 * two literals is cheaper than the cycle — and `test/project-config-per-stack`
 * fails loudly if they ever drift.
 */
const STACK_ID_ENV = "AKS_STACK_ID";
const DATABASE_URL_ENV = "AKS_DATABASE_URL";

/** A resolved config: the document, or `undefined` when this project has none. */
export type ResolvedProjectConfig = StoredProjectConfig | undefined;

/**
 * Read one Stack's config, or report that no Stack is configured.
 *
 * @param env - Environment naming the Stack.
 * @returns The document, `undefined` when the Stack holds none, or `null` when no
 *   Stack is configured at all — the caller then reads the file.
 */
export async function readStackProjectConfig(
  env: NodeJS.ProcessEnv,
): Promise<ResolvedProjectConfig | null> {
  const stackId = (env[STACK_ID_ENV] ?? "").trim();
  if (stackId === "") return null;
  // `createDimensionsDatabase` from `activation.ts` cannot be imported here: that
  // module pulls in `wiki/database` → the store → `source-writer` →
  // `sources/selection` → the config reader → back to this seam. Four cycles,
  // measured. Connecting directly keeps the graph acyclic, and this function only
  // needs a `Database`, which is all that helper produced.
  const client = createClient(
    env[DATABASE_URL_ENV]?.trim() || kgConfig.DATABASE_URL,
    DB_CONNECT_TIMEOUT_SECONDS,
  );
  try {
    return await readProjectConfig(createDatabase(client), stackId);
  } finally {
    await client.end({ timeout: DB_CLOSE_TIMEOUT_SECONDS });
  }
}

/** Seconds to wait for a connection before failing, matching `activation.ts`. */
const DB_CONNECT_TIMEOUT_SECONDS = 10;

/** Seconds to allow a pool to drain on close, matching `activation.ts`. */
const DB_CLOSE_TIMEOUT_SECONDS = 5;
