/**
 * @file src/serve-bind.ts
 * @description Shared bind/readiness/shutdown plumbing for the `host` mode the
 * launcher starts: the `--host`/`--allow-lan` symmetry, the wildcard rejection,
 * the readiness line and the shutdown handlers.
 *
 * Extracted from `src/commands/view.ts` so a SECOND listener did not duplicate
 * the privacy gate. That duplication was the risk worth avoiding: two copies of a
 * security rule eventually disagree. One module owns them.
 *
 * ## Why it now lives in the joining package
 *
 * It used to sit at `@repo/wiki`'s root, reachable as `@repo/wiki/serve-bind`,
 * because the CLI's `view` command and the launcher's `host` mode both started a
 * listener and neither could import the other's package (`wiki -> api` is
 * forbidden by the topology). `view` left with the CLI, so the launcher is the
 * only listener this repository starts and the module belongs beside it. Its
 * reachability is the reason the comment that used to be here is now wrong:
 * nothing outside `packages/api` imports it, so nothing outside `packages/api`
 * should be able to.
 *
 * Nothing here is viewer-specific; the names were the only viewer-ish thing about
 * it.
 */

/** Bind hosts that listen on every interface. */
const LOOPBACK_HOST = "127.0.0.1";

/**
 * Bind hosts that listen on every interface are rejected because the Host /
 * Origin / Sec-Fetch-Site checks in the server are built around a single canonical
 * bind address; a wildcard bind would mean any reachable interface's IP serves as
 * a valid Host, which defeats the DNS-rebind protection.
 */
const WILDCARD_HOSTS = new Set([
  "0.0.0.0",
  "::",
  "0:0:0:0:0:0:0:0",
  "0000:0000:0000:0000:0000:0000:0000:0000",
  "*",
]);

/** The bind-related flags every listener command accepts. */
export interface BindOptions {
  readonly port?: string | number;
  readonly host?: string;
  readonly allowLan?: boolean;
}

/**
 * Apply the host/port symmetry: `--allow-lan` and `--host` together unlock a
 * non-loopback bind; either alone is a fatal error.
 *
 * @param options - Parsed CLI flags.
 * @returns The resolved host and port.
 * @throws When the privacy gate or the wildcard rule is violated.
 */
export function resolveBindConfig(options: BindOptions): { host: string; port: number } {
  const hostFlag = typeof options.host === "string" && options.host.length > 0;
  const allowLan = options.allowLan === true;
  assertHostAllowLanSymmetry(hostFlag, allowLan);
  const host = hostFlag ? (options.host as string) : LOOPBACK_HOST;
  assertHostNotWildcard(host);
  return { host, port: parsePort(options.port) };
}

/** Reject `--host` and `--allow-lan` being supplied independently. */
function assertHostAllowLanSymmetry(hostFlag: boolean, allowLan: boolean): void {
  if (hostFlag === allowLan) return;
  throw new Error(
    "Privacy gate: --host and --allow-lan must be supplied together. " +
      "Use both to bind beyond loopback, or neither to keep the server on 127.0.0.1.",
  );
}

/** Reject wildcard binds that would defeat DNS-rebind protection. */
function assertHostNotWildcard(host: string): void {
  if (!WILDCARD_HOSTS.has(host)) return;
  throw new Error(
    `--host ${host} is not supported: wildcard binds defeat the viewer's DNS-rebind protection. ` +
      "Use a specific interface IP (e.g. 192.168.1.10) instead.",
  );
}

/**
 * Build the readiness-line URL. IPv6 literal hosts must be bracketed
 * (`http://[::1]:PORT/`) per RFC 3986 — bare `http://::1:PORT/` is a malformed URL
 * and won't open in a browser. Heuristic for "literal IPv6": a colon in the host
 * portion (domain names + IPv4 dotted quads never contain `:`).
 *
 * @param host - Bound host.
 * @param port - Actual bound port.
 * @returns A URL suitable for a browser or a readiness line.
 */
export function buildReadyUrl(host: string, port: number): string {
  if (host.includes(":")) return `http://[${host}]:${port}`;
  return `http://${host}:${port}`;
}

/** Coerce the optional --port string into a non-negative integer. */
function parsePort(raw: string | number | undefined): number {
  if (raw === undefined) return 0;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!isValidPort(value)) {
    throw new Error(`Invalid --port value: ${raw}`);
  }
  return value;
}

/** True when `value` is an integer in the legal TCP port range [0, 65535]. */
function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

/**
 * Install SIGINT/SIGTERM handlers that close the server gracefully.
 *
 * @param close - Shutdown routine for the bound listener.
 */
export function registerShutdown(close: () => Promise<void>): void {
  // A repeated signal must be IGNORED, not acted on twice. Orchestrators escalate
  // and `docker stop` escalates on its own timer, so a second SIGTERM arriving
  // while the first close is still in flight is an ordinary event. Re-entering
  // `shutdown` would call `close()` a second time — which throws on an already
  // closed listener — and the catch below would then report exit 1: a different
  // way to break the same "the stop path exits 0" contract this routine exists for.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // The exit code is decided first and the process exits ONCE, outside the try.
    //
    // `process.exit(0)` must not sit inside the block that catches `close()`
    // failures: anything `process.exit` throws would then be caught and reported
    // as a failed close, which is a different fact. Vitest replaces `process.exit`
    // with a stub that throws, so the old shape exited 1 on a shutdown that had
    // actually succeeded and raised an unhandled rejection in every test worker
    // that stopped a host.
    let exitCode = 0;
    try {
      await close();
    } catch {
      exitCode = 1;
    }
    process.exit(exitCode);
  };
  // `on`, not `once`: a one-shot listener removes itself the moment the first
  // signal is emitted, which leaves the process with no SIGTERM listener at all
  // while `close()` is still pending — so a second signal would meet the kernel's
  // default disposition and kill the process by signal (exit code null) instead of
  // staying on the graceful path. The `shuttingDown` guard above makes the repeated
  // delivery harmless.
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
