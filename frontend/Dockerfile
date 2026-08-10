# =============================================================================
# Alfanumrik product frontend (app.<domain>) — Next.js standalone.
#
# `output: 'standalone'` in next.config.ts is what makes this image small: Next
# traces the modules the server actually imports and emits a self-contained
# server.js, so the runtime stage never installs node_modules at all. Without
# it this image carries the full dependency tree — including every
# devDependency's transitive graph if anyone ever runs a plain `npm ci` here.
#
# 06-FRONTEND-SEPARATION-PLAN.md: this image and the marketing image share no
# runtime code and no build. A marketing dependency bump must not rebuild the
# product.
# =============================================================================

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are inlined at BUILD time, not read at runtime. They are
# build arguments for exactly that reason, and getting this wrong produces an
# image that points at localhost in production with no error anywhere.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_MARKETING_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_MARKETING_URL=$NEXT_PUBLIC_MARKETING_URL
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
