# syntax=docker/dockerfile:1
#
# One image for both dimensions.
#
# WHY THIS IMAGE AND `packages/llmwiki-kg/Dockerfile` BOTH EXIST
#
# The KG package ships its own image, and it builds only `ts/src` — the reference
# server, alone. This image builds the ROOT bundle instead, which is what carries
# `src/dimensions/**`: the wiki dimension, the transactional coordinator that puts
# both dimensions in one commit, and the CLI that can start either surface. The KG
# package image cannot serve the wiki dimension because the wiki dimension is not
# in its source tree; that is a fact about where the code lives, not a preference.
#
# So the two images are not duplicates and must not be collapsed. The KG one is the
# oracle-parity server measured against the Python reference; this one is the
# product. Both read the same database.
#
# WHY THE RUNTIME KEEPS `node_modules`
#
# `dist/cli.js` is a bundle, but not a self-contained one: it externalizes
# `@atomicstrata/llmwiki-core`, the MCP SDK, `zod`, `openai`, `commander`,
# `markdown-it`, `jsdom` and the rest of the 20 root dependencies. Dropping
# `node_modules` produces an image that starts and then fails on its first import,
# so the runtime stage installs production dependencies and carries them.

# ---- build -------------------------------------------------------------------
FROM node:24-slim AS build

WORKDIR /app

# Manifests first, so the dependency layer caches independently of source edits.
# The root manifest depends on workspace packages, so their manifests and lockfiles
# are copied before `npm ci` or the install resolves against a partial tree.
COPY package.json package-lock.json ./
# Only the packages that actually declare a manifest. `llmwiki-local-workflows` and
# `llmwiki-kg` have no root-level package.json — the KG manifest lives one level
# down at `ts/` — and copying a path that does not exist fails the whole build.
COPY packages/llmwiki-core/package.json packages/llmwiki-core/
COPY packages/llmwiki-kg/ts/package.json packages/llmwiki-kg/ts/
COPY packages/llmwiki-dev-backend/package.json packages/llmwiki-dev-backend/
COPY packages/llmwiki-limited-isolation-backend/package.json packages/llmwiki-limited-isolation-backend/
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY scripts ./scripts
COPY src ./src
COPY packages ./packages

# `tsup` also builds the compiler dependency packages, so this single command
# produces everything the runtime needs.
RUN npm run build

# Production dependencies only, from the lockfile, for the runtime stage.
RUN npm prune --omit=dev

# ---- runtime -----------------------------------------------------------------
FROM node:24-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
# The console is read by humans and by `docker logs`; unbuffered output means a
# crash shows its reason instead of an empty stream.
ENV NODE_OPTIONS=--enable-source-maps

# `psql` for the shared schema runner. A fresh Postgres has NO `wiki` tables, and
# `scripts/apply-schemas.sh` is the only thing that creates them in dependency
# order — the image's init hook applies one file and both dimensions need fifteen.
# The slim base ships no client, so this is installed rather than assumed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# Copied whole from the build stage: `cli.js` externalizes runtime dependencies, so
# pruning harder than `--omit=dev` breaks the image at its first import.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# `@atomicstrata/llmwiki-core` is a WORKSPACE package: `node_modules/@atomicstrata/
# llmwiki-core` is a symlink to `packages/llmwiki-core`, so it is not really inside
# `node_modules` and a runtime that copies `node_modules` alone ships a dangling link
# — the container then dies on `ERR_MODULE_NOT_FOUND` for that package. Its built
# `dist` is copied to the same relative path so the symlink resolves.
COPY --from=build /app/packages/llmwiki-core ./packages/llmwiki-core
# The wiki dimension reads its schema and migrations from the source tree at
# runtime when `apply-schemas` runs, and the KG schema lives beside it.
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src/dimensions ./src/dimensions
COPY --from=build /app/packages/llmwiki-kg/db ./packages/llmwiki-kg/db

# Runs as the unprivileged user the base image already provides; the container
# never needs to write to its own filesystem outside `/work`.
# Installed while still root: `chmod` on a path under /usr/local/bin fails once the
# container has dropped to the unprivileged user, and the entrypoint must be
# executable. It resolves the bind address at start time, which is why it is copied
# here and not baked into the command line.
COPY docker/entry.sh /usr/local/bin/entry.sh
RUN chmod +x /usr/local/bin/entry.sh

USER node

# The wiki the container compiles lives here, mounted from the host. Marking it a
# mount point documents that it is not part of the image.
WORKDIR /work
VOLUME ["/work"]

# DEFAULT SURFACE: MCP over stdio with `docker run -i`.
#
# The product is consumed by agents, so MCP is the default and HTTP is the opt-in.
# `llmwiki host` still serves both dimensions over one listener when asked:
# `docker run -e LLMWIKI_MODE=host -p 4173:4173 ...`, or pass the command yourself.
#
# EXPOSE documents the port the HTTP mode uses; it is not opened unless that mode
# runs, and Docker opens nothing by default regardless.
EXPOSE 4173

# WHY THE HTTP BIND ADDRESS IS RESOLVED AT START
#
# `resolveBindConfig` rejects wildcard binds on purpose: the viewer's origin gate
# accepts only the exact Host it bound to, so `--host 0.0.0.0` makes the accepted
# Host the literal `0.0.0.0:4173`, which no client ever sends — every request 403s,
# loopback included. Measured, not assumed.
#
# The container therefore binds a specific interface address, which is the only
# configuration that serves both dimensions. `entry.sh` resolves it at start time
# because the address does not exist when the image is built.
ENTRYPOINT ["/usr/local/bin/entry.sh"]
