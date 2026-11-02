# Multi-stage build for Next.js 15 in standalone mode.

FROM node:24.22.1-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Use ci when lockfile exists; fall back to install on the first build.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:24.22.1-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24.22.1-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs nextjs

# Standalone output bundles a minimal node_modules tree containing every
# dependency traced from the server-side imports (pg, @node-rs/argon2, etc).
# The admin bootstrap script imports the same modules, so dropping it in
# under the standalone root lets node resolve them from ./node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/healthcheck.js ./healthcheck.js

USER nextjs
EXPOSE 3000

# `docker compose up --wait` blocks on this passing — gives deploy.sh a hard
# signal that the new container actually serves traffic, not just "started".
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "healthcheck.js"]

CMD ["node", "server.js"]
