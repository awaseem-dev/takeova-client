FROM node:20-alpine
WORKDIR /app

# Add non-root user early
RUN addgroup -g 1001 -S mine && adduser -u 1001 -S mine -G mine

RUN apk add --no-cache python3 make g++ sqlite
COPY package*.json ./
RUN npm ci --production

COPY . .
RUN mkdir -p data uploads && chown -R mine:mine /app

# Drop to non-root for runtime
USER mine

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:${PORT:-3001}/api/features/health || exit 1
CMD ["node", "server.js"]