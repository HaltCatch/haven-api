# syntax=docker/dockerfile:1
FROM node:26.13.0-bookworm-slim AS build
ENV HUSKY=0 CI=true PNPM_CONFIG_VIRTUAL_STORE_TYPE=local
WORKDIR /app
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++
RUN --mount=type=cache,target=/root/.npm \
    npm install --global pnpm@12.18.0 --no-audit --no-fund
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    --mount=type=cache,id=haven-api-pnpm,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prefer-offline --store-dir=/pnpm/store --config.package-import-method=copy
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    --mount=type=cache,id=haven-api-pnpm,target=/pnpm/store,sharing=locked \
    pnpm build && pnpm --store-dir=/pnpm/store prune --prod --ignore-scripts

FROM node:26.13.0-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/HaltCatch/haven-api"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 HAVEN_DATABASE=/data/haven.db
WORKDIR /app
RUN mkdir -p /data /backup && chown node:node /data /backup
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY container ./container
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "container/health.mjs"]
CMD ["node", "dist/main.js"]
