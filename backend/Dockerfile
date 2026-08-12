# =============================================================================
# Foxxy backend — api and worker, from ONE image.
#
# Both processes are the same codebase with different entry points
# (04-RESILIENCE-PLAN.md §3.2), so they are the same artefact with a different
# command. Two images would be two things to build, two to scan, two to promote
# and two that can drift — and a worker running different code from the api is
# a class of bug that is invisible until a job writes a row the api cannot read.
#
# THREE STAGES, and each one exists for a reason:
#
#   deps     npm ci with dev dependencies. TypeScript, tsc-alias, drizzle-kit.
#   build    tsc -> dist, then tsc-alias to rewrite "@/..." into relative paths
#            with .js extensions (D-008 — extensionless source, real ESM output).
#   runtime  npm ci --omit=dev into a fresh layer, plus dist. No compiler, no
#            test framework, no source.
#
# bookworm-slim rather than alpine ON PURPOSE. `@node-rs/argon2` is a native
# module; the glibc prebuild is the one that is exercised in development and in
# CI, and a musl build path that only production takes is a path nobody has
# tested. Password hashing is not where to discover that.
# =============================================================================

# --- deps --------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json tsconfig.ops.json ./
COPY src ./src
COPY scripts ./scripts
# Two outputs, deliberately:
#   dist/      the api and the worker (rootDir src)
#   dist-ops/  the operational entry points — migrations and the alert
#              evaluator — which live in scripts/ and are therefore outside
#              dist's rootDir. They are COMPILED rather than run through tsx
#              because tsx is a dev dependency: an ops tool that needs the dev
#              toolchain is an ops tool you cannot run on the box that is on
#              fire.
RUN npm run build && npm run build:ops

# --- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only, installed fresh rather than pruned: `npm ci`
# into an empty tree cannot leave a dev dependency behind the way `npm prune`
# can when a transitive dependency is reachable from both graphs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-ops ./dist-ops

# The migration SQL travels WITH the image, because the migration step
# (CI/CD, an explicit job — never on boot) must run the exact SQL that matches
# the exact code being deployed. A migration applied from a developer's
# checkout is a migration applied from an unknown commit.
COPY drizzle ./drizzle

# `node` (uid 1000) already exists in the base image. Never root: a process that
# can write its own code is a process an RCE can persist in.
USER node

EXPOSE 4000

# §8 — liveness touches NOTHING external. Docker restarts on this, so making it
# check the database would turn a 10-second database blip into a simultaneous
# restart of every replica.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Overridden to `npm run worker` by the worker service in compose.prod.yml.
CMD ["node", "dist/main.js"]
