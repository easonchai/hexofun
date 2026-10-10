# Build context is the repo root (pnpm workspace needs the root lockfile and
# the sibling apps/*/package.json files that pnpm-workspace.yaml globs):
#   docker build -f apps/backend/Dockerfile -t hexvault-backend .

# glibc, not alpine: @matrixai/quic (Beam) ships glibc prebuilds only and does
# not load on musl, even with gcompat. Its prebuilds cover linux-x64, not arm64.
FROM node:22-bookworm-slim AS build
# The toolchain is for node-hid and usb (Ledger signer, admin CLI only) when no
# prebuild matches; the server never loads them. Prisma reads openssl's version.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ libudev-dev libusb-1.0-0-dev openssl \
    && rm -rf /var/lib/apt/lists/*
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

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /repo/apps/backend

COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/backend /repo/apps/backend

# The node image ships an unprivileged `node` user (uid 1000). Nothing at
# runtime writes under /repo; files stay root-owned and world-readable.
USER node

EXPOSE 8080
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main.js"]
