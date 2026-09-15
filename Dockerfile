# Heimcloud shop — multi-stage Node image (port 3000)
# better-sqlite3 needs a native build toolchain in the deps stage.
FROM node:20-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Europe/Zurich
ENV SHOP_DB_PATH=/data/shop.sqlite
RUN addgroup -S shop && adduser -S shop -G shop \
  && mkdir -p /data && chown -R shop:shop /data
COPY --from=deps /app/node_modules ./node_modules
COPY app/ ./
USER shop
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
