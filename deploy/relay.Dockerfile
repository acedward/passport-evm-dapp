# syntax=docker/dockerfile:1
# The MN Bank relay. The image holds code only: no prover keys (they are a read-only volume
# mounted at MIDNIGHT_MANAGED_PATH) and no secrets (mounted as files, see .env.example).
# Build from the repository root:  docker build -f deploy/relay.Dockerfile .

FROM oven/bun:1.3.11 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY relay/package.json relay/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.3.11
WORKDIR /app
ARG RELAY_VERSION=dev
ENV NODE_ENV=production \
    RELAY_VERSION=${RELAY_VERSION} \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY relay/package.json relay/
COPY relay/src relay/src
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.RELAY_PORT || 8080) + '/v1/config').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "relay/src/main.ts"]
