# Two images from one build (see deploy/docker-compose.yml):
#   target "api" — Express + git + yarn + Playwright Chromium + Bob Shell: the full
#                  analysis pipeline (Bob analysis, screenshots, ablation, revise).
#   target "web" — Caddy serving the live (non-static) viewer and proxying /api.
# Bob Shell comes from deploy/vendor/bobshell-*.tgz (`npm pack` of a local install).

FROM node:24-bookworm AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g --force pnpm@11.17.0 yarn@1.22.22

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

COPY packages packages
RUN pnpm --filter @pr-walkthrough/shared build

# ---------------------------------------------------------------- web
FROM base AS web-build
RUN pnpm --filter @pr-walkthrough/web build

FROM caddy:2 AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/packages/web/dist /srv

# ---------------------------------------------------------------- api
FROM base AS api

RUN pnpm --filter @pr-walkthrough/server build \
  && cd packages/server \
  && pnpm exec playwright install --with-deps chromium chromium-headless-shell

COPY deploy/vendor/ /tmp/vendor/
RUN npm install -g /tmp/vendor/bobshell-*.tgz \
  && rm -rf /tmp/vendor \
  && bob --version

# The analyzer prompt, schema example and output contract are read at runtime.
COPY docs docs

ENV NODE_ENV=production \
    ANALYZER=bob \
    PORT=3000 \
    GIT_CACHE_DIR=/cache/repos

EXPOSE 3000
WORKDIR /app/packages/server
CMD ["node", "dist/index.js"]
