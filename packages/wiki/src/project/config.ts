/**
 * Shared project configuration reader. Missing configuration uses caller
 * defaults; consumers validate their own versioned settings after JSON loading.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LLMWIKI_DIR } from "../utils/constants.js";

/** A present configuration cannot be interpreted safely. */
export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

/** Require an object, retaining unknown keys for other config consumers. */
export function requireConfigRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectConfigError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Validate the versioned envelope for settings that require version 1. */
export function normalizeProjectConfig(raw: unknown): Record<string, unknown> {
  const config = requireConfigRecord(raw, "config");
  if (config.version !== 1) throw new ProjectConfigError('.llmwiki/config.json requires "version": 1');
  return config;
}

/**
 * Keys whose capability was removed, with the consequence a user MUST be told about.
 *
 * Each message states two things: that the key is gone, and what its absence changes
 * about the wiki. The second is the load-bearing one — a user who configured a hold
 * believed pages were being withheld, so deleting the key silently would leave them
 * believing it still while the pages land live.
 */
const RETIRED_CONFIG_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "review",
    'The project config "review" key no longer exists: `review.hold` is retired, and pages which ' +
      "would previously have been held are now written live. Remove the key.",
  ],
]);

/**
 * Refuse a config that still carries a retired key, BEFORE anything acts on it.
 *
 * The refusal belongs here, at load, and deliberately not at first use: `review` is
 * read from `.llmwiki/config.json` (and from a Stack's `wiki.project_config` row),
 * which is exactly the place where refusing early stops a run before it writes
 * anything. The compile-option guard is the mirror case — that key was never
 * file-configurable, so guarding it at load would have protected a key no file could
 * carry.
 *
 * @param config - The loaded document, or `null` when there is none.
 * @returns The document, unchanged, when it names no retired key.
 */
function refuseRetiredConfigKeys(
  config: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (config === null) return null;
  for (const [key, message] of RETIRED_CONFIG_KEYS) {
    if (key in config) throw new ProjectConfigError(message);
  }
  return config;
}

/**
 * Read one project's config, from whichever corpus it has.
 *
 * ## Why the Stack wins
 *
 * `review` and `sources` describe how a STACK is reviewed and discovered. A file
 * per checkout let two clones serving one Stack disagree with nothing to report
 * it, so a Stack-configured project reads its config from `wiki.project_config`.
 *
 * The file stays authoritative for a project with no Stack: every seam in this
 * codebase keeps that fallback, and a project that never opted into rows must
 * keep behaving exactly as before.
 *
 * @param root - Project root, used only by the file backend.
 * @param env - Environment naming the Stack; `process.env` when omitted.
 * @returns The config record, or `null` when there is none.
 * @throws {ProjectConfigError} When the document names a key whose capability was
 * removed — see {@link RETIRED_CONFIG_KEYS}.
 */
export async function loadProjectConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
  // The Stack lookup is INJECTED, not imported.
  //
  // This module sits underneath the wiki store: `source-writer` imports
  // `sources/selection`, which imports this file, and the store imports
  // `source-writer`. Importing `dimensions/` from here therefore closed a
  // dependency cycle through the entire store stack (four cycles, measured).
  //
  // The resolver is installed once at startup by whoever owns the database
  // decision. Absent an installer — a unit test, a file-only deployment — the
  // file is the corpus, which is exactly the behaviour that existed before rows.
  // A Stack whose config cannot be READ is not the same as one with no config.
  //
  // A missing table (a deployment behind this migration) or an unreachable database
  // must not fail an ingest: config selects how sources are discovered, and refusing
  // to ingest because a read-setting was unavailable would block the write for a
  // reason unrelated to it. The failure is surfaced through the config itself so a
  // caller that cares can see it, and it does not silently borrow the checkout's
  // settings — the divergence this whole seam exists to remove.
  let stored: Record<string, unknown> | undefined | null;
  try {
    stored = await readStackConfig(env);
  } catch (error) {
    throw new ProjectConfigError(`Cannot read this Stack's config: ${String(error)}`);
  }
  if (stored !== null) {
    return refuseRetiredConfigKeys(stored === undefined ? null : requireConfigRecord(stored, "config"));
  }
  return refuseRetiredConfigKeys(await readFileConfig(root));
}

/**
 * Read one Stack's config through a DYNAMIC import.
 *
 * Dynamic on purpose: a static `import` here would close a dependency cycle
 * through the entire wiki store, because `source-writer` imports
 * `sources/selection`, which imports this file, and the store imports
 * `source-writer` (measured: four cycles). Loading the seam at call time keeps
 * the module graph acyclic while still letting the row backend own the database
 * decision.
 *
 * @param env - Environment naming the Stack.
 * @returns The document, `undefined` for a Stack with none, or `null` for no Stack.
 */
async function readStackConfig(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> | undefined | null> {
  const { readStackProjectConfig } = await import(
    "../dimensions/wiki/project-config-seam.js"
  );
  return await readStackProjectConfig(env);
}

/** Read `.llmwiki/config.json`; only an absent file permits default behavior. */
async function readFileConfig(root: string): Promise<Record<string, unknown> | null> {
  let body: string;
  try {
    body = await readFile(path.join(root, LLMWIKI_DIR, "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ProjectConfigError(`Invalid .llmwiki/config.json: ${String(error)}`);
  }
  try {
    return requireConfigRecord(JSON.parse(body), "config");
  } catch (error) {
    if (error instanceof ProjectConfigError) throw error;
    throw new ProjectConfigError(`Invalid .llmwiki/config.json: ${String(error)}`);
  }
}
