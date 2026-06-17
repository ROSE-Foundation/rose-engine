# Multi-stage image for the ROSE Engine shared live environment (infrastructure, NOT a BMAD story).
# ONE web service: the Fastify API (`@rose/api`) serves the `@rose/web` static build on the SAME
# origin (no CORS), behind ONE basic-auth gate (see prod/packages/api/src/serve.ts). The same image
# runs on Render (see render.yaml), Railway, or Fly.io.
#
# NO secret is baked into the image. DATABASE_URL and the basic-auth credentials are provided at
# RUNTIME via environment variables; the server refuses to start if any is absent.

# ─── Stage 1: build (web + api) ──────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app

# Corepack provisions the exact pnpm version pinned in package.json ("packageManager").
RUN corepack enable

# Install with the committed lockfile first (better layer caching), then copy sources.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json tsconfig.json turbo.json ./
COPY prod/packages ./prod/packages
RUN pnpm install --frozen-lockfile

# Build all TypeScript projects (tsc -b), then bundle the front-end. VITE_API_BASE_URL is empty so
# the SPA calls the API on the SAME origin (relative paths) — there is no separate API host.
# VITE_SUBSCRIBER_ADDRESS is the on-screen participant identity baked at build time (real session
# auth carrying the ONCHAINID claim is deferred). It defaults to the paper-demo allowlist-eligible
# address (must match PAPER_ELIGIBLE_SUBSCRIBER in prod/packages/api/src/seed-demo.ts) so the
# ENGINE_MODE=paper subscribe/redeem flows are actually eligible (not 403). Not a secret; override
# at build with `--build-arg VITE_SUBSCRIBER_ADDRESS=0x…`.
ENV VITE_API_BASE_URL=""
ARG VITE_SUBSCRIBER_ADDRESS=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ENV VITE_SUBSCRIBER_ADDRESS=$VITE_SUBSCRIBER_ADDRESS
RUN pnpm build
RUN pnpm --filter @rose/web build

# ─── Stage 2: runtime ────────────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Default; the platform (render.yaml) may override. serve.ts binds 0.0.0.0:$PORT.
ENV PORT=8080
# Default location of the web build; serve.ts also derives this relative to its own dist by default.
ENV WEB_DIST_DIR=/app/prod/packages/web/dist

# Copy the fully built workspace (node_modules + compiled dist for api and web). Copying the whole
# tree preserves pnpm's symlinked workspace layout so `node dist/serve.js` resolves @rose/* packages.
COPY --from=build /app /app

EXPOSE 8080

# Applies pending migrations on boot, then listens. Run the demo seed separately (one-off):
#   node /app/prod/packages/api/dist/seed-demo.js
CMD ["node", "/app/prod/packages/api/dist/serve.js"]
