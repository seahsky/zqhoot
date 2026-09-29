# syntax=docker/dockerfile:1

# Production image of the VM target (ADR-0015): the single Node server plus the built web app.
#
#   docker build -t zqhoot .
#
# Behind an egress proxy that re-signs TLS (this project's CI sandbox), see "Building behind a
# proxy" in deploy/vm/README.md. Nothing in this file is needed on an ordinary network.

# ---------------------------------------------------------------------------
# Build: install the workspace, build the web app and bundle the server.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /repo
ENV CI=true \
    npm_config_store_dir=/pnpm/store

# Optional secret `cacert`: a PEM bundle for registries behind a TLS-intercepting proxy. It exists
# only while a RUN step executes, so it is neither in a layer nor in the final image. The proxy
# settings, if any, arrive as the predefined build args HTTPS_PROXY and NO_PROXY, which Docker
# keeps out of the image history.
RUN --mount=type=secret,id=cacert \
    if [ -s /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi \
    && corepack enable \
    && corepack prepare pnpm@10.33.0 --activate

# Dependencies come first and only from the manifests, so editing source does not download and link
# every package again: this layer changes only when a package.json or the lockfile does. --parents
# keeps each manifest in its own folder; the globs mirror pnpm-workspace.yaml (load*/ matches the
# load-test package when there is one, and nothing otherwise). Only what the web app and the server
# need is installed. The store sits on the same filesystem as node_modules, so pnpm hard-links
# instead of copying (half the disk while building).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json load*/package.json ./
RUN --mount=type=secret,id=cacert \
    if [ -s /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi \
    && pnpm install --frozen-lockfile --filter @zqhoot/web... --filter @zqhoot/server-node...

# The source. .dockerignore keeps every node_modules out, so the install above stays intact. The
# second install downloads nothing while the manifests above were complete: it only links the
# workspace packages, after which the store is not needed any more.
COPY . .
RUN --mount=type=secret,id=cacert \
    if [ -s /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi \
    && pnpm install --frozen-lockfile --filter @zqhoot/web... --filter @zqhoot/server-node... \
    && rm -rf /pnpm/store

RUN pnpm --filter @zqhoot/web build \
    && pnpm --filter @zqhoot/server-node build

# Source maps keep `--enable-source-maps` stack traces readable; their embedded copy of every
# bundled source file is what would put source code into the image, so it is dropped.
RUN node -e '\
  const fs = require("node:fs"); \
  const dir = "apps/server-node/dist"; \
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".map"))) { \
    const map = JSON.parse(fs.readFileSync(`${dir}/${name}`, "utf8")); \
    delete map.sourcesContent; \
    fs.writeFileSync(`${dir}/${name}`, JSON.stringify(map)); \
  }'

# ---------------------------------------------------------------------------
# Runtime: the bundle, the web app and nothing else. The server has no runtime dependencies.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    ZQ_WEB_DIST=/app/web \
    ZQ_DATA_DIR=/data \
    YARN_VERSION=

# The base image ships npm, corepack and yarn together with their node_modules. The server runs none
# of them, so they would only add attack surface and scanner findings: they are removed. (The base
# layers still hold the files, so this does not shrink the image; it removes them from the
# filesystem the container sees and scanners report.)
# The image's own /data (owned by `node`) seeds a fresh named volume, so the volume is writable by
# the non-root user from the first start. VOLUME comes after the chown on purpose: changes made to
# a volume's path afterwards are discarded.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir /data \
    && chown node:node /data
VOLUME /data

WORKDIR /app
COPY --from=build /repo/apps/server-node/dist/ ./
COPY --from=build /repo/apps/web/dist/ ./web/

# Passed by docker-compose.yml, which reads them from the environment:
#   ZQ_REVISION=$(git rev-parse HEAD) docker compose up -d --build
# Declared this late so that a new value invalidates none of the layers above.
ARG ZQ_VERSION=dev
ARG ZQ_REVISION=unknown
LABEL org.opencontainers.image.title="zqhoot" \
      org.opencontainers.image.description="Self-hosted live quiz and audience interaction server (single-VM target)" \
      org.opencontainers.image.source="https://github.com/seahsky/zqhoot" \
      org.opencontainers.image.version="${ZQ_VERSION}" \
      org.opencontainers.image.revision="${ZQ_REVISION}"

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "--enable-source-maps", "server.mjs"]
