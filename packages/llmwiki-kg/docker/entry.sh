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
# ## What is deliberately NOT here
#
# No DSN, no endpoint, no credential: the database URL and the keys arrive from the
# caller. This file carries variable names and two provider defaults, nothing else.
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
