FROM oven/bun:1.4.4-slim AS bun
FROM node:26.13.1-trixie-slim AS build

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

COPY package.json bun.lock .npmrc tsconfig.json ./
COPY packages/proxy/package.json packages/proxy/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json
ARG BUN_CONFIG_REGISTRY
RUN if [ -n "$BUN_CONFIG_REGISTRY" ]; then export BUN_CONFIG_REGISTRY; fi; \
    HUSKY=0 bun install --frozen-lockfile && \
    if [ -n "$BUN_CONFIG_REGISTRY" ]; then ! grep -F "$BUN_CONFIG_REGISTRY" bun.lock; fi

COPY packages/proxy/src packages/proxy/src
COPY packages/dashboard/src packages/dashboard/src
COPY packages/dashboard/public packages/dashboard/public
COPY packages/dashboard/next.config.ts packages/dashboard/postcss.config.mjs packages/dashboard/tsconfig.json packages/dashboard/

ENV NEXT_TELEMETRY_DISABLED=1
RUN cd packages/dashboard && \
    node node_modules/next/dist/bin/next typegen && \
    node node_modules/typescript/bin/tsc --noEmit && \
    node node_modules/next/dist/bin/next build

FROM node:26.13.1-trixie-slim AS runtime

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOME=/home/node \
    RAVEN_CONFIG_DIR=/var/lib/raven/config \
    RAVEN_DATA_DIR=/var/lib/raven/data

COPY package.json bun.lock .npmrc tsconfig.json ./
COPY packages/proxy/package.json packages/proxy/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json
ARG BUN_CONFIG_REGISTRY
RUN if [ -n "$BUN_CONFIG_REGISTRY" ]; then export BUN_CONFIG_REGISTRY; fi; \
    HUSKY=0 bun install --frozen-lockfile --production --ignore-scripts && \
    if [ -n "$BUN_CONFIG_REGISTRY" ]; then ! grep -F "$BUN_CONFIG_REGISTRY" bun.lock; fi

COPY --from=build --chown=node:node /app/packages/dashboard/.next packages/dashboard/.next
COPY --chown=node:node packages/dashboard/public packages/dashboard/public
COPY --chown=node:node packages/dashboard/next.config.ts packages/dashboard/
COPY --from=build --chown=node:node /app/packages/proxy/src packages/proxy/src
COPY --chown=node:node scripts/container-entrypoint.ts scripts/container-entrypoint.ts

RUN mkdir -p /var/lib/raven/config /var/lib/raven/data && \
    chown -R node:node /var/lib/raven && \
    chmod 700 /var/lib/raven /var/lib/raven/config /var/lib/raven/data

USER node
EXPOSE 7023 7024
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["bun", "-e", "Promise.all(['http://127.0.0.1:7024/health','http://127.0.0.1:7023/api/auth/config'].map(async u=>{const r=await fetch(u);if(!r.ok)process.exit(1)})).catch(()=>process.exit(1))"]

ENTRYPOINT ["bun", "run", "scripts/container-entrypoint.ts"]
