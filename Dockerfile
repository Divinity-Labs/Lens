# Stage 1: Build
FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies (exact versions from package-lock.json)
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Stage 2: Run
FROM node:22-slim

# Prisma's engines need libssl3 (prisma/schema.prisma targets
# `debian-openssl-3.0.x`). On main it arrived only as a dependency of the curl
# install this PR removes, so install openssl explicitly — it pulls libssl3
# in — or `prisma migrate deploy` at start-up crash-loops.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# The server runs as the built-in non-root `node` user, and so does everything
# from here on. /app is handed to it while it is still empty, and every file is
# then written or copied as `node`. Changing the owner afterwards with
# `chown -R` works too, but it copies all of /app into a second layer: measured
# on this image, 1.17 GB became 1.6 GB.
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

# Copy production dependencies (exact versions from package-lock.json)
COPY --chown=node:node package*.json ./
COPY --chown=node:node prisma ./prisma/
RUN npm ci --omit=dev

# Copy built assets
COPY --chown=node:node --from=builder /app/dist ./dist
# Prisma engine and generated client are needed
COPY --chown=node:node --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=node:node --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Need prisma for the auto-migration in src/db/migrate.ts
COPY --chown=node:node --from=builder /app/node_modules/prisma ./node_modules/prisma

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3002
ENV HOST=0.0.0.0

EXPOSE 3002

# `prisma migrate deploy` runs at start-up from src/index.ts via
# src/db/migrate.ts (PRISMA_CLI, `node node_modules/prisma/build/index.js`).
# It only needs to read the Prisma files and execute the query-engine binary,
# all owned by `node` above, so neither it nor the app ever needs root. The
# Prisma client targets `debian-openssl-3.0.x` in prisma/schema.prisma, which
# matches this Debian-based image.

# Liveness only: /live answers as long as the event loop is turning and
# touches neither Postgres nor Redis (see docs/health.md). /ready must not be
# used here — a container must not be restarted because Postgres is briefly
# away. A Node one-liner is used so no curl install is needed. The 60s
# start period is the grace the old compose healthcheck gave first-run
# migrations before the server can become live.
HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=60s \
  CMD ["node", "-e", "fetch(`http://localhost:${process.env.PORT || 3002}/live`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Migrations run at start-up from src/index.ts via src/db/migrate.ts
# (applyMigrations).
CMD ["npm", "start"]
