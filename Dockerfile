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

WORKDIR /app

# Copy production dependencies (exact versions from package-lock.json)
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev

# Copy built assets
COPY --from=builder /app/dist ./dist
# Prisma engine and generated client are needed
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Need prisma for the auto-migration in src/db/migrate.ts
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3002
ENV HOST=0.0.0.0

EXPOSE 3002

# The server runs as the built-in non-root `node` user. Everything under /app
# is chowned to it first, so `prisma migrate deploy` — run at start-up from
# src/index.ts via src/db/migrate.ts (PRISMA_CLI, `node
# node_modules/prisma/build/index.js`, which only needs to read the Prisma
# files and execute the query-engine binary) — and the app itself never need
# root. The Prisma client targets `debian-openssl-3.0.x` in
# prisma/schema.prisma, which matches this Debian-based image.
RUN chown -R node:node /app
USER node

# Liveness only: /live answers as long as the event loop is turning and
# touches neither Postgres nor Redis (see docs/health.md). /ready must not be
# used here — a container must not be restarted because Postgres is briefly
# away. A Node one-liner is used so no curl install is needed.
HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=20s \
  CMD ["node", "-e", "fetch(`http://localhost:${process.env.PORT || 3002}/live`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Migrations run at start-up from src/index.ts via src/db/migrate.ts
# (applyMigrations).
CMD ["npm", "start"]
