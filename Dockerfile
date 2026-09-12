# syntax=docker/dockerfile:1
#
# Household budget app — single image serving both the API and the built frontend.
#
#   Stage 1 (builder)  installs all dependencies (including the client's dev
#                      dependencies, which is where vite lives) and builds
#                      client/dist.
#   Stage 2 (runtime)  carries across only what the server needs at run time.
#
# The server (server/index.js) does two things that dictate the runtime layout:
#   * `require('../package.json')` for /api/version  -> root package.json must ship
#   * serves `path.join(__dirname,'..','client','dist')` when NODE_ENV=production
# so the runtime image must keep /app/package.json, /app/server and /app/client/dist.

# ---------------------------------------------------------------------------
# Stage 1: builder
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

# better-sqlite3 is a legacy dependency of the root package.json. It is not
# require()d anywhere in server/, but npm still has to install it, and it may
# compile from source if no prebuilt binary matches. These are its build deps.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# NOTE: NODE_ENV is deliberately NOT set to production here. `npm ci` would then
# skip devDependencies, and the client build needs vite + @vitejs/plugin-react.

# --- server deps (cached until the root manifests change) -------------------
COPY package.json package-lock.json ./
RUN npm ci

# --- client deps (cached until the client manifests change) -----------------
COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client

# --- source, then build the frontend ----------------------------------------
# client/vite.config.js reads ../package.json at build time, so the root
# package.json must already be in place (it is — copied above).
COPY . .
RUN npm run --prefix client build

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=4000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# The root package.json has no devDependencies at all, so the builder's
# node_modules is already exactly the production set. Copying it (rather than
# re-running `npm ci --omit=dev`) means the runtime image needs no compiler,
# and any native binary was built on this same base image, so the ABI matches.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/server ./server
COPY --from=builder --chown=node:node /app/client/dist ./client/dist

# The node:20 images ship an unprivileged `node` user (uid/gid 1000).
USER node

EXPOSE 4000

# /api/version needs no auth and touches no database, so it reports "process is
# up and serving" without failing while Postgres is still starting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
