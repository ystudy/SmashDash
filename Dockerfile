FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Build tools for better-sqlite3 native fallback (prebuilt binaries used when available)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0

VOLUME /data
EXPOSE 3000

CMD ["node", "src/server.js"]
