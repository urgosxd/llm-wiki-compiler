# syntax=docker/dockerfile:1
#
# One image for both dimensions.
#
# WHY THIS IMAGE AND `packages/llmwiki-kg/Dockerfile` BOTH EXIST
#
# The KG package ships its own image, and it builds only `ts/src` — the reference
# server, alone. This image builds the ROOT bundle instead, which is what carries
# `packages/wiki/src/dimensions/**`: the wiki dimension, the transactional coordinator that puts
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
# The root manifest depends on workspace packages, so their manifests and the
# single workspace lockfile are copied before `pnpm install` or the install
# resolves against a partial tree — pnpm validates the whole workspace against
# `pnpm-lock.yaml`, so every member manifest has to be here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Only the packages that actually declare a manifest. `llmwiki-local-workflows` and
# `llmwiki-kg` have no root-level package.json — the KG manifest lives one level
# down at `ts/` — and copying a path that does not exist fails the whole build.
COPY packages/llmwiki-core/package.json packages/llmwiki-core/
COPY packages/llmwiki-kg/ts/package.json packages/llmwiki-kg/ts/
# `@repo/wiki` is a root devDependency pinned as `workspace:*`, so its manifest has
# to exist before `pnpm install` or the install cannot resolve the member.
COPY packages/wiki/package.json packages/wiki/
# `@repo/api` is a root workspace member (the root manifest's `workspaces`) and the
# entry the image execs, so the frozen install validates its manifest before it can
# resolve the workspace — the same reason the three manifests above are copied.
COPY packages/api/package.json packages/api/
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsup.config.ts ./
COPY scripts ./scripts
# The wiki source no longer sits at `./src`: it is `@repo/wiki`'s tree under
# `./packages/wiki/src`, which the `packages` copy below already carries.
COPY packages ./packages

# `tsup` also builds the compiler dependency packages, so this single command
# produces everything the runtime needs.
RUN pnpm run build

# Production dependencies only, for the runtime stage. `--ignore-scripts` is load
# bearing: pruning also runs the root `prepare` hook, and `husky` is one of the dev
# dependencies this step just removed, so the hook would fail the layer. The purge
# confirmation is the other one: with the tree replaced wholesale, pnpm asks before
# removing `node_modules` and aborts with
# `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` in a build, which has no TTY.
RUN pnpm prune --prod --ignore-scripts --config.confirm-modules-purge=false

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
# pruning harder than `--prod` breaks the image at its first import.
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
# runtime when `apply-schemas` runs, and the KG schema lives beside it. The paths
# are `scripts/apply-schemas.sh`'s, which are repository-relative.
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/packages/wiki/src/dimensions ./packages/wiki/src/dimensions
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
