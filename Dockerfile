# syntax=docker/dockerfile:1

# One build for every image: install, compile and assemble each app with
# only its production dependencies. It runs on the build machine's own
# architecture, since nothing here compiles native code, and the final
# images only copy its output. The base image is pinned by digest, which
# Dependabot updates.
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --offline
RUN pnpm build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @hookline/api deploy --prod /out/api \
    && pnpm --filter @hookline/worker deploy --prod /out/worker \
    && pnpm --filter @hookline/test-receiver deploy --prod /out/test-receiver

# Node without the package managers it ships with, which the apps never use
# and which only add files for a scanner to flag.
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production
WORKDIR /app
USER node

# Exec-form commands keep node as process 1, so docker stop's SIGTERM
# reaches the graceful shutdown.
FROM runtime AS api
COPY --from=build /out/api ./
COPY --from=build /repo/db/migrations ./migrations
ENV HOST=0.0.0.0 PORT=3000 MIGRATIONS_DIR=/app/migrations
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/server.js"]

# Runs the delivery worker by default; the relay is the same image with
# the command node dist/main-relay.js.
FROM runtime AS worker
COPY --from=build /out/worker ./
CMD ["node", "--enable-source-maps", "dist/main-deliver.js"]

FROM runtime AS test-receiver
COPY --from=build /out/test-receiver ./
ENV HOST=0.0.0.0 PORT=4000
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/main.js"]
