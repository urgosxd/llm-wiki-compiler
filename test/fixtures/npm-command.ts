/**
 * Invoke npm without a shell or a Windows .cmd shim. npm/npx expose their JS
 * launcher path to child tests; standalone POSIX runners can still use PATH.
 *
 * THIS MUST BE NPM, NOT WHATEVER LAUNCHED THE SUITE. The repository installs with
 * pnpm, so `npm_execpath` is pnpm's own CLI when the tests run through
 * `pnpm run …`. Blindly joining `npm-cli.js` onto that path is a guess that only
 * ever resolves because pnpm's directory happens not to hold that file: when it
 * misses, the fallback is a bare `npm` from PATH, which a pnpm-only container may
 * not have. The name is therefore checked first, and Node's own bundled npm is
 * the second candidate, so the pack report this fixture feeds to the assertions
 * is always npm's shape.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** Candidate `npm-cli.js` paths, most specific first. */
function npmCliCandidates(): string[] {
  const candidates: string[] = [];
  const launcher = process.env.npm_execpath;
  if (launcher && path.basename(launcher).startsWith("npm")) {
    candidates.push(path.join(path.dirname(launcher), "npm-cli.js"));
  }
  // Node ships npm beside its own binary: <prefix>/bin/node →
  // <prefix>/lib/node_modules/npm/bin/npm-cli.js.
  const prefix = path.dirname(path.dirname(process.execPath));
  candidates.push(path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  return candidates;
}

/** Resolve the npm launcher, including when this suite was started through pnpm. */
export function npmCommand(args: string[]): [string, string[]] {
  for (const cli of npmCliCandidates()) {
    if (existsSync(cli)) return [process.execPath, [cli, ...args]];
  }
  return ["npm", args];
}
