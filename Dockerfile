# ---- Stage 1: Build ----
# Debian (glibc), NOT Alpine (musl): sqlite-vec only publishes a glibc build of
# vec0.so. On musl it fails to relocate (__memcpy_chk / __fread_chk not found),
# SQLite retries the path with an extra `.so`, and RAG is disabled at boot with
# a misleading "vec0.so.so: No such file or directory".
FROM node:20-slim AS builder

# node-gyp fallbacks (ssh2, canvas) need a toolchain when no prebuild matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy everything first — pnpm needs the full workspace tree (all package.json + sources)
# to create proper symlinks between workspace packages.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ packages/
COPY ee/ ee/

# Install all deps and create workspace symlinks
RUN pnpm install --frozen-lockfile

# Build all packages
RUN pnpm build

# ---- Stage 2: Runtime ----
# Must stay glibc for the same sqlite-vec reason as the builder stage.
FROM node:20-slim

# wget backs both the Dockerfile HEALTHCHECK and the docker-compose healthcheck;
# node:20-slim does not ship it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace root
COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/package.json ./

# Copy built packages with their package.json
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/packages/cli/package.json ./packages/cli/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/connectors/dist ./packages/connectors/dist
COPY --from=builder /app/packages/connectors/package.json ./packages/connectors/
COPY --from=builder /app/packages/web/dist ./packages/web/dist
COPY --from=builder /app/packages/web/package.json ./packages/web/
COPY --from=builder /app/ee/sso/dist ./ee/sso/dist
COPY --from=builder /app/ee/sso/package.json ./ee/sso/

# EE RAG packages. `rag-core` is mandatory — without it `initRagRuntime` bails
# out with "EE package @calame-ee/rag-core not installed", /health reports
# ragEnabled:false and the "Knowledge base" source type is greyed out in the UI.
# The connector packages are optional at runtime (absent → their source types
# answer 501) but are declared as `workspace:*` deps of packages/cli, so the
# workspace tree must contain them for `pnpm install` to resolve the links.
COPY --from=builder /app/ee/rag-core/dist ./ee/rag-core/dist
COPY --from=builder /app/ee/rag-core/package.json ./ee/rag-core/
COPY --from=builder /app/ee/rag-connectors/dist ./ee/rag-connectors/dist
COPY --from=builder /app/ee/rag-connectors/package.json ./ee/rag-connectors/
COPY --from=builder /app/ee/rag-gdrive/dist ./ee/rag-gdrive/dist
COPY --from=builder /app/ee/rag-gdrive/package.json ./ee/rag-gdrive/
COPY --from=builder /app/ee/rag-gsheets/dist ./ee/rag-gsheets/dist
COPY --from=builder /app/ee/rag-gsheets/package.json ./ee/rag-gsheets/
COPY --from=builder /app/ee/rag-notion/dist ./ee/rag-notion/dist
COPY --from=builder /app/ee/rag-notion/package.json ./ee/rag-notion/
COPY --from=builder /app/ee/rag-microsoft/dist ./ee/rag-microsoft/dist
COPY --from=builder /app/ee/rag-microsoft/package.json ./ee/rag-microsoft/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Create data directory
RUN mkdir -p /data && chown node:node /data

# Copy demo generation script and entrypoint
COPY scripts/generate-demo-db.js ./scripts/generate-demo-db.js
COPY entrypoint.sh /entrypoint.sh
# Strip CR before chmod: on a Windows checkout (core.autocrlf=true) entrypoint.sh
# arrives with CRLF, the kernel reads the shebang as `/bin/sh\r`, and the
# container dies with `exec /entrypoint.sh: no such file or directory`.
# .gitattributes pins LF for new checkouts; this keeps existing ones building.
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV CALAME_DATA_DIR=/data

EXPOSE 4567

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:4567/health || exit 1

USER node

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "packages/cli/dist/index.js"]
