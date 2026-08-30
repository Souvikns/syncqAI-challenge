# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Meridian Dispatch — single-image build.
# Everything the system needs is in this image. There is no database server:
# the store is SQLite, which lives in a file under /app/state.
# ─────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1-debian AS deps
WORKDIR /app
# bun.lock (text, Bun >= 1.2) or bun.lockb (binary, older). Copy whichever exists.
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-debian AS runtime

# Asia/Kolkata is the operating timezone of every timestamp in the client's
# data. Pinned here so date parsing does not depend on the host's locale.
ENV TZ=Asia/Kolkata \
    NODE_ENV=production \
    DATA_ROOT=/app/data \
    STATE_DIR=/app/state \
    OUTPUT_DIR=/app/outputs \
    AUDIT_DIR=/app/audit \
    CACHE_DIR=/app/cache

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY rules ./rules

RUN mkdir -p /app/state /app/outputs /app/audit /app/cache /app/data

# Fail the build rather than the demo if FTS5 is missing from this Bun's SQLite.
RUN bun -e "import{Database}from'bun:sqlite';const d=new Database(':memory:');d.run(\"CREATE VIRTUAL TABLE t USING fts5(x)\");console.log('fts5 ok')"

ENTRYPOINT ["bun", "run", "src/cli.ts"]
CMD ["run"]
