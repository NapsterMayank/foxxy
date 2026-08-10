# =============================================================================
# Alfanumrik marketing website (<domain>) — Next.js standalone.
#
# 06-FRONTEND-SEPARATION-PLAN.md: "The public site performs no request-time CMS
# or CMS-database reads. CMS DOWN MUST NOT MEAN MARKETING DOWN." The published
# pages are baked into this image at build time; nothing in the runtime stage
# can reach a CMS even if someone later adds a fetch, because the container has
# no CMS credentials.
#
# Its resource limits in compose.prod.yml are deliberately the smallest of any
# service: a marketing container that can exhaust the host is a marketing
# container that can take the product down, which is the exact failure the
# separation plan exists to prevent.
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
# `public/` is optional in a Next project and the marketing site does not have
# one yet. Created here so the runtime COPY below is not a build failure that
# arrives the first time somebody deletes a favicon.
RUN mkdir -p public
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_MARKETING_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
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
