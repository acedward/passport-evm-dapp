# syntax=docker/dockerfile:1
# The MN Bank relay. The image holds code only: no prover keys and no secrets (mounted as files,
# see .env.example). The key volume (the compiled contracts with the relay's prover keys, plan
# P0.5) is mounted read-only at /app/vendor/passport/contract/contracts/managed, the directory the
# pinned Passport client imports its compiled account from, so the relay proves with the key
# volume's own compile (it refuses to load otherwise: relay/src/passport/runtime.ts).
# Build from the repository root, with the vendor/passport submodule checked out:
#   docker build -f deploy/relay.Dockerfile .

ARG BUN_IMAGE=oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY relay/package.json relay/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM ${BUN_IMAGE}
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
# The pinned Passport client (acedward/passport @ 51c1fb4, the vendor/passport submodule): its
# TypeScript sources only, and an empty mount point for the key volume.
COPY vendor/passport/contract/package.json vendor/passport/contract/
COPY vendor/passport/contract/src vendor/passport/contract/src
# The vault v0.3.0 deposit preflight (pure, no imports), which @mnbank/core's bridge contract re-exports.
COPY vendor/passport/contract/contracts/erc20-vault/src/preflight.ts vendor/passport/contract/contracts/erc20-vault/src/preflight.ts
RUN mkdir -p vendor/passport/contract/contracts/managed
ENV MIDNIGHT_MANAGED_PATH=/app/vendor/passport/contract/contracts/managed
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.RELAY_PORT || 8080) + '/v1/config').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "relay/src/main.ts"]
