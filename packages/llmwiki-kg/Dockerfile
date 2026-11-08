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
# cannot work any more; it must be the repository root, which is NOT yet reflected
# in `docker-compose.yml` (that wiring is a separate change).
#
# Measured for this shape: install exits 0 with 596 packages, the filtered build
# produces `packages/llmwiki-kg/ts/dist/index.js`, and the prune leaves 222
# packages with the dev dependencies gone.
FROM node:24-slim

WORKDIR /code

# Manifests first, so the dependency layer caches independently of source changes.
# Every workspace manifest is copied, because pnpm validates the whole workspace
# against the one lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/llmwiki-core/package.json packages/llmwiki-core/
COPY packages/llmwiki-kg/ts/package.json packages/llmwiki-kg/ts/
RUN pnpm install --frozen-lockfile

# Build only this package, then drop the dev dependencies the runtime does not
# need. `--ignore-scripts` keeps the root `prepare` hook from running against a
# tree whose `husky` was just pruned, and the purge confirmation is disabled
# because a build has no TTY to answer it.
COPY packages/llmwiki-kg/ts/tsconfig.json packages/llmwiki-kg/ts/tsconfig.build.json packages/llmwiki-kg/ts/
COPY packages/llmwiki-kg/ts/src packages/llmwiki-kg/ts/src
RUN pnpm --filter aks-reference-server run build \
 && pnpm prune --prod --ignore-scripts --config.confirm-modules-purge=false

EXPOSE 8000

# The entrypoint reads configuration from the environment, so nothing is baked
# into the image. See .env.example for the variables it expects. The path is the
# workspace-relative one the filtered build writes to; `node_modules` stays hoisted
# at `/code`, which this script resolves by walking up.
CMD ["node", "packages/llmwiki-kg/ts/dist/index.js"]
