FROM node:24.8.0-alpine AS workspace
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY vendor ./vendor
COPY scripts ./scripts
COPY tsconfig.json ./
RUN pnpm install --frozen-lockfile

FROM workspace AS api-build
RUN pnpm exec esbuild apps/api/src/index.ts --bundle --platform=node --format=esm --target=node24 \
      --loader:.sql=text --external:fastify --external:pg --external:pg-native \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=apps/api/dist/index.js \
  && pnpm --filter @winsendotai/ovo-api deploy --prod --legacy /runtime/api \
  && mkdir -p /runtime/api/dist \
  && cp apps/api/dist/index.js /runtime/api/dist/index.js

FROM node:24.8.0-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-build /runtime/api/ ./
USER root
RUN mkdir -p /var/lib/ovo-recordings && chown -R node:node /var/lib/ovo-recordings
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]

FROM workspace AS console-build
RUN pnpm build:vendor \
  && pnpm --filter @winsendotai/ovo-console build \
  && pnpm --filter @winsendotai/ovo-console deploy --prod --legacy /runtime/console \
  && cp -R apps/console/.next /runtime/console/.next

FROM node:24.8.0-alpine AS console
ENV NODE_ENV=production
WORKDIR /app
COPY --from=console-build /runtime/console/ ./
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]

FROM workspace AS gateway-build
RUN pnpm --filter @winsendotai/ovo-media-gateway build \
  && pnpm --filter @winsendotai/ovo-media-gateway deploy --prod --legacy /runtime/gateway \
  && mkdir -p /runtime/gateway/dist \
  && cp apps/media-gateway/dist/main.cjs /runtime/gateway/dist/main.cjs

FROM node:24.8.0-alpine AS gateway
ENV NODE_ENV=production
WORKDIR /app
COPY --from=gateway-build /runtime/gateway/ ./
USER node
EXPOSE 4001
CMD ["node", "dist/main.cjs"]

FROM workspace AS dispatcher-build
RUN pnpm --filter @winsendotai/ovo-dispatcher build \
  && pnpm --filter @winsendotai/ovo-dispatcher deploy --prod --legacy /runtime/dispatcher \
  && mkdir -p /runtime/dispatcher/dist \
  && cp apps/dispatcher/dist/main.cjs /runtime/dispatcher/dist/main.cjs

FROM node:24.8.0-alpine AS dispatcher
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dispatcher-build /runtime/dispatcher/ ./
USER node
EXPOSE 4002
CMD ["node", "dist/main.cjs"]

FROM workspace AS worker-build
RUN pnpm --filter @winsendotai/ovo-worker build \
  && pnpm --filter @winsendotai/ovo-worker deploy --prod --legacy /runtime/worker \
  && mkdir -p /runtime/worker/dist \
  && cp apps/worker/dist/main.cjs /runtime/worker/dist/main.cjs

FROM node:24.8.0-alpine AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=worker-build /runtime/worker/ ./
USER root
RUN mkdir -p /var/lib/ovo-recordings && chown -R node:node /var/lib/ovo-recordings
USER node
EXPOSE 4100
CMD ["node", "dist/main.cjs"]
