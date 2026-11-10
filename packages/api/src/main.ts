/**
 * @file packages/api/src/main.ts
 * @description The container launcher: `@repo/api`'s executable entry, and the
 * process `docker/entry.sh` starts.
 *
 * ## Why the executable lives in the joining package
 *
 * `host` serves the wiki dimension's viewer and the KG dimension's graph from ONE
 * listener, and `serve` exposes the wiki tools over stdio MCP. A launcher is
 * therefore the one module that has to name both dimensions at once, which is
 * exactly what `@repo/api` exists for: the topology permits `api → wiki`,
 * `api → kg` and forbids `wiki ↔ kg` in both directions, so a launcher written
 * anywhere else either duplicates the composition or inverts an edge the split
 * exists to create.
 *
 * ## It is a dispatcher, not a second implementation
 *
 * Every behaviour below is reached through the module that already owns it:
 * `startHost` builds the listener (now in-package, at `./host/server.ts`, because
 * the listener is the one module that mounts the knowledge graph and therefore the
 * one place the wiki and kg dimensions meet), `buildViewerSnapshot` freezes the
 * served surface, `resolveBindConfig` owns the `--host`/`--allow-lan` privacy gate
 * and the wildcard rejection, and the MCP server owns its own tools and transport.
 * Re-implementing any of those here would let the container and an in-process
 * caller drift, and the privacy gate is a security rule that must have ONE copy.
 *
 * The flags are the ones `docker/entry.sh` passes today — `host --port …`
 * optionally with `--host … --allow-lan`, and `serve` — plus `serve --root` and
 * `host --no-graph`, which those two commands already accept. Nothing is invented.
 *
 * Each flag is accepted by the ONE subcommand that can honour it: `--port`,
 * `--host`, `--allow-lan` and `--no-graph` shape the listener, and `--root` roots
 * the stdio server. The other subcommand REJECTS it as an unknown option, because
 * a dropped flag is worse than a refused one — `host --root /data` served the
 * process's working directory instead of `/data`, bound its port, and exited 0.
 *
 * ## The two modes, and why one bundle carries both
 *
 * `serve` is the container's default surface: the product is consumed by agents,
 * and stdio MCP is reachable from no other entry. `host` is the opt-in HTTP
 * listener — viewer, graph, and the `/api/ingest` + `/api/compile` mutation
 * mounts on one port. Emitting BOTH from a single bundle is what lets the final
 * image stage copy one `dist/`, which is why the artifact lands at the repository
 * root (`dist/api.js`) rather than inside this package.
 *
 * ## argv is parsed by hand, deliberately
 *
 * Two subcommands and five options do not justify a parser dependency in the
 * composition root. Unknown options and unknown commands are REJECTED rather than
 * ignored: an operator who typos `--prot` must not get a silently defaulted bind,
 * and `LLMWIKI_MODE=host` with a stray flag must fail loudly rather than serve a
 * surface nobody asked for. The same holds for an option the OTHER subcommand
 * owns: tokenizing needs the union of both flag sets, but acceptance is decided
 * per subcommand against the table in `COMMANDS`, before anything binds.
 *
 * ## Exit contract
 *
 * `0` on a clean shutdown (`serve` ends when a client closes stdin, `host` when
 * it is signalled), `1` on any usage error or startup failure, with the reason on
 * stderr. `host` never calls `process.exit` on the success path: the bound
 * listener keeps the process alive and the shared shutdown handler decides the
 * code, exactly as the CLI's own host command did.
 */

// FIRST IMPORT, DELIBERATELY. The KG core snapshots `process.env` while its
// modules are evaluated, so the project `.env` has to be loaded before any other
// import here is evaluated. See that module's own header for the mechanism.
import "./load-environment.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createWikiMcpServer, startMCPServer } from "@repo/wiki/mcp";
import { startHost } from "./host/server.js";
import { createDimensionsPort } from "./dimensions/port.js";
import { buildViewerSnapshot } from "@repo/wiki/viewer-snapshot";
import { buildReadyUrl, registerShutdown, resolveBindConfig, type BindOptions } from "./serve-bind.js";

/** The subcommand that starts the unified HTTP listener. */
const HOST_COMMAND = "host";

/** The subcommand that starts MCP over stdio. */
const SERVE_COMMAND = "serve";

/**
 * Options that consume the argument after them, or take one after `=`, ACROSS
 * both subcommands: the union the TOKENIZER needs, not the set anything accepts.
 * It must know that `--root <dir>` is a flag plus its value before the subcommand
 * is known; which subcommand accepts which name is decided afterwards.
 */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(["--port", "--host", "--root"]);

/** Boolean options across both subcommands, tokenized by the same union rule as {@link VALUE_OPTIONS}. */
const BOOLEAN_OPTIONS: ReadonlySet<string> = new Set(["--allow-lan", "--no-graph", "--help", "-h"]);

/** The bind flag whose presence unlocks a non-loopback listen. */
const ALLOW_LAN = "--allow-lan";

/** The graph opt-out, mirroring the `--no-graph` the host command already accepts. */
const NO_GRAPH = "--no-graph";

/** The option that asks for the usage text, in its long and short spellings. */
const HELP = "--help";
const HELP_SHORT = "-h";

/** Reported to MCP clients when this module cannot read a version, never invented. */
const UNKNOWN_VERSION = "unknown";

/** The help text, printed for `--help` and carried by every usage failure. */
const USAGE = `Usage: api <command> [options]

Commands:
  host     Start the unified HTTP listener (viewer, graph, /api/ingest + /api/compile)
  serve    Start an MCP server exposing wiki tools and resources over stdio

host options:
  --port <port>   Port to bind (default 0 — OS-assigned)
  --host <host>   Host to bind (requires --allow-lan; default 127.0.0.1)
  --allow-lan     Bind beyond loopback (requires --host); off by default for privacy
  --no-graph      Serve without the knowledge-graph sub-app (no database required)

serve options:
  --root <dir>    Project root directory (default: the current directory)
`;

/** A caller mistake: the message is the whole diagnostic, with usage appended. */
class UsageError extends Error {}

/** What one subcommand does with the parsed arguments. */
type CommandHandler = (parsed: LauncherArguments) => Promise<void>;

/** What one argv array said, split by what the caller supplied it as. */
interface LauncherArguments {
  /** The subcommand, once one was given. */
  readonly command: string | undefined;
  /** Value-taking options, keyed by their flag spelling without any `=value`. */
  readonly values: ReadonlyMap<string, string>;
  /** Boolean options that were present. */
  readonly flags: ReadonlySet<string>;
  /** Every option name given, in argv order, so a rejection can name the first offender. */
  readonly supplied: readonly string[];
}

/**
 * Split `--flag=value` into its parts, leaving every other token whole.
 *
 * @param token - One argv element.
 * @returns The flag name and its inline value, absent when it carried none.
 */
function splitOption(token: string): [string, string | undefined] {
  const separator = token.startsWith("--") ? token.indexOf("=") : -1;
  if (separator < 0) return [token, undefined];
  return [token.slice(0, separator), token.slice(separator + 1)];
}

/** What one argv array has been read into so far, while it is still being read. */
interface ArgumentAccumulator {
  /** Value-taking options, keyed by their flag spelling without any `=value`. */
  readonly values: Map<string, string>;
  /** Boolean options that were present. */
  readonly flags: Set<string>;
  /** Every option name read so far, in argv order. */
  readonly supplied: string[];
  /** Operands, in the order they appeared. */
  readonly positional: string[];
}

/**
 * Read one value-taking option, which consumes either the rest of its token or
 * the token after it.
 *
 * @param accumulator - The read in progress.
 * @param argv - The process arguments, without the node binary and script path.
 * @param index - Position of the option token.
 * @param name - The option's flag spelling.
 * @param inlineValue - The value carried after `=`, absent when it needs the next token.
 * @returns The index of the LAST token this option consumed.
 * @throws {UsageError} When the option was given no value at all.
 */
function readValuedOption(
  accumulator: ArgumentAccumulator,
  argv: readonly string[],
  index: number,
  name: string,
  inlineValue: string | undefined,
): number {
  const value = inlineValue ?? argv[index + 1];
  if (value === undefined) throw new UsageError(`${name} requires a value`);
  accumulator.values.set(name, value);
  return inlineValue === undefined ? index + 1 : index;
}

/**
 * Read ONE argv token into the accumulator.
 *
 * @param accumulator - The read in progress.
 * @param argv - The process arguments, without the node binary and script path.
 * @param index - Position of the token to read.
 * @returns The index of the last token this step consumed.
 * @throws {UsageError} On an unknown option or a value-taking option with no value.
 */
function readToken(accumulator: ArgumentAccumulator, argv: readonly string[], index: number): number {
  const token = argv[index] as string;
  const [name, inlineValue] = splitOption(token);
  if (BOOLEAN_OPTIONS.has(name)) {
    accumulator.flags.add(name);
    accumulator.supplied.push(name);
    return index;
  }
  if (VALUE_OPTIONS.has(name)) {
    accumulator.supplied.push(name);
    return readValuedOption(accumulator, argv, index, name, inlineValue);
  }
  if (token.startsWith("-")) throw new UsageError(`unknown option: ${name}`);
  accumulator.positional.push(token);
  return index;
}

/**
 * Read argv into one command, its valued options and its boolean options.
 *
 * @param argv - The process arguments, without the node binary and script path.
 * @returns What the caller asked for.
 * @throws {UsageError} On an unknown option, a missing value, or an extra operand.
 */
function parseArguments(argv: readonly string[]): LauncherArguments {
  const accumulator: ArgumentAccumulator = { values: new Map(), flags: new Set(), supplied: [], positional: [] };
  let index = 0;
  while (index < argv.length) index = readToken(accumulator, argv, index) + 1;
  const extra = accumulator.positional[1];
  if (extra !== undefined) throw new UsageError(`unexpected operand: ${extra}`);
  return { command: accumulator.positional[0], values: accumulator.values, flags: accumulator.flags, supplied: accumulator.supplied };
}

/**
 * Translate the parsed bind flags into the shape the shared privacy gate reads.
 *
 * Nothing is coerced here: `resolveBindConfig` owns port validation and the
 * `--host`/`--allow-lan` symmetry, so this function only moves values across.
 *
 * @param parsed - What the caller supplied.
 * @returns The bind options, carrying only the flags that were actually passed.
 */
function bindOptions(parsed: LauncherArguments): BindOptions {
  const port = parsed.values.get("--port");
  const host = parsed.values.get("--host");
  return {
    ...(port === undefined ? {} : { port }),
    ...(host === undefined ? {} : { host }),
    ...(parsed.flags.has(ALLOW_LAN) ? { allowLan: true } : {}),
  };
}

/**
 * The version reported to MCP clients in the initialize handshake.
 *
 * Read from the `package.json` one level above this module, which is
 * `packages/api/package.json` when this file runs from source and the repository
 * root manifest when it runs from `dist/api.js` — the same relative read the CLI
 * entry used, and the reason no manifest is inlined into the bundle.
 *
 * @returns The declared version, or an explicit unknown rather than an invented one.
 */
function resolveVersion(): string {
  try {
    const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const declared = (JSON.parse(manifest) as { version?: unknown }).version;
    return typeof declared === "string" ? declared : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/**
 * Start the unified HTTP listener and stay alive until a signal closes it.
 *
 * @param parsed - What the caller supplied.
 */
async function runHost(parsed: LauncherArguments): Promise<void> {
  const root = process.cwd();
  const { host, port } = resolveBindConfig(bindOptions(parsed));
  const version = resolveVersion();
  // Built before binding so the listener never accepts a request against a
  // half-constructed snapshot.
  const viewerSnapshot = await buildViewerSnapshot(root);
  // ONE port for the whole host: the listener's mutation mount and the
  // MCP-over-HTTP factory both ingest through it, so a request handled over either
  // surface writes the dimensions the same way. Composed HERE because this module is
  // the composition root -- the only place in the process allowed to join the two
  // dimensions -- and this is the line that makes the container's launcher possess a
  // port at all.
  const dimensionsPort = createDimensionsPort();
  const handle = await startHost({
    viewerSnapshot,
    host,
    port,
    projectRoot: root,
    version,
    dimensionsPort,
    // The MCP-over-HTTP factory is built HERE because this module is imported by
    // nothing: it is the one place a host→mcp edge cannot close a cycle.
    mcpServerFactory: () => createWikiMcpServer({ root, version, dimensionsPort }),
    ...(parsed.flags.has(NO_GRAPH) ? { includeGraph: false } : {}),
  });
  process.stdout.write(`Host ready at ${buildReadyUrl(handle.host, handle.port)}\n`);
  registerShutdown(handle.close);
}

/**
 * Start the MCP server on stdio, rooted at `--root` or the current directory.
 *
 * @param parsed - What the caller supplied.
 */
async function runServe(parsed: LauncherArguments): Promise<void> {
  await startMCPServer({
    root: parsed.values.get("--root") ?? process.cwd(),
    version: resolveVersion(),
    // REQUIRED by `startMCPServer`, which refuses at construction without it: the
    // stdio surface is a container mode, so the port exists here or the process
    // fails loudly before it advertises tools it cannot honour.
    dimensionsPort: createDimensionsPort(),
  });
}

/** A subcommand: the function that runs it, and the options it honours. */
interface CommandSpec {
  /** The function that runs this subcommand. */
  readonly handler: CommandHandler;
  /** Every option name this subcommand honours, valued and boolean, help included. */
  readonly options: ReadonlySet<string>;
}

/** Options `host` accepts. `--root` is absent, because `runHost` serves the process's own directory. */
const HOST_OPTIONS: ReadonlySet<string> = new Set(["--port", "--host", ALLOW_LAN, NO_GRAPH, HELP, HELP_SHORT]);

/** Options `serve` accepts. Bind flags are absent, because `serve` opens no listener. */
const SERVE_OPTIONS: ReadonlySet<string> = new Set(["--root", HELP, HELP_SHORT]);

/**
 * The subcommands this launcher dispatches, by name.
 *
 * A table rather than an if-chain so the accepted set is one readable value, and
 * so an added mode cannot ship without a name and an option table here.
 */
const COMMANDS: Readonly<Record<string, CommandSpec | undefined>> = {
  [HOST_COMMAND]: { handler: runHost, options: HOST_OPTIONS },
  [SERVE_COMMAND]: { handler: runServe, options: SERVE_OPTIONS },
};

/**
 * The subcommand one name resolves to, or a usage failure.
 *
 * @param parsed - What the caller supplied.
 * @returns The specification for the named subcommand.
 * @throws {UsageError} When no command, or no known command, was given.
 */
function resolveCommand(parsed: LauncherArguments): CommandSpec {
  const name = parsed.command;
  if (name === undefined) throw new UsageError("no command given");
  const spec = COMMANDS[name];
  if (spec === undefined) throw new UsageError(`unknown command: ${name}`);
  return spec;
}

/**
 * Reject the first option the resolved subcommand does not honour.
 *
 * This is why the tables are per subcommand: an option the OTHER mode owns is
 * refused with exit 1 instead of parsed and dropped, and the two outcomes look
 * nothing alike to an operator. `--help` is exempt, since it is answered before
 * the command is known and describes the launcher as a whole.
 *
 * @param supplied - Option names the caller gave, in argv order.
 * @param accepted - The resolved subcommand's own option table.
 * @throws {UsageError} Naming the first supplied option the table does not hold.
 */
function assertOptionsAccepted(supplied: readonly string[], accepted: ReadonlySet<string>): void {
  const rejected = supplied.find((name) => name !== HELP && name !== HELP_SHORT && !accepted.has(name));
  if (rejected !== undefined) throw new UsageError(`unknown option: ${rejected}`);
}

/**
 * Dispatch one argv array to its subcommand.
 *
 * @param argv - The process arguments, without the node binary and script path.
 * @throws {UsageError} When the arguments name no subcommand this launcher has,
 *   or carry an option that subcommand does not accept.
 */
async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArguments(argv);
  if (parsed.flags.has(HELP) || parsed.flags.has(HELP_SHORT)) {
    process.stdout.write(USAGE);
    return;
  }
  const spec = resolveCommand(parsed);
  assertOptionsAccepted(parsed.supplied, spec.options);
  await spec.handler(parsed);
}

/**
 * The stderr text for one failed run: a usage mistake carries the usage text.
 *
 * @param error - What `main` threw.
 * @returns Text ending in exactly one newline.
 */
function formatFailure(error: unknown): string {
  if (error instanceof UsageError) return `${error.message}\n\n${USAGE}`;
  return `Error: ${error instanceof Error ? error.message : String(error)}\n`;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(formatFailure(error));
  process.exit(1);
}
