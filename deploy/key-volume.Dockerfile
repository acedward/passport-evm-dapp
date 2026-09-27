# syntax=docker/dockerfile:1
# The key-volume job (deploy/compose.yml service `keys`): compactc 0.34.0, the pinned Passport
# sources, and the relay's dependencies (for the Signet Compact module and the verification's
# ledger-v9). It builds the relay's prover and verifier keys INTO A VOLUME at run time
# (deploy/key-volume/build.sh); the image itself carries no keys.
# Build from the repository root, with the vendor/passport submodule checked out:
#   docker build -f deploy/key-volume.Dockerfile .

ARG BUN_IMAGE=oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

# The relay's production dependencies (the same lines as deploy/relay.Dockerfile, so the layer is shared).
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY relay/package.json relay/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production --ignore-scripts

# compactc 0.34.0 from its release archive, checked against the SHA-256 pinned in the script.
FROM ${BUN_IMAGE} AS compactc
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-compactc.sh /tmp/fetch-compactc.sh
RUN COMPACTC_DIR=/opt/compactc bash /tmp/fetch-compactc.sh

FROM ${BUN_IMAGE}
ARG PASSPORT_COMMIT=51c1fb4ad164af034c8ed60fbb047e43cdd509f5
ENV PASSPORT_COMMIT=${PASSPORT_COMMIT} \
    NODE_ENV=production \
    HOME=/tmp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=compactc /opt/compactc /opt/compactc
# zkir fetches the proving system's public parameters over HTTPS and needs the system CA bundle.
COPY --from=compactc /etc/ssl/certs /etc/ssl/certs
COPY package.json bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY relay/package.json relay/
COPY relay/src relay/src
# The vault v0.3.0 deposit preflight (pure), which @mnbank/core's bridge module re-exports.
COPY vendor/passport/contract/contracts/erc20-vault/src/preflight.ts vendor/passport/contract/contracts/erc20-vault/src/preflight.ts
# The Compact sources only (the account, its modules, the vault and the vendored singleton).
COPY vendor/passport/contract/contracts/account.compact vendor/passport/contract/contracts/
COPY vendor/passport/contract/contracts/modules vendor/passport/contract/contracts/modules
COPY vendor/passport/contract/contracts/erc20-vault/src/erc20-vault.compact vendor/passport/contract/contracts/erc20-vault/src/
COPY vendor/passport/contract/contracts/erc20-vault/src/vendor vendor/passport/contract/contracts/erc20-vault/src/vendor
COPY deploy/key-volume/build.sh /usr/local/bin/mnbank-key-volume
# The mount points, owned by the unprivileged user: a new named volume takes this ownership.
RUN chmod 0755 /usr/local/bin/mnbank-key-volume \
 && mkdir -p vendor/passport/contract/contracts/managed /zk-params \
 && chown bun:bun vendor/passport/contract/contracts/managed /zk-params
USER bun
ENTRYPOINT ["/usr/local/bin/mnbank-key-volume"]
