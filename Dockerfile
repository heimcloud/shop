# Heimcloud shop — multi-stage Node image (port 3000)
FROM node:20-alpine AS deps
WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Europe/Zurich
RUN addgroup -S shop && adduser -S shop -G shop
COPY --from=deps /app/node_modules ./node_modules
COPY app/ ./
USER shop
EXPOSE 3000
CMD ["node", "server.js"]
