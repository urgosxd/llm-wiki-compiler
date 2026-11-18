/**
 * @file test/artifact/root-entry-database-url.test.ts
 * @description Guards the one bridge the PUBLISHED image's entrypoint was missing: the operator is
 * told to publish `AKS_DATABASE_URL`, while the graph routes and `scripts/apply-schemas.sh` read
 * `DATABASE_URL`.
 *
 * ## Why this file exists, in one sentence
 *
 * Measured on the image built from this branch with ONLY `AKS_DATABASE_URL` set: `/health` answered
 * 200, `GET /stacks` answered 500, and `scripts/apply-schemas.sh` exited 2 with `error: no target.
 * Pass a connection string or set DATABASE_URL.` — because `docker/entry.sh` carried zero
 * occurrences of either name, so the documented variable reached nothing. The three graph tools
 * were present and practically dead: a surface that advertises itself and cannot reach its backend.
 *
 * ## What it proves
 *
 * 1. **The bridge exists exactly once, in the PRESERVING spelling**
 *    `export DATABASE_URL="${DATABASE_URL:-${AKS_DATABASE_URL:-}}"`. The literal line is asserted, so
 *    a clobbering `DATABASE_URL="$AKS_DATABASE_URL"` — which would overwrite an operator's explicit
 *    value — fails here rather than in production.
 * 2. **The bridge runs before the explicit-command branch and before the mode dispatch.** The
 *    image's own schema runner is invoked as `docker run <image> sh -c 'scripts/apply-schemas.sh'`,
 *    which takes the `if [ "$#" -gt 0 ]; then exec "$@"` passthrough; a bridge below that branch
 *    would be dead on the very command that motivated it.
 * 3. **The script carries no configuration of its own.** No DSN literal, no URL with userinfo, no
 *    token-shaped value, and `AKS_DATABASE_URL` appears nowhere but in the bridge — the connection
 *    string arrives from the caller and a value written here would be a credential baked into the
 *    image.
 * 4. **Nothing about the existing entrypoint behaviour moved.** A caller-supplied command still runs
 *    verbatim, and no arguments still means `serve`; the bridge is inserted into code both share, so
 *    the previous behaviour is pinned rather than assumed.
 *
 * ## Why no Docker, and no spawn
 *
 * A `docker build` costs minutes and needs a daemon, so it can never be a per-commit check. Every
 * assertion below reads a TRACKED FILE as text, the same way `test/artifact/container-entry.test.ts`
 * and `test/artifact/kg-container-entry.test.ts` read their entry scripts. The image-level proof
 * stays a delivery step.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ARTIFACT_REPO_ROOT } from "./artifact-text.js";

/** The published image's entry script, repository-relative as the Dockerfile COPYs it. */
const ENTRY_SOURCE = "docker/entry.sh";

/** The one accepted spelling of the bridge: `export`, preserving, and both arms blank-safe. */
const BRIDGE_LINE = 'export DATABASE_URL="${DATABASE_URL:-${AKS_DATABASE_URL:-}}"';

/** The branch that hands the process to a caller-supplied command. */
const PASSTHROUGH_BRANCH = 'if [ "$#" -gt 0 ]; then';

/** The switch that asks for the HTTP listener without spelling out the command. */
const MODE_DISPATCH = 'if [ "${LLMWIKI_MODE:-mcp}" = "host" ]; then';

/** The bundle every mode execs, as the script spells it. */
const LAUNCHER_BUNDLE = "/app/dist/api.js";

/** The two names the bridge joins: the one the server reads, the one the operator publishes. */
const KEPT_NAME = "DATABASE_URL";
const PUBLISHED_NAME = "AKS_DATABASE_URL";

/** Read the entry script as text, from this file's location rather than the worker's cwd. */
async function readEntryScript(): Promise<string> {
  return readFile(resolve(ARTIFACT_REPO_ROOT, ENTRY_SOURCE), "utf8");
}

/** The script's lines, trimmed, so index arithmetic reports positions a reader can count. */
function scriptLines(script: string): string[] {
  return script.split("\n").map((line) => line.trim());
}

/**
 * Every statement, comments and blanks dropped.
 *
 * A header comment may QUOTE the shape this file forbids while explaining it, and a quoted `# ...`
 * line is not a statement — so nothing here may be asserted over the raw text alone.
 *
 * @param script - The whole entry script.
 * @returns The trimmed non-comment statements, in file order.
 */
function statements(script: string): string[] {
  return scriptLines(script).filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * Every assignment of one variable name, `export` included.
 *
 * @param script - The whole entry script.
 * @param name - The variable name.
 * @returns The trimmed assignment statements, in file order.
 */
function assignmentsOf(script: string, name: string): string[] {
  const assignment = new RegExp(`^(?:export\\s+)?${name}=`);
  return statements(script).filter((line) => assignment.test(line));
}

/**
 * The 1-based line number of one exact statement, failing when it is absent.
 *
 * Reported 1-based because the failure message is read next to an editor, and 0-based indices in a
 * message about "line 44" are how a reader looks one line off.
 *
 * @param lines - The script's trimmed lines.
 * @param needle - The exact statement to find.
 * @param why - The reason it must exist, used as the assertion message.
 * @returns The statement's 0-based index.
 */
function lineOf(lines: readonly string[], needle: string, why: string): number {
  const at = lines.indexOf(needle);
  expect(at, why).toBeGreaterThan(-1);
  return at;
}

describe("the published entrypoint bridges the published DSN name", () => {
  it("assigns DATABASE_URL exactly once, in the preserving spelling", async () => {
    const assignments = assignmentsOf(await readEntryScript(), KEPT_NAME);

    expect(
      assignments,
      `\`${ENTRY_SOURCE}\` must assign \`${KEPT_NAME}\` exactly once: zero leaves the documented ` +
        `\`${PUBLISHED_NAME}\` reaching nothing, and two make the winner an accident of file order`,
    ).toHaveLength(1);
    expect(
      assignments[0],
      `\`${ENTRY_SOURCE}\` must carry \`${BRIDGE_LINE}\` verbatim: \`export\` so the exec'd process ` +
        `sees it, \`\${${KEPT_NAME}:-…}\` so an explicit value WINS, and \`\${${PUBLISHED_NAME}:-}\` so a ` +
        `blank pair stays empty instead of inventing a connection string. The clobbering form ` +
        `\`${KEPT_NAME}="$${PUBLISHED_NAME}"\` would overwrite the operator's own value, and rejecting ` +
        "it is what this literal assertion is for.",
    ).toBe(BRIDGE_LINE);
  });
});

describe("the published entrypoint wires the DSN before a caller's command can run", () => {
  it("places the bridge above the explicit-command branch", async () => {
    const lines = scriptLines(await readEntryScript());
    const bridgeAt = lineOf(lines, BRIDGE_LINE, `\`${ENTRY_SOURCE}\` must carry the bridge`);
    const branchAt = lineOf(lines, PASSTHROUGH_BRANCH, `\`${ENTRY_SOURCE}\` must carry a caller-command-wins branch`);

    expect(
      bridgeAt,
      `the bridge is at line ${bridgeAt + 1} and \`${PASSTHROUGH_BRANCH}\` is at line ${branchAt + 1}: a ` +
        "bridge below that branch never runs for `docker run <image> sh -c 'scripts/apply-schemas.sh'`, " +
        "which is how the image's own schema runner is invoked and the exact command that exited 2 " +
        "without it",
    ).toBeLessThan(branchAt);
  });

  it("places the bridge above the mode dispatch and the default serve exec", async () => {
    const lines = scriptLines(await readEntryScript());
    const bridgeAt = lineOf(lines, BRIDGE_LINE, `\`${ENTRY_SOURCE}\` must carry the bridge`);
    const modeAt = lineOf(lines, MODE_DISPATCH, `\`${ENTRY_SOURCE}\` must carry the \`LLMWIKI_MODE\` dispatch`);
    const serveLine = `exec node ${LAUNCHER_BUNDLE} serve`;
    const serveAt = lineOf(lines, serveLine, `\`${ENTRY_SOURCE}\` must end in \`${serveLine}\``);

    expect(
      bridgeAt,
      `the bridge is at line ${bridgeAt + 1} and the \`LLMWIKI_MODE\` dispatch is at line ${modeAt + 1}: ` +
        "`host` mode must start with the same DSN resolution as the default `serve` mode",
    ).toBeLessThan(modeAt);
    expect(bridgeAt, "the bridge must precede the default `serve` exec, or the no-argument run misses it").toBeLessThan(
      serveAt,
    );
  });
});

describe("the published entrypoint is the only place the published DSN name appears", () => {
  it("names AKS_DATABASE_URL in the bridge alone and bakes no DSN, credential or endpoint", async () => {
    const script = await readEntryScript();

    expect(
      statements(script).filter((line) => line.includes(PUBLISHED_NAME)),
      `\`${PUBLISHED_NAME}\` may appear in exactly one STATEMENT — the bridge. A second reader or a ` +
        "defaulted value here would be a second answer to which database the image reaches",
    ).toEqual([BRIDGE_LINE]);
    expect(
      script,
      `\`${ENTRY_SOURCE}\` must carry no DSN literal: the connection string arrives from the caller, ` +
        "and a value written here would be a credential baked into the image",
    ).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(script, "no endpoint may arrive through a URL with userinfo (a credential smuggling shape)").not.toMatch(
      /\/\/[^\s/'"@]+@/,
    );
    expect(
      statements(script).filter((line) => /=\s*"?[A-Za-z0-9+/_=-]{16,}"?\s*$/.test(line)),
      `\`${ENTRY_SOURCE}\` must carry no literal that looks like a key or a token`,
    ).toEqual([]);
  });
});

describe("the published entrypoint's existing behaviour survives the bridge", () => {
  it("still runs a caller-supplied command verbatim and still defaults to serve", async () => {
    const lines = scriptLines(await readEntryScript());
    const kept = statements(lines.join("\n"));

    expect(
      kept.slice(0, 2),
      "the bridge is the script's FIRST wiring statement, after `set -eu`: a bridge below the " +
        "caller's command is dead on the run that needs it",
    ).toEqual(["set -eu", BRIDGE_LINE]);
    const branchAt = lineOf(lines, PASSTHROUGH_BRANCH, `\`${ENTRY_SOURCE}\` must keep a caller-command-wins branch`);
    expect(
      lines.slice(branchAt, branchAt + 2),
      "the caller's command must still run verbatim, not through an injected mode or argument",
    ).toEqual([PASSTHROUGH_BRANCH, 'exec "$@"']);
    expect(
      kept.at(-1),
      `\`${ENTRY_SOURCE}\` must still end in \`exec node ${LAUNCHER_BUNDLE} serve\`, so PID 1 is the ` +
        "MCP server and it receives SIGTERM directly",
    ).toBe(`exec node ${LAUNCHER_BUNDLE} serve`);
  });
});
