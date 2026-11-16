#!/bin/sh
#
# Start the KG reference server — provider wiring included.
#
# ## Why this script exists
#
# The image shipped a plain `CMD ["node", …/dist/index.js]`, so everything the
# server needed in order to boot had to be spelled on the `docker run` line: the
# gateway extraction provider, the chat base URL, its key, and a separate
# embeddings base URL. That line lived in nobody's notes, and a bare
# `docker run <tag>` inherited the config defaults instead — `EXTRACTION_PROVIDER`
# `anthropic` and `EMBEDDING_PROVIDER` `openai`, see `packages/llmwiki-kg/ts/src/config.ts`
# — and exited on missing provider credentials. The wiring belongs in the image,
# where it is reviewable and cannot be forgotten.
#
# ## Why the defaults PRESERVE rather than assign
#
# Every line below is `${NAME:-fallback}`, so a caller that passes the variable
# keeps its value. A bare assignment would overwrite the operator's choice and
# would re-implement, one layer up, the embeddings inheritance the application
# already owns: a blank `GATEWAY_EMBEDDINGS_*` resolves from `GATEWAY_URL` and
# `GATEWAY_API_KEY` at startup. `docker-compose.yml` substitutes nothing for those
# two for that same reason, and this script must not undo it.
#
# ## Why the embeddings host stays its own
#
# The chat host and the embeddings host are different services in a real
# deployment. `GATEWAY_EMBEDDINGS_BASE_URL` and `GATEWAY_EMBEDDINGS_API_KEY` name the
# embeddings service on its own, so this script seeds them from the wiki-side names
# that already publish that endpoint. When neither name is set they stay blank and
# the application falls back to the chat pair — the image refuses nothing, because
# the CI image check boots it with a chat URL and no embeddings URL at all.
#
# ## Why the published DSN name is bridged
#
# The server reads `DATABASE_URL` (`packages/llmwiki-kg/ts/src/config.ts`). The name the
# operator publishes, `AKS_DATABASE_URL`, is read only by
# `packages/wiki/src/dimensions/activation.ts`, which is not in this image, so on its own it
# is inert: the container boots, `/health` answers 200, and every graph tool answers the
# bare 21-byte `Internal Server Error`. Bridging the two names is the difference between a
# running server and a server that cannot reach its database.
#
# ## Why these two lines export instead of using `: "${NAME:=…}"`
#
# A plain assignment does not export a variable that was previously UNSET, so
# `: "${DATABASE_URL:=…}"` would seed a shell variable the exec'd node process never sees —
# inert in exactly the case this bridge exists for. `export NAME="${NAME:-…}"` keeps a
# caller's value, exports it, and still writes nothing of its own.
#
# ## What is deliberately NOT here
#
# No DSN, no remote endpoint, no credential: the database URL and the keys arrive from the
# caller. The one endpoint named is the image's own loopback listener, because the MCP tools
# proxy to `AKS_BASE_URL` and must reach the server they run inside. This file carries
# variable names and three defaults, nothing else.
set -eu

# `gateway` for both halves. It is the provider satisfied by a URL and a key alone,
# so a run that supplies only its chat base URL and key boots without also having to
# name a provider on the command line.
export EXTRACTION_PROVIDER="${EXTRACTION_PROVIDER:-gateway}"
export EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-gateway}"

# The embeddings service on its own host, seeded from the names the wiki publishes.
# Nested and preserving: a caller's `GATEWAY_EMBEDDINGS_*` wins over the wiki-side
# name, and an empty wiki-side name leaves the variable blank so the application's
# own inheritance rule stays the single owner of the fallback.
export GATEWAY_EMBEDDINGS_BASE_URL="${GATEWAY_EMBEDDINGS_BASE_URL:-${OPENAI_EMBEDDINGS_BASE_URL:-}}"
export GATEWAY_EMBEDDINGS_API_KEY="${GATEWAY_EMBEDDINGS_API_KEY:-${OPENAI_EMBEDDINGS_API_KEY:-}}"

# The published DSN name, bridged to the name the server actually reads. Nested and
# preserving: a caller's own `DATABASE_URL` always wins, a blank one counts as unset, and a
# blank pair leaves it empty rather than inventing a connection string.
export DATABASE_URL="${DATABASE_URL:-${AKS_DATABASE_URL:-}}"

# The MCP tools proxy to `AKS_BASE_URL`; unset, they miss the listener they run inside, and
# the first tool call fails with `fetch failed`. Loopback only, built from the application's
# own `PORT` default, so the tools always talk to this server and never to a remote host.
export AKS_BASE_URL="${AKS_BASE_URL:-http://127.0.0.1:${PORT:-8000}}"

# A caller-supplied command runs verbatim: this image is also the only place the
# server lives, so `docker run … <command>` must not be swallowed by a fixed
# entrypoint. Before this branch existed, `--entrypoint node` was the only way to
# start anything other than the baked command.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# `exec` so the server owns PID 1 and receives SIGTERM directly; without it the
# shell swallows the signal and the container waits out the Docker stop timeout.
# The port and bind address are the application's own (`PORT`, default 8000, bound
# to all interfaces), which is what the published port expects.
exec node packages/llmwiki-kg/ts/dist/index.js
