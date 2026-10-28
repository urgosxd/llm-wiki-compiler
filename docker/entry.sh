#!/bin/sh
#
# Start `llmwiki` on this container's own address.
#
# WHY THIS EXISTS RATHER THAN A PLAIN `CMD`
#
# The two dimensions are served by one listener, and that listener validates the
# incoming `Host` header against the address it bound to. A wildcard bind is
# refused outright ("wildcard binds defeat the viewer's DNS-rebind protection"),
# so the process must bind the exact interface address a client will use.
#
# That address does not exist when the image is built: Docker assigns it at start
# time. Hardcoding `127.0.0.1` produces a container that is healthy and unreachable
# from outside; hardcoding `0.0.0.0` produces one that refuses to start. Resolving
# the default-route address at entry is the only option that is correct for both.
#
# An explicit `LLMWIKI_HOST` wins, which is how a compose file pins a fixed address
# or how a caller targets a specific network.
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

PORT="${LLMWIKI_PORT:-4173}"
HOST="${LLMWIKI_HOST:-$(default_route_host)}"

# The privacy gate requires BOTH flags or NEITHER — including for a loopback
# address. `--host 127.0.0.1` alone is a fatal error ("--host and --allow-lan must be
# supplied together"), so there is no shape in which a bare `--host` is correct here.
#
# The default bind is used only when no address could be resolved, which is the one
# case where passing no flags at all is right.
if [ -z "$HOST" ]; then
  set -- node /app/dist/cli.js host --port "$PORT"
else
  set -- node /app/dist/cli.js host --port "$PORT" --host "$HOST" --allow-lan
fi

# `exec` so the server receives SIGTERM directly; without it the shell swallows the
# signal and the container waits out the full Docker stop timeout.
exec "$@"
