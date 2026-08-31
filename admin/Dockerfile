# =============================================================================
# Alfanumrik operations panel (admin) — Next.js standalone.
#
# A THIRD IMAGE, sharing no build with the product or the marketing site. The
# same reasoning as `frontend/Dockerfile`: a marketing dependency bump must not
# rebuild the product, and an admin dependency bump must not rebuild either.
#
# THIS IMAGE IS NOT MEANT TO BE PUBLICLY ROUTED. It is built so the panel can be
# run the same way everywhere; where it is exposed is a deployment decision that
# has not been taken yet (D-402).
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
# Inlined at BUILD time, not read at runtime — getting this wrong produces an
# image that points at localhost with no error anywhere.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3002
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3002
CMD ["node", "server.js"]
