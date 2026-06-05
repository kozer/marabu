# Multi-stage Bun image for SubZero node + API
FROM docker.io/oven/bun:latest AS base
WORKDIR /usr/src/app

# ── Install dependencies ──────────────────────────────────────
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# ── Build miners (WebGPU shaders → dist/) ─────────────────────
FROM base AS build
COPY --from=install /temp/dev/node_modules node_modules
COPY . .
RUN bun run build

# ── Release ───────────────────────────────────────────────────
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/src ./src
COPY --from=build /usr/src/app/package.json .
COPY --from=build /usr/src/app/tsconfig.json .
RUN mkdir -p logs

USER bun
EXPOSE 18018/tcp 3000/tcp

# Default: run the P2P node. Override CMD in compose for API.
CMD ["bun", "run", "src/index.ts"]
