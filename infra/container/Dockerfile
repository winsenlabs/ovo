# OPS-9: layers are ordered so a source change never re-downloads dependencies. `pnpm fetch` reads
# only the lockfile, so its layer (the whole package store) is reused until pnpm-lock.yaml changes;
# the sources are copied after it and installed offline from that store. Each runtime stage holds
# only its app's production closure (`pnpm deploy --prod`). Images are glibc (bookworm), never
# musl: native bindings in the lockfile have no musl variants.
# Build every target at once with infra/container/docker-bake.hcl (scripts/deploy/build-images.sh).
FROM node:24.8.0-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate
WORKDIR /workspace

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

FROM deps AS workspace
COPY package.json tsconfig.json ./
COPY vendor ./vendor
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --offline

FROM workspace AS api-build
RUN pnpm --filter @winsendotai/ovo-api build \
  && pnpm --filter @winsendotai/ovo-api deploy --prod --legacy /runtime/api \
  && mkdir -p /runtime/api/dist \
  && cp apps/api/dist/index.js /runtime/api/dist/index.js

FROM node:24.8.0-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-build /runtime/api/ ./
USER root
RUN mkdir -p /var/lib/ovo-recordings && chown -R node:node /var/lib/ovo-recordings
USER node
EXPOSE 4000
ARG OVO_REVISION=unknown
LABEL org.opencontainers.image.revision=$OVO_REVISION org.opencontainers.image.title=ovo-api
ENV OVO_REVISION=$OVO_REVISION
CMD ["node", "dist/index.js"]

FROM workspace AS console-build
RUN pnpm build:vendor \
  && pnpm --filter @winsendotai/ovo-console build \
  && pnpm --filter @winsendotai/ovo-console deploy --prod --legacy /runtime/console \
  && cp -R apps/console/.next /runtime/console/.next

FROM node:24.8.0-bookworm-slim AS console
ENV NODE_ENV=production
WORKDIR /app
COPY --from=console-build /runtime/console/ ./
USER node
EXPOSE 3000
ARG OVO_REVISION=unknown
LABEL org.opencontainers.image.revision=$OVO_REVISION org.opencontainers.image.title=ovo-console
ENV OVO_REVISION=$OVO_REVISION
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]

FROM workspace AS gateway-build
RUN pnpm --filter @winsendotai/ovo-media-gateway build \
  && pnpm --filter @winsendotai/ovo-media-gateway deploy --prod --legacy /runtime/gateway \
  && mkdir -p /runtime/gateway/dist \
  && cp apps/media-gateway/dist/main.cjs /runtime/gateway/dist/main.cjs

FROM node:24.8.0-bookworm-slim AS gateway
ENV NODE_ENV=production
WORKDIR /app
COPY --from=gateway-build /runtime/gateway/ ./
USER node
EXPOSE 4001
ARG OVO_REVISION=unknown
LABEL org.opencontainers.image.revision=$OVO_REVISION org.opencontainers.image.title=ovo-gateway
ENV OVO_REVISION=$OVO_REVISION
CMD ["node", "dist/main.cjs"]

FROM workspace AS dispatcher-build
RUN pnpm --filter @winsendotai/ovo-dispatcher build \
  && pnpm --filter @winsendotai/ovo-dispatcher deploy --prod --legacy /runtime/dispatcher \
  && mkdir -p /runtime/dispatcher/dist \
  && cp apps/dispatcher/dist/main.cjs /runtime/dispatcher/dist/main.cjs

FROM node:24.8.0-bookworm-slim AS dispatcher
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dispatcher-build /runtime/dispatcher/ ./
USER node
EXPOSE 4002
ARG OVO_REVISION=unknown
LABEL org.opencontainers.image.revision=$OVO_REVISION org.opencontainers.image.title=ovo-dispatcher
ENV OVO_REVISION=$OVO_REVISION
CMD ["node", "dist/main.cjs"]

FROM workspace AS worker-build
RUN pnpm --filter @winsendotai/ovo-worker build \
  && pnpm --filter @winsendotai/ovo-worker deploy --prod --legacy /runtime/worker \
  && mkdir -p /runtime/worker/dist \
  && cp apps/worker/dist/main.cjs /runtime/worker/dist/main.cjs

FROM node:24.8.0-bookworm-slim AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=worker-build /runtime/worker/ ./
USER root
RUN mkdir -p /var/lib/ovo-recordings && chown -R node:node /var/lib/ovo-recordings
USER node
EXPOSE 4100
ARG OVO_REVISION=unknown
LABEL org.opencontainers.image.revision=$OVO_REVISION org.opencontainers.image.title=ovo-worker
ENV OVO_REVISION=$OVO_REVISION
CMD ["node", "dist/main.cjs"]
