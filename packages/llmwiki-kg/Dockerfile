# syntax=docker/dockerfile:1
#
# BUILD CONTEXT: THE REPOSITORY ROOT — `docker build -f packages/llmwiki-kg/Dockerfile .`
#
# `packages/llmwiki-kg/ts` is a member of the repository pnpm WORKSPACE, so its
# dependencies come from the single root `pnpm-lock.yaml`. pnpm validates every
# workspace importer against that lockfile, and a Docker COPY cannot reach above
# its build context, so nothing inside this directory can install from it: this
# file used to `npm ci` a nested `ts/package-lock.json`, and that lockfile no
# longer exists. Building with `packages/llmwiki-kg` as the context therefore
# cannot work any more; it must be the repository root. That root context IS
# wired in the service that ships this image
# (`packages/llmwiki-kg/docker-compose.yml`, `build.context: ../..`), and any
# other caller must build it the same way:
# `docker build -f packages/llmwiki-kg/Dockerfile .`
#
# WHY THE RUNTIME TREE IS INSTALLED, NOT PRUNED
#
# This file used to prune: `pnpm --filter @repo/kg run build && pnpm prune --prod
# --ignore-scripts --config.confirm-modules-purge=false`. `pnpm prune --prod` is
# the step that deadlocks in its removal/relink phase on a fresh `node_modules` —
# measured on the root image, which carried the identical step: it printed to
# `1.827s` and then hung ~39 minutes until the build timed out, with the main
# thread parked in `ep_poll`, no block I/O and RSS 1.9 GB, while a re-run on an
# already-pruned tree finished instantly. Not having a removal phase is the fix;
# diagnosing pnpm's unlink path is not this delivery's job. The `prod-deps` stage
# below installs the production set into an EMPTY tree, so there is nothing to
# prune and nothing to hang in, and the runtime stage takes `node_modules` from
# it. The same repair, for the same reason, is at the top of the root `Dockerfile`.

# ---- build -------------------------------------------------------------------
FROM node:24-slim AS build

WORKDIR /code

# `node:24-slim` ships corepack but no `pnpm` symlink, so the root manifest's
# `packageManager: pnpm@11.5.0` is INERT until corepack is enabled and the install
# below dies with `/bin/sh: 1: pnpm: not found` (exit 127) — measured on this file,
# on this base image. Enabling corepack lets the manifest's pin decide the
# toolchain instead of a version hard-coded here.
RUN corepack enable

# Manifests first, so the dependency layer caches independently of source changes.
# Every workspace manifest is copied, because pnpm validates the whole workspace
# against the one lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/llmwiki-core/package.json packages/llmwiki-core/
COPY packages/llmwiki-kg/ts/package.json packages/llmwiki-kg/ts/
# `@repo/foundation` is the one workspace package `@repo/kg` names as
# `workspace:*`, so the install has to be able to resolve the member.
COPY packages/foundation/package.json packages/foundation/
RUN pnpm install --frozen-lockfile

# Build only this package. This stage deliberately does NOT prune: the runtime
# stage takes its `node_modules` from the `prod-deps` stage below instead.
COPY packages/llmwiki-kg/ts/tsconfig.json packages/llmwiki-kg/ts/tsconfig.build.json packages/llmwiki-kg/ts/
COPY packages/llmwiki-kg/ts/src packages/llmwiki-kg/ts/src
# `@repo/foundation` publishes TypeScript SOURCE and has no build of its own, and
# the server re-exports from it (`src/stack-id.ts`), so `tsc` needs the sources
# beside the manifest copied above. Without them the build fails with
# `error TS2307: Cannot find module '@repo/foundation'` — measured.
COPY packages/foundation/src packages/foundation/src
RUN pnpm --filter @repo/kg run build

# ---- production dependencies ---------------------------------------------------
#
# A SECOND, INDEPENDENT install — production only, and rooted at the app this
# image runs.
#
# `--filter @repo/kg` is load-bearing and is not a narrowing for size. `@repo/kg`
# is a root DEVdependency, so a plain root `pnpm install --prod` never resolves
# the app at all: the tree comes out without any `@repo` link and the container
# starts and then dies on `ERR_MODULE_NOT_FOUND: Cannot find package
# '@repo/foundation'` — measured on this file. The production graph that matters
# here is the one rooted at the server being shipped.
#
# `--prod` drops every devDependency, `--ignore-scripts` keeps the root `prepare`
# hook (`husky`, a dev dependency that is not installed here) from running, and
# `--frozen-lockfile` makes this layer fail loudly the moment a manifest and the
# lockfile disagree instead of silently resolving a different tree than the host.
FROM node:24-slim AS prod-deps

WORKDIR /code

# Same reason as the build stage: no `pnpm` on PATH until corepack is enabled.
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/llmwiki-core/package.json packages/llmwiki-core/
COPY packages/llmwiki-kg/ts/package.json packages/llmwiki-kg/ts/
COPY packages/foundation/package.json packages/foundation/
RUN pnpm --filter @repo/kg install --prod --frozen-lockfile --ignore-scripts

# ---- runtime -----------------------------------------------------------------
FROM node:24-slim AS runtime

WORKDIR /code

# The production install, never the build tree: the build tree also carries every
# dev dependency (`tsc`, `vitest`, `tsx`) that nothing here loads, and it is the
# tree whose pruning is what used to hang.
COPY --from=prod-deps /code/node_modules ./node_modules
# A project's OWN direct-dependency links live in its own `node_modules`, not in
# the hoisted root one. The install above leaves exactly one entry there —
# `@repo/foundation -> ../../../../foundation` — and the compiled server re-exports
# from it, so without this COPY the entry resolves nothing. The link is not
# dangling: the `packages/foundation` COPY below supplies its target.
COPY --from=prod-deps /code/packages/llmwiki-kg/ts/node_modules packages/llmwiki-kg/ts/node_modules
# `type: module` in this manifest is what makes Node read `dist/*.js` as ESM, and
# it is the nearest `package.json` to the entry, so it has to be here.
COPY --from=build /code/packages/llmwiki-kg/ts/package.json packages/llmwiki-kg/ts/
COPY --from=build /code/packages/llmwiki-kg/ts/dist packages/llmwiki-kg/ts/dist
# Source, not `dist`: `@repo/foundation` has no build step (see the build stage).
COPY --from=build /code/packages/foundation ./packages/foundation

EXPOSE 8000

# The entrypoint reads configuration from the environment, so nothing is baked
# into the image. See .env.example for the variables it expects. The path is the
# workspace-relative one the filtered build writes to; `node_modules` stays hoisted
# at `/code`, which this script resolves by walking up.
CMD ["node", "packages/llmwiki-kg/ts/dist/index.js"]
