# Build context is the repo root (pnpm workspace needs the root lockfile and
# the sibling apps/*/package.json files that pnpm-workspace.yaml globs):
#   docker build -f apps/backend/Dockerfile -t hexvault-backend .

FROM node:22-alpine AS build
# node-hid and usb (Ledger signer, admin CLI only) ship no musl prebuilds, so
# their install scripts compile from source. The server never loads them.
RUN apk add --no-cache python3 make g++ linux-headers eudev-dev libusb-dev
# node-gyp otherwise downloads the Node headers from unofficial-builds.nodejs.org
# on every build, and that fetch has timed out on the VPS. The image already
# ships them under /usr/local/include/node.
ENV npm_config_nodedir=/usr/local
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /repo

# apps/backend's own postinstall runs `prisma generate`, which needs
# prisma/schema.prisma on disk, so the full backend source has to be in
# place before `pnpm install` — no package.json-only caching trick here.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY apps/backend apps/backend
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hexvault/backend run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo/apps/backend

COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/backend /repo/apps/backend

# The node image ships an unprivileged `node` user (uid 1000). Nothing at
# runtime writes under /repo; files stay root-owned and world-readable.
USER node

EXPOSE 8080
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main.js"]
