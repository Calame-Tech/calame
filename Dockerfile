# ---- Stage 1: Build ----
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy everything first — pnpm needs the full workspace tree (all package.json + sources)
# to create proper symlinks between workspace packages on Alpine.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ packages/

# Install all deps and create workspace symlinks
RUN pnpm install --frozen-lockfile

# Build all packages
RUN pnpm build

# ---- Stage 2: Runtime ----
FROM node:20-alpine

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

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Create data directory
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
ENV CALAME_DATA_DIR=/data

EXPOSE 4567

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:4567/health || exit 1

USER node

CMD ["node", "packages/cli/dist/index.js"]
