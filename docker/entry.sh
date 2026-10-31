#!/bin/sh
#
# Start `llmwiki` — MCP over stdio by default.
#
# ## Why MCP is the default
#
# The product is consumed by agents, and the agent surface is MCP. HTTP exists
# because the tests and `/api/ingest` need it, not because it is the way in. So the
# container with no arguments speaks MCP on stdin/stdout, which is what
# `docker run -i` and every MCP client expect.
#
# ## Why an explicit command wins
#
# The image is also the only place `host`, `ingest`, `compile`, `lint` and the rest
# live, so `docker run ... <args>` must run the CLI verbatim rather than being
# swallowed by a fixed entrypoint. The previous version always injected `host`, which
# made `docker run -i <image> serve` start an HTTP server instead — measured, and it
# is why `--entrypoint node` was needed to reach MCP at all.
#
# ## The stdio caveat, stated rather than hidden
#
# A stdio server exits as soon as stdin closes. Under `docker compose up -d` there is
# no stdin, so the container would start and stop instantly and read as a crash. The
# compose file therefore keeps `stdin_open: true` and asks for `host` explicitly.
set -eu

# The address the container will be reached on: the IPv4 address of the interface
# that carries the default route.
#
# Node itself answers this, which is why no /proc parsing is attempted here. Two
# earlier versions of this function read /proc by hand and both were wrong on a real
# machine: /proc/net/route column 3 is the GATEWAY, not the address (it produced
# 192.168.18.1 where the address was 192.168.18.28), and /proc/net/fib_trie carries
# no device name at all. `os.networkInterfaces()` is authoritative, needs no extra
# package, and is the same runtime the server uses.
default_route_host() {
  node -e '
    const os = require("node:os");
    const nets = os.networkInterfaces();
    const external = [];
    for (const [name, addrs] of Object.entries(nets)) {
      for (const a of addrs ?? []) {
        if (a.family === "IPv4" && !a.internal) external.push({ name, address: a.address });
      }
    }
    // Prefer the interface Docker uses; fall back to whatever non-internal address
    // exists, so a bridged or custom network still resolves.
    const docker = external.find((e) => e.name.startsWith("eth"));
    const chosen = docker ?? external[0];
    process.stdout.write(chosen ? chosen.address : "127.0.0.1");
  ' 2>/dev/null || echo "127.0.0.1"
}

# Start the HTTP listener on this container's own address.
#
# The gate requires BOTH --host and --allow-lan or NEITHER — including for a
# loopback address. `--host 127.0.0.1` alone is a fatal error, so there is no shape
# in which a bare `--host` is correct. No flags at all is right only when no address
# could be resolved, which is why that branch exists.
run_host() {
  port="${LLMWIKI_PORT:-4173}"
  host="${LLMWIKI_HOST:-$(default_route_host)}"
  if [ -z "$host" ]; then
    set -- node /app/dist/cli.js host --port "$port"
  else
    set -- node /app/dist/cli.js host --port "$port" --host "$host" --allow-lan
  fi
  exec "$@"
}

# A caller-supplied command runs verbatim. `LLMWIKI_MODE=host` is the switch that
# asks for the listener without spelling out the whole command, which is what the
# compose file uses.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

if [ "${LLMWIKI_MODE:-mcp}" = "host" ]; then
  run_host
fi

# `exec` so the MCP server owns the process and receives SIGTERM directly; without it
# the shell swallows the signal and the container waits out the Docker stop timeout.
exec node /app/dist/cli.js serve
