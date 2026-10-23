FROM node:24-slim

WORKDIR /code

# Install dependencies first so the layer caches independently of source changes.
COPY ts/package.json ts/package-lock.json ./
RUN npm ci

# Build, then drop the dev dependencies the runtime does not need.
COPY ts/tsconfig.json ts/tsconfig.build.json ./
COPY ts/src ./src
RUN npm run build && npm prune --omit=dev

EXPOSE 8000

# The entrypoint reads configuration from the environment, so nothing is baked
# into the image. See .env.example for the variables it expects.
CMD ["node", "dist/index.js"]
