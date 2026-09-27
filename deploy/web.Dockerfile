# syntax=docker/dockerfile:1
# The MN Bank web app: the static site, built here and served by an unprivileged nginx, which also
# proxies /relay/ to the relay so the site and its relay share one origin (no CORS).
# The site's runtime configuration (/config.json) is written at start from the environment
# (deploy/web/entrypoint.sh), so one image serves any network. No secret is ever in this image.
# Build from the repository root, with the vendor/passport submodule checked out:
#   docker build -f deploy/web.Dockerfile .

ARG BUN_IMAGE=oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7
ARG NGINX_IMAGE=nginx:1.31.5-alpine@sha256:72ba65eb42c10344912a84ff42408db7d34f2feb642204570ab8fc5ffd29f1d3

FROM ${BUN_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY relay/package.json relay/
COPY web/package.json web/
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY scripts/fetch-compactc.sh scripts/compile-contracts.sh scripts/
COPY vendor/passport/contract vendor/passport/contract
# The light compile: the contracts' JavaScript for the browser (compactc 0.34.0, SHA-256 checked,
# --skip-zk: no keys).
RUN bash scripts/compile-contracts.sh
COPY packages/core packages/core
COPY web web
RUN bun run build:web \
 && rm -f web/dist/config.json

FROM ${NGINX_IMAGE}
COPY deploy/web/nginx.conf /etc/nginx/nginx.conf
COPY deploy/web/entrypoint.sh /usr/local/bin/mnbank-web
COPY --from=build /app/web/dist /usr/share/nginx/html
RUN chmod 0755 /usr/local/bin/mnbank-web \
 && rm -rf /etc/nginx/conf.d /docker-entrypoint.d
USER nginx
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/mnbank-web"]
