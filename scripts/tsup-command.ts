/**
 * Resolve and invoke the repository's build tool without shell-specific npm
 * wrappers. Test setup and stamping use the same Node executable.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** Resolve the installed CLI from its manifest instead of hardcoding its layout. */
export function resolveTsupCli(): string {
  const manifestPath = require.resolve("tsup/package.json");
  const { bin } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin: string | Record<string, string>;
  };
  const entry = typeof bin === "string" ? bin : bin.tsup;
  return path.join(path.dirname(manifestPath), entry);
}
