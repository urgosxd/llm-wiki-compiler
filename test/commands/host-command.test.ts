/**
 * @file test/commands/host-command.test.ts
 * @description `llmwiki host` must actually bind a listener that serves the
 * mutation endpoints.
 *
 * WHY THIS EXISTS. Before this command, NOTHING started the unified host:
 * `llmwiki view` started the older viewer-only server, `llmwiki serve` is MCP over
 * stdio, and `startHost` was reachable only from tests. A surface no command can
 * start is not a product surface, and a test that only asserted "the function
 * exists" would not have caught that.
 *
 * Each case therefore drives the COMMAND and speaks HTTP to whatever it bound,
 * rather than calling `startHost` directly — the command is the thing made of new
 * behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Roots created by this suite, so each test cleans up after itself. */
const created: string[] = [];

/** A scratch project to stand in as the CLI's working directory. */
async function scratchProject(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-command-")));
  await mkdir(path.join(root, "sources"), { recursive: true });
  created.push(root);
  return root;
}

/** Capture the readiness line instead of letting it reach the test output. */
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

/** Extract the bound URL from the command's readiness line. */
function readyUrl(lines: readonly string[]): string {
  const line = lines.find((entry) => entry.includes("Host ready at"));
  if (line === undefined) throw new Error(`no readiness line in: ${lines.join("")}`);
  return (line.match(/http:\/\/\S+/) ?? [])[0] ?? "";
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Start the host command on a free port and hand back its URL.
 *
 * Kept as one helper so both cases drive the command the same way: the point of the
 * suite is the command's behaviour, and duplicating the boot dance in each case
 * would let the two drift onto different setups.
 */
async function startHostCommand(): Promise<{ url: string; stop: () => Promise<void> }> {
  const { default: hostCommand } = await import("../../src/commands/host.js");
  const out = captureStdout();
  // Kept un-awaited: the command resolves only when the process is asked to stop.
  const running = hostCommand({ port: 0, noGraph: true });
  await vi.waitFor(() => expect(() => readyUrl(out.lines)).not.toThrow(), { timeout: 20_000 });
  const url = readyUrl(out.lines);
  out.restore();
  return {
    url,
    stop: async () => {
      process.emit("SIGTERM");
      await running.catch(() => undefined);
    },
  };
}

describe("the host command", () => {
  it("binds a listener and serves the mutation endpoints", async () => {
    process.chdir(await scratchProject());
    const host = await startHostCommand();
    try {
      // The endpoint exists and answers like a real API, not a 404.
      expect((await fetch(`${host.url}/api/health`)).status).toBe(200);
      expect((await fetch(`${host.url}/api/compile`, { method: "POST" })).status).toBe(200);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it("omits the graph routes when the graph is disabled", async () => {
    process.chdir(await scratchProject());
    const host = await startHostCommand();
    try {
      // `--no-graph` is an explicit opt-out, so its routes must be absent rather
      // than failing at request time.
      expect((await fetch(`${host.url}/health`)).status).toBe(404);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it("rejects a host flag supplied without --allow-lan", async () => {
    const { default: hostCommand } = await import("../../src/commands/host.js");
    // The privacy gate is shared with `view`; this proves the host did not
    // grow its own, weaker copy.
    await expect(hostCommand({ port: 0, host: "192.168.1.10" })).rejects.toThrow(
      /--host and --allow-lan must be supplied together/,
    );
  }, 30_000);
});
